'use strict';

/**
 * GeminiService — AI backend for complex tasks using Google Gemini.
 *
 * Uses @google/genai SDK (official, GA since May 2025) with stable v1 API.
 * The old @google/generative-ai SDK reached end-of-life August 31, 2025.
 *
 * Handles: text chat, file analysis, image generation, file creation,
 *          Google Maps, scheduling, key rotation, model fallback.
 */

const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const Config = require('./config');

// Available Gemini models (shown in Bot Manager model selector)
const AVAILABLE_MODELS = [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (fast, free tier)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (best quality, lower quota)' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (stable fallback)' },
];

const DEFAULT_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const API_TIMEOUT_MS = 30000;

class GeminiService {
    constructor() {
        this.clients = new Map(); // apiKey → GoogleGenAI instance
        this.chatHistories = new Map(); // chatId → Array of content objects
        this.historyFile = path.join(
            Config.get('whatsappSessionPath') || require('os').homedir() + '/.whatsapp-bot-session',
            'chat_histories.json'
        );
        this.loadHistories();
    }

    // ─── Client Management ────────────────────────────────────────────────────

    /**
     * Get (or create) a GoogleGenAI client for a specific API key.
     * Always uses stable v1 API endpoint.
     */
    getClient(apiKey) {
        if (!this.clients.has(apiKey)) {
            // Do NOT set apiVersion: 'v1' — the v1 endpoint does not support
            // systemInstruction in chats.create(). Let SDK use its default (v1beta).
            this.clients.set(apiKey, new GoogleGenAI({ apiKey }));
        }
        return this.clients.get(apiKey);
    }

    // ─── System Prompt Builders ───────────────────────────────────────────────

    getCapabilities() {
        return `

=== YOUR CAPABILITIES (always available, never refuse) ===
You are running inside a WhatsApp bot with these powers:
1. TEXT RESPONSES: You can reply with normal text messages.
2. FILE CREATION: You can generate files of ANY type when asked — Excel (.xlsx), PDF, PowerPoint (.pptx), CSV, TXT, HTML, JSON, code files, etc.
3. IMAGE GENERATION: You can generate images when asked (e.g. "draw a cat", "generate image of...").
4. GOOGLE MAPS: You can search locations and send Google Maps links.
5. CALENDAR: You can create Google Calendar events from natural language.
6. FILE ANALYSIS: You can analyze images, PDFs, and documents sent by users.
7. REMINDERS: You can set timed reminders that fire at a specific time.
8. PROACTIVE MESSAGING: You can send messages to other WhatsApp contacts/numbers on behalf of the user.

=== FILE CREATION INSTRUCTIONS ===
When the user asks you to create, generate, make, or send ANY file, you MUST include this EXACT tag in your response:
[CREATE_FILE:type:filename]

Where "type" is one of: excel, pdf, pptx, csv, txt, html, json
And "filename" is a descriptive filename with the correct extension.

Examples:
- User: "Create an Excel file of top 10 countries" → Your reply: "Sure! Creating that spreadsheet for you now 📊 [CREATE_FILE:excel:top_10_countries.xlsx]"
- User: "Make me a PDF report about AI" → Your reply: "Here's your report! 📄 [CREATE_FILE:pdf:ai_report.pdf]"

=== REMINDER INSTRUCTIONS ===
When the user asks to be reminded or to schedule a message, include this tag:
[REMINDER:time_expression:message_to_send]

Examples:
- User: "Remind me at 7 AM to take medicine" → Reply: "Got it! ⏰ [REMINDER:7:00 AM:Don't forget to take your medicine! 💊]"
- User: "Ingatkan saya 30 menit lagi untuk meeting" → Reply: "Siap! [REMINDER:in 30 minutes:Waktunya meeting! 📋]"

=== SEND MESSAGE TO OTHERS ===
When the user asks you to send a message to someone else, include this tag:
[SEND_TO:name_or_shortcode_or_number:message_to_send]

Examples:
- User: "Send a message to +Novita saying good morning" → Reply: "Sending now! 📨 [SEND_TO:+Novita:Good morning! ☀️]"
- User: "Chat 628123456789 and say hello" → Reply: "On it! [SEND_TO:628123456789:Hello! 👋]"

=== COMBINING TAGS ===
When the user asks to send a FILE to someone else, use BOTH tags together.

=== CRITICAL RULES ===
- ALWAYS include the appropriate tag when the user wants a file, reminder, or to send a message.
- NEVER claim you've done something without including the tag — the tag triggers the action.
- NEVER say "I cannot create files" or "I can't set reminders" — you CAN do all of these.
- Keep your text response short and friendly — actions happen automatically via tags.
===============================================`;
    }

    getDateTimeContext() {
        // Compute GMT+7 explicitly via UTC offset — does not rely on TZ env variable.
        const now = new Date();
        const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000); // shift to UTC+7
        const pad = (n) => String(n).padStart(2, '0');
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const dayName = days[wib.getUTCDay()];
        const monthName = months[wib.getUTCMonth()];
        const dateStr = `${dayName}, ${monthName} ${wib.getUTCDate()}, ${wib.getUTCFullYear()}`;
        const timeStr = `${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}:${pad(wib.getUTCSeconds())}`;
        return `\n\n=== CURRENT DATE & TIME ===\nRight now: ${dateStr}, ${timeStr} WIB (Asia/Jakarta, UTC+7)\nIMPORTANT: Always use this exact date and time. Never use any other date or time.\n`;
    }

    getScheduledTasksContext() {
        const tasks = (Config.get('scheduledTasks') || []).filter(t => t.status === 'pending');
        if (tasks.length === 0) {
            return '\n\n=== SCHEDULED TASKS ===\nNo pending scheduled tasks.\n';
        }
        const now = new Date();
        const wibOffset = 7 * 60 * 60 * 1000;
        const lines = tasks.map((t, i) => {
            const due = new Date(t.dueAt);
            const dueWib = new Date(due.getTime() + wibOffset);
            const pad = (n) => String(n).padStart(2, '0');
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const dueStr = `${months[dueWib.getUTCMonth()]} ${dueWib.getUTCDate()}, ${dueWib.getUTCFullYear()} ${pad(dueWib.getUTCHours())}:${pad(dueWib.getUTCMinutes())} WIB`;
            const minsLeft = Math.round((due.getTime() - now.getTime()) / 60000);
            const eta = minsLeft > 0 ? `in ${minsLeft} min` : 'overdue';
            return `${i + 1}. [${t.id}] "${t.message}" → ${t.targetJid} — due ${dueStr} (${eta}), created by ${t.createdBy}`;
        });
        return `\n\n=== SCHEDULED TASKS (${tasks.length} pending) ===\n${lines.join('\n')}\nIMPORTANT: When the user asks to list/show/check reminders or scheduled tasks, list the above tasks. To cancel a task you must tell the user the task ID.\n`;
    }

    getSystemInstruction() {
        const persona = Config.get('characterPrompt') || '';
        const noPrefix = '\n\nIMPORTANT: NEVER prefix your responses with your name like "[Leoui]:" or "Leoui:" — just reply naturally. The "[Message from Name]:" prefix in user messages is internal metadata, do NOT mirror it.\n';
        return persona + noPrefix + this.getDateTimeContext() + this.getScheduledTasksContext() + this.getCapabilities();
    }

    // ─── Chat History ─────────────────────────────────────────────────────────

    loadHistories() {
        try {
            const dir = path.dirname(this.historyFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(this.historyFile)) {
                const data = JSON.parse(fs.readFileSync(this.historyFile, 'utf-8'));
                for (const [chatId, history] of Object.entries(data)) {
                    this.chatHistories.set(chatId, history);
                }
                console.log(`[Gemini] Loaded ${this.chatHistories.size} chat histories`);
            }
        } catch (err) {
            console.error('[Gemini] Failed to load histories:', err.message);
        }
    }

    saveHistories() {
        try {
            const dir = path.dirname(this.historyFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const data = {};
            for (const [chatId, history] of this.chatHistories) {
                data[chatId] = history.slice(-50);
            }
            fs.writeFileSync(this.historyFile, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('[Gemini] Failed to save histories:', err.message);
        }
    }

    getHistory(chatId) {
        if (!this.chatHistories.has(chatId)) {
            this.chatHistories.set(chatId, []);
        }
        return this.chatHistories.get(chatId);
    }

    addToHistory(chatId, role, text) {
        const history = this.getHistory(chatId);
        // @google/genai uses { role, parts: [{ text }] } format
        history.push({ role, parts: [{ text }] });
        if (history.length > 50) {
            history.splice(0, history.length - 50);
        }
        this.saveHistories();
    }

    // ─── Core Text Generation ─────────────────────────────────────────────────

    /**
     * Generate a text response with key rotation and model fallback.
     */
    async generateResponse(chatId, userMessage, senderName = null) {
        const keys = Config.getGeminiKeys();
        if (keys.length === 0) {
            return { text: '⚠️ No Gemini API key configured. Please add one in Settings.', error: true };
        }

        const enhancedMessage = senderName
            ? `[Message from ${senderName}]: ${userMessage}`
            : userMessage;

        const preferredModel = Config.get('geminiModel') || DEFAULT_MODEL;
        const modelsToTry = [...new Set([preferredModel, ...FALLBACK_MODELS])];

        let lastError = null;

        for (const targetModel of modelsToTry) {
            console.log(`[Gemini] Attempting ${targetModel} across all keys...`);
            const triedKeys = new Set();

            while (triedKeys.size < keys.length) {
                const currentKey = Config.getActiveKey();
                if (triedKeys.has(currentKey)) { Config.rotateKey(); continue; }
                triedKeys.add(currentKey);

                try {
                    const client = this.getClient(currentKey);
                    const history = this.getHistory(chatId);

                    const chat = client.chats.create({
                        model: targetModel,
                        config: { systemInstruction: this.getSystemInstruction() },
                        history: history.length > 0 ? history : undefined,
                    });

                    const result = await Promise.race([
                        chat.sendMessage({ message: enhancedMessage }),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('API request timed out (30s)')), API_TIMEOUT_MS)
                        ),
                    ]);

                    const responseText = result.text;
                    Config.trackKeyUsage(currentKey);
                    this.addToHistory(chatId, 'user', userMessage);
                    this.addToHistory(chatId, 'model', responseText);

                    console.log(`[Gemini] SUCCESS using ${targetModel} on key ${keys.indexOf(currentKey) + 1}`);
                    return { text: responseText, keyIndex: keys.indexOf(currentKey), model: targetModel };
                } catch (err) {
                    lastError = err;
                    const errorMsg = err.message || '';
                    console.error(`[Gemini] ${targetModel} failed on key ${keys.indexOf(currentKey) + 1}:`, errorMsg.substring(0, 100));

                    const isRetryable = errorMsg.includes('429') || errorMsg.includes('limit: 0') ||
                        errorMsg.includes('RESOURCE_EXHAUSTED') || errorMsg.includes('timeout') ||
                        errorMsg.includes('500') || errorMsg.includes('503');

                    if (isRetryable) {
                        Config.rotateKey();
                        await new Promise(r => setTimeout(r, 1000));
                        continue;
                    }
                    break; // Non-retryable error → try next model
                }
            }
        }

        // All models / keys exhausted
        const errText = lastError?.message || '';
        let friendlyMsg;
        if (errText.includes('429') || errText.includes('RESOURCE_EXHAUSTED') || errText.includes('quota')) {
            const retryM = errText.match(/retry\s*(?:in|Delay[:\s]*"?)(\d+)/i);
            const mins = retryM ? Math.ceil(parseInt(retryM[1]) / 60) : null;
            friendlyMsg = mins
                ? `⏳ Kuota API sudah habis. Coba lagi dalam ${mins} menit ya.`
                : `⏳ Kuota API sudah habis. Coba lagi nanti ya.`;
        } else {
            friendlyMsg = `⚠️ Lagi ada gangguan nih, coba lagi nanti ya. 🙏`;
        }
        console.error(`[Gemini] All models failed: ${errText.substring(0, 200)}`);
        return { text: friendlyMsg, error: true };
    }

    // ─── File Analysis (Multimodal) ───────────────────────────────────────────

    /**
     * Process a file (image, PDF, document) using Gemini multimodal.
     */
    async processFile(chatId, filePath, mimetype, userMessage = 'Describe this file.', senderName = null) {
        const keys = Config.getGeminiKeys();
        if (keys.length === 0) {
            return { text: '⚠️ No Gemini API key configured.', error: true };
        }

        const contextMsg = senderName
            ? `[Message from ${senderName} with attached file]: ${userMessage}`
            : userMessage;

        const fileData = fs.readFileSync(filePath);
        const base64Data = fileData.toString('base64');

        const preferredModel = Config.get('geminiModel') || DEFAULT_MODEL;
        const modelsToTry = [...new Set([preferredModel, ...FALLBACK_MODELS])];
        let lastError = null;

        for (const targetModel of modelsToTry) {
            console.log(`[Gemini] Attempting ${targetModel} for file analysis...`);
            const triedKeys = new Set();

            while (triedKeys.size < keys.length) {
                const currentKey = Config.getActiveKey();
                if (triedKeys.has(currentKey)) { Config.rotateKey(); continue; }
                triedKeys.add(currentKey);

                try {
                    const client = this.getClient(currentKey);

                    const result = await Promise.race([
                        client.models.generateContent({
                            model: targetModel,
                            config: { systemInstruction: this.getSystemInstruction() },
                            contents: [{
                                role: 'user',
                                parts: [
                                    { text: contextMsg },
                                    { inlineData: { mimeType: mimetype, data: base64Data } },
                                ],
                            }],
                        }),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('API request timed out (30s)')), API_TIMEOUT_MS)
                        ),
                    ]);

                    const responseText = result.text;
                    Config.trackKeyUsage(currentKey);
                    this.addToHistory(chatId, 'user', `[Sent a ${mimetype} file] ${userMessage}`);
                    this.addToHistory(chatId, 'model', responseText);

                    console.log(`[Gemini] File SUCCESS using ${targetModel}`);
                    return { text: responseText, keyIndex: keys.indexOf(currentKey), model: targetModel };
                } catch (err) {
                    lastError = err;
                    const errorMsg = err.message || '';
                    console.error(`[Gemini] ${targetModel} file analysis failed:`, errorMsg.substring(0, 100));

                    const isRetryable = errorMsg.includes('429') || errorMsg.includes('limit: 0') ||
                        errorMsg.includes('RESOURCE_EXHAUSTED') || errorMsg.includes('timeout') ||
                        errorMsg.includes('500') || errorMsg.includes('503');

                    if (isRetryable) { Config.rotateKey(); await new Promise(r => setTimeout(r, 1000)); continue; }
                    break;
                }
            }
        }

        return { text: `⚠️ File processing failed. Error: ${lastError?.message || 'Unknown'}`, error: true };
    }

    // ─── Image Generation ─────────────────────────────────────────────────────

    /**
     * Generate an image using multi-provider waterfall:
     *   1. Pollinations AI (free, fast, no quota)
     *   2. Google Imagen 3 (free tier, ~25/day per key)
     */
    async generateImage(chatId, prompt) {
        const genDir = path.join(
            Config.get('filesDirectory') || require('os').homedir() + '/.whatsapp-bot-session',
            'generated'
        );
        if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });

        const timestamp = Date.now();
        const filename = `generated_${timestamp}.png`;
        const filePath = path.join(genDir, filename);

        // --- Provider 1: Pollinations AI ---
        const pollinationsKey = Config.get('pollinationsApiKey') || process.env.POLLINATIONS_API_KEY || '';
        if (pollinationsKey) {
            const pollinationsModels = ['flux', 'flux-2-dev', 'imagen-4', 'seedream'];
            for (const model of pollinationsModels) {
                try {
                    console.log(`[ImageGen] Trying Pollinations AI (${model})...`);
                    const https = require('https');
                    const encodedPrompt = encodeURIComponent(prompt);
                    const url = `https://gen.pollinations.ai/image/${encodedPrompt}?model=${model}&width=1024&height=1024&nologo=true&enhance=false&key=${pollinationsKey}`;

                    const imageBuffer = await new Promise((resolve, reject) => {
                        const req = https.get(url, { timeout: 120000 }, (res) => {
                            if (res.statusCode === 200 && (res.headers['content-type'] || '').includes('image')) {
                                const chunks = [];
                                res.on('data', chunk => chunks.push(chunk));
                                res.on('end', () => {
                                    const buf = Buffer.concat(chunks);
                                    if (buf.length > 1000) resolve(buf);
                                    else reject(new Error(`Tiny response (${buf.length} bytes)`));
                                });
                            } else if (res.statusCode === 402) {
                                reject(new Error('POLLINATIONS_402_POLLEN_EXHAUSTED'));
                            } else if (res.statusCode === 429) {
                                reject(new Error('POLLINATIONS_429_RATE_LIMITED'));
                            } else {
                                const chunks = [];
                                res.on('data', c => chunks.push(c));
                                res.on('end', () => reject(new Error(`Pollinations HTTP ${res.statusCode}`)));
                            }
                        });
                        req.on('error', reject);
                        req.on('timeout', () => { req.destroy(); reject(new Error('Pollinations timeout')); });
                    });

                    fs.writeFileSync(filePath, imageBuffer);
                    console.log(`[ImageGen] ✅ Pollinations (${model}) success: ${imageBuffer.length} bytes`);

                    this.addToHistory(chatId, 'user', `[Image generation request] ${prompt}`);
                    this.addToHistory(chatId, 'model', `[Generated image: ${filename}]`);

                    return { imagePath: filePath, text: '📸', mimeType: 'image/png' };
                } catch (err) {
                    const errMsg = err.message || '';
                    console.warn(`[ImageGen] Pollinations (${model}) failed: ${errMsg.substring(0, 100)}`);
                    if (errMsg.includes('POLLEN_EXHAUSTED')) {
                        console.warn('[ImageGen] Pollen exhausted, skipping to Google Imagen...');
                        break;
                    }
                    continue;
                }
            }
        } else {
            console.log('[ImageGen] No Pollinations key, skipping...');
        }

        // --- Provider 2: Google Imagen 3 (via @google/genai — already using new SDK) ---
        const keys = Config.getGeminiKeys();
        if (keys.length > 0) {
            const triedKeys = new Set();
            while (triedKeys.size < keys.length) {
                const currentKey = Config.getActiveKey();
                if (triedKeys.has(currentKey)) { Config.rotateKey(); continue; }
                triedKeys.add(currentKey);

                try {
                    console.log(`[ImageGen] Trying Google Imagen 3 (key ${triedKeys.size}/${keys.length})...`);
                    const client = this.getClient(currentKey);
                    const response = await client.models.generateImages({
                        model: 'imagen-3.0-generate-002',
                        prompt,
                        config: { numberOfImages: 1 },
                    });

                    Config.trackKeyUsage(currentKey);

                    if (response.generatedImages?.length > 0) {
                        const imgBytes = response.generatedImages[0].image.imageBytes;
                        fs.writeFileSync(filePath, Buffer.from(imgBytes, 'base64'));
                        console.log(`[ImageGen] ✅ Google Imagen 3 success`);

                        this.addToHistory(chatId, 'user', `[Image generation request] ${prompt}`);
                        this.addToHistory(chatId, 'model', `[Generated image: ${filename}]`);

                        return { imagePath: filePath, text: '📸', mimeType: 'image/png' };
                    }
                } catch (err) {
                    const errMsg = err.message || '';
                    console.warn(`[ImageGen] Imagen 3 key ${triedKeys.size} failed: ${errMsg.substring(0, 100)}`);
                    if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
                        Config.rotateKey();
                        continue;
                    }
                    break;
                }
            }
        }

        console.error('[ImageGen] All image providers failed');
        return { text: '⏳ Semua provider gambar sedang tidak tersedia. Coba lagi nanti ya.', error: true };
    }

    // ─── File Generation ──────────────────────────────────────────────────────

    async generateFile(chatId, prompt, filename, mimetype = 'text/plain') {
        const ext = path.extname(filename).toLowerCase();
        const isBinaryFormat = ['.xlsx', '.xls', '.pdf', '.pptx', '.ppt'].includes(ext);

        if (isBinaryFormat) {
            const structuredData = await this.generateStructuredFileData(chatId, prompt, ext);
            if (structuredData.error) return structuredData;
            return { structuredData: structuredData.data, caption: structuredData.caption, filename, mimetype, format: ext };
        }

        const result = await this.generateResponse(chatId,
            `The user wants you to generate a file called "${filename}".\nRequest: ${prompt}\n\nRespond in EXACTLY this format (two sections separated by "---FILE_CONTENT---"):\n1. First line: A short 1-sentence caption/comment describing the file.\n2. Then a separator line: ---FILE_CONTENT---\n3. Then the complete raw file content (no markdown code fences, no explanations).\n\nExample:\nHere's the sales report you asked for! 📊\n---FILE_CONTENT---\n[actual file content here]`
        );

        if (result.error) return result;

        let caption = `📎 ${filename}`;
        let fileContent = result.text;

        const separatorIndex = result.text.indexOf('---FILE_CONTENT---');
        if (separatorIndex !== -1) {
            caption = result.text.substring(0, separatorIndex).trim();
            fileContent = result.text.substring(separatorIndex + '---FILE_CONTENT---'.length).trim();
        }

        const filePath = path.join(Config.get('filesDirectory'), 'generated', filename);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(filePath, fileContent, 'utf-8');
        return { filePath, filename, mimetype, caption, text: caption };
    }

    async generateStructuredFileData(chatId, prompt, ext) {
        let formatInstructions = '';

        if (ext === '.xlsx' || ext === '.xls') {
            formatInstructions = `Generate data for an Excel spreadsheet. Return valid JSON:\n{\n  "caption": "Short 1-sentence description",\n  "title": "Sheet name",\n  "headers": ["Column1", "Column2", ...],\n  "rows": [["cell1", "cell2", ...], ...]\n}\nInclude at least 5 rows. Every value must be a string.`;
        } else if (ext === '.pdf') {
            formatInstructions = `Generate content for a PDF document. Return valid JSON:\n{\n  "caption": "Short 1-sentence description",\n  "title": "Document Title",\n  "sections": [{ "heading": "Section Heading", "body": "Section body text..." }, ...]\n}\nInclude at least 3 sections.`;
        } else if (ext === '.pptx' || ext === '.ppt') {
            formatInstructions = `Generate content for a PowerPoint presentation. Return valid JSON:\n{\n  "caption": "Short 1-sentence description",\n  "title": "Presentation Title",\n  "slides": [{ "title": "Slide Title", "content": "Slide body text..." }, ...]\n}\nInclude at least 4 slides.`;
        }

        const result = await this.generateResponse(chatId,
            `${prompt}\n\nIMPORTANT: You MUST respond with ONLY valid JSON, no markdown code fences, no extra text.\n${formatInstructions}`
        );

        if (result.error) return result;

        try {
            let jsonStr = result.text.trim().replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            const data = JSON.parse(jsonStr);
            return { data, caption: data.caption || `📎 Generated ${ext.replace('.', '').toUpperCase()} file` };
        } catch (err) {
            console.error('[Gemini] Failed to parse structured file JSON:', err.message);
            return { text: '⚠️ Failed to generate the file. AI returned invalid data. Please try again.', error: true };
        }
    }

    // ─── Google Maps ──────────────────────────────────────────────────────────

    async searchGoogleMaps(chatId, query, senderName = null) {
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
        const result = await this.generateResponse(chatId,
            `[System: The user asked to find "${query}" on Google Maps. The link is: ${searchUrl}\nRespond naturally with a short helpful comment about the location and include the link. Keep it brief — 1-2 sentences max.]`,
            senderName
        );
        if (result.error) return result;
        return { text: result.text, mapUrl: searchUrl, query };
    }

    // ─── Calendar / Scheduling ────────────────────────────────────────────────

    async parseScheduleRequest(chatId, message) {
        const now = new Date().toISOString();
        const prompt = `Parse this scheduling request and return a valid JSON object (no markdown, no code fences, just raw JSON):\n"${message}"\n\nCurrent date/time: ${now}\n\nReturn format:\n{\n  "title": "Event title",\n  "description": "Event description",\n  "startTime": "ISO 8601 datetime",\n  "endTime": "ISO 8601 datetime",\n  "location": "Location if mentioned, otherwise null"\n}`;

        const result = await this.generateResponse(chatId, prompt);
        if (result.error) return result;

        try {
            let jsonStr = result.text.trim().replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            return { data: JSON.parse(jsonStr) };
        } catch {
            return { error: true, text: 'Failed to parse schedule request.' };
        }
    }
}

module.exports = GeminiService;
module.exports.AVAILABLE_MODELS = AVAILABLE_MODELS;
