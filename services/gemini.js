const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const Config = require('./config');

class GeminiService {
    constructor() {
        this.clients = new Map(); // key -> GoogleGenerativeAI instance
        this.chatHistories = new Map(); // chatId -> Array of messages
        this.historyFile = path.join(Config.get('whatsappSessionPath'), 'chat_histories.json');
        this.loadHistories();
    }

    /**
     * Initialize/get a Gemini client for a specific API key
     */
    getClient(apiKey) {
        if (!this.clients.has(apiKey)) {
            // Force stable v1 API version
            this.clients.set(apiKey, new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' }));
        }
        return this.clients.get(apiKey);
    }

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
- User: "list all countries in excel" → Your reply: "Sure! Here you go 📊 [CREATE_FILE:excel:countries_list.xlsx]"

=== REMINDER INSTRUCTIONS ===
When the user asks to be reminded or to schedule a message, include this tag:
[REMINDER:time_expression:message_to_send]

Where "time_expression" is a natural time like "7:00 AM", "in 30 minutes", "tomorrow 9 AM", "14:30"
And "message_to_send" is the reminder message.

IMPORTANT: If the user asks for a reminder that includes a location, maps link, or other content, include ALL of that content INSIDE the reminder message.

Examples:
- User: "Remind me at 7 AM to take medicine" → Reply: "Got it! I'll remind you at 7:00 AM ⏰ [REMINDER:7:00 AM:Don't forget to take your medicine! 💊]"
- User: "Ingatkan saya 30 menit lagi untuk meeting" → Reply: "Siap! Saya akan ingatkan 30 menit lagi 👍 [REMINDER:in 30 minutes:Waktunya meeting! Jangan lupa ya 📋]"
- User: "Remind me at 6 AM and send Google Maps for Eldorado Waterpark Bogor" → Reply: "Done! I'll remind you at 6 AM with the location 📍 [REMINDER:6:00 AM:Good morning! Here's the location for Eldorado Waterpark Legenda Wisata Bogor: https://www.google.com/maps/search/Eldorado+Waterpark+Legenda+Wisata+Bogor 📍]"

=== SEND MESSAGE TO OTHERS ===
When the user asks you to send a message to someone else, include this tag:
[SEND_TO:name_or_shortcode_or_number:message_to_send]

You can use a shortcode (like +Novita), a contact name (like "Novita Wulandari"), or a phone number. The system resolves in order: saved shortcodes → saved names → phone number → live contacts.

Examples:
- User: "Send a message to +Novita saying good morning" → Reply: "Sending now! 📨 [SEND_TO:+Novita:Good morning! ☀️]"
- User: "Tell Novita Wulandari I'll be late" → Reply: "Done! [SEND_TO:Novita Wulandari:Hi, I'll be running a bit late 🕐]"
- User: "Chat 628123456789 and say hello" → Reply: "On it! [SEND_TO:628123456789:Hello! 👋]"
- User: "Bilang ke +Budi kalau meeting jam 3" → Reply: "Siap! [SEND_TO:+Budi:Halo Budi, meetingnya jam 3 ya 📋]"

If the user uses a +shortcode, use it exactly as given. If they give a name, use the full name. If they give a number, use the number.

=== COMBINING TAGS ===
When the user asks to send a FILE to someone else, use BOTH tags together:
- User: "Send +Novita a PDF about AI trends" → Reply: "Creating and sending the file to Novita! 📄 [SEND_TO:+Novita:Here's a PDF about AI trends] [CREATE_FILE:pdf:ai_trends.pdf]"
- User: "Kirim excel data karyawan ke +Budi" → Reply: "Siap, mengirim file ke Budi! 📊 [SEND_TO:+Budi:Ini data karyawannya] [CREATE_FILE:excel:data_karyawan.xlsx]"

=== CRITICAL RULES ===
- ALWAYS include the appropriate tag when the user wants a file, reminder, or to send a message.
- When sending a file TO SOMEONE ELSE, always include BOTH [SEND_TO:...] AND [CREATE_FILE:...] tags.
- NEVER claim you've done something without including the tag — the tag triggers the action.
- NEVER say "I cannot create files" or "I can't set reminders" — you CAN do all of these.
- Keep your text response short and friendly — actions happen automatically via tags.
===============================================`;
    }

    /**
     * Get current datetime context string for system prompt
     */
    getDateTimeContext() {
        const now = new Date();
        const wibOptions = { 
            timeZone: 'Asia/Jakarta', 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        };
        const wibStr = now.toLocaleString('id-ID', wibOptions);
        return `\n\n=== CURRENT DATE & TIME ===\nRight now: ${wibStr} WIB (Asia/Jakarta, UTC+7)\nIMPORTANT: Always use this as the current date and time. Never use any other date.\n`;
    }

    /**
     * Get the current active model with key rotation.
     */
    getModel(apiKey = null) {
        const key = apiKey || Config.getActiveKey();
        if (!key) throw new Error('No Gemini API key configured');

        const client = this.getClient(key);
        const modelName = Config.get('geminiModel') || 'gemini-2.5-flash';

        const persona = Config.get('characterPrompt') || '';
        const capabilities = this.getCapabilities();
        const dateTime = this.getDateTimeContext();

        return client.getGenerativeModel({
            model: modelName,
            systemInstruction: persona + dateTime + capabilities,
        });
    }

    /**
     * Load chat histories from disk
     */
    loadHistories() {
        try {
            const dir = path.dirname(this.historyFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
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

    /**
     * Save chat histories to disk
     */
    saveHistories() {
        try {
            const dir = path.dirname(this.historyFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const data = {};
            for (const [chatId, history] of this.chatHistories) {
                // Keep last 50 messages per chat to prevent bloat
                data[chatId] = history.slice(-50);
            }
            fs.writeFileSync(this.historyFile, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('[Gemini] Failed to save histories:', err.message);
        }
    }

    /**
     * Get chat history for a specific chat
     */
    getHistory(chatId) {
        if (!this.chatHistories.has(chatId)) {
            this.chatHistories.set(chatId, []);
        }
        return this.chatHistories.get(chatId);
    }

    /**
     * Add a message to chat history
     */
    addToHistory(chatId, role, text) {
        const history = this.getHistory(chatId);
        history.push({
            role: role, // 'user' or 'model'
            parts: [{ text }],
        });
        // Keep last 50 messages
        if (history.length > 50) {
            history.splice(0, history.length - 50);
        }
        this.saveHistories();
    }

    /**
     * Generate a text response with retry + key rotation + timeout + model fallback
     */
    async generateResponse(chatId, userMessage, senderName = null) {
        const keys = Config.getGeminiKeys();
        if (keys.length === 0) {
            return { text: '⚠️ No Gemini API key configured. Please add one in Settings.', error: true };
        }

        // Add context about the sender
        let enhancedMessage = userMessage;
        if (senderName) {
            enhancedMessage = `[Message from ${senderName}]: ${userMessage}`;
        }

        let lastError = null;
        const triedKeys = new Set();
        const API_TIMEOUT_MS = 30000;

        // Model hierarchy for fallback
        const preferredModel = Config.get('geminiModel') || 'gemini-2.5-flash';
        const fallbackModels = ['gemini-2.5-flash', 'gemini-2.0-flash'];

        // Remove preferred from list and put it at the start
        const modelsToTry = [preferredModel, ...fallbackModels.filter(m => m !== preferredModel)];
        // Remove duplicates
        const uniqueModels = [...new Set(modelsToTry)];

        for (const targetModel of uniqueModels) {
            console.log(`[Gemini] Attempting ${targetModel} across all keys...`);
            triedKeys.clear();

            while (triedKeys.size < keys.length) {
                const currentKey = Config.getActiveKey();
                if (triedKeys.has(currentKey)) {
                    Config.rotateKey();
                    continue;
                }
                triedKeys.add(currentKey);

                try {
                    // Force v1 endpoint for stable models
                    const client = new GoogleGenerativeAI(currentKey, { apiVersion: 'v1' });
                    const model = client.getGenerativeModel({
                        model: targetModel,
                        systemInstruction: (Config.get('characterPrompt') || '') + this.getDateTimeContext() + this.getCapabilities()
                    });

                    const history = this.getHistory(chatId);
                    const chat = model.startChat({
                        history: history.length > 0 ? history : undefined
                    });

                    const result = await Promise.race([
                        chat.sendMessage(enhancedMessage),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('API request timed out (30s)')), API_TIMEOUT_MS)
                        ),
                    ]);

                    const responseText = result.response.text();
                    Config.trackKeyUsage(currentKey);
                    this.addToHistory(chatId, 'user', userMessage);
                    this.addToHistory(chatId, 'model', responseText);

                    console.log(`[Gemini] SUCCESS using ${targetModel} on key ${keys.indexOf(currentKey) + 1}`);
                    return { text: responseText, keyIndex: keys.indexOf(currentKey), model: targetModel };
                } catch (err) {
                    lastError = err;
                    const errorMsg = err.message || '';
                    console.error(`[Gemini] ${targetModel} failed on key ${keys.indexOf(currentKey) + 1}:`, errorMsg.substring(0, 100));

                    const isQuotaError = errorMsg.includes('429') || errorMsg.includes('limit: 0') || errorMsg.includes('RESOURCE_EXHAUSTED');

                    if (isQuotaError || errorMsg.includes('timeout') || errorMsg.includes('500') || errorMsg.includes('503')) {
                        Config.rotateKey();
                        await new Promise(r => setTimeout(r, 1000));
                        continue;
                    }
                    // For other errors (like model not found), break key loop and try next model
                    break;
                }
            }
        }

        {
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
    }

    /**
     * Process a file (image, document) with Gemini multimodal
     */
    async processFile(chatId, filePath, mimetype, userMessage = 'Describe this file.', senderName = null) {
        const keys = Config.getGeminiKeys();
        if (keys.length === 0) {
            return { text: '⚠️ No Gemini API key configured.', error: true };
        }

        let contextMsg = userMessage;
        if (senderName) {
            contextMsg = `[Message from ${senderName} with attached file]: ${userMessage}`;
        }

        let lastError = null;
        const triedKeys = new Set();
        const API_TIMEOUT_MS = 30000;

        // Model hierarchy for fallback
        const preferredModel = Config.get('geminiModel') || 'gemini-2.5-flash';
        const fallbackModels = ['gemini-2.5-flash', 'gemini-2.0-flash'];
        const uniqueModels = [...new Set([preferredModel, ...fallbackModels])];

        for (const targetModel of uniqueModels) {
            console.log(`[Gemini] Attempting ${targetModel} for file analysis...`);
            triedKeys.clear();

            while (triedKeys.size < keys.length) {
                const currentKey = Config.getActiveKey();
                if (triedKeys.has(currentKey)) {
                    Config.rotateKey();
                    continue;
                }
                triedKeys.add(currentKey);

                try {
                    // Force v1 for multimodal
                    const client = new GoogleGenerativeAI(currentKey, { apiVersion: 'v1' });
                    const model = client.getGenerativeModel({
                        model: targetModel,
                        systemInstruction: (Config.get('characterPrompt') || '') + this.getDateTimeContext() + this.getCapabilities()
                    });

                    const fileData = fs.readFileSync(filePath);
                    const base64Data = fileData.toString('base64');

                    const result = await Promise.race([
                        model.generateContent([
                            contextMsg,
                            {
                                inlineData: {
                                    mimeType: mimetype,
                                    data: base64Data,
                                },
                            },
                        ]),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('API request timed out (30s)')), API_TIMEOUT_MS)
                        ),
                    ]);

                    const responseText = result.response.text();
                    Config.trackKeyUsage(currentKey);

                    // Update history with text only
                    this.addToHistory(chatId, 'user', `[Sent a ${mimetype} file] ${userMessage}`);
                    this.addToHistory(chatId, 'model', responseText);

                    console.log(`[Gemini] File SUCCESS using ${targetModel}`);
                    return { text: responseText, keyIndex: keys.indexOf(currentKey), model: targetModel };
                } catch (err) {
                    lastError = err;
                    const errorMsg = err.message || '';
                    console.error(`[Gemini] ${targetModel} file analysis failed on key ${keys.indexOf(currentKey) + 1}:`, errorMsg.substring(0, 100));

                    const isRetryable = errorMsg.includes('429') || errorMsg.includes('limit: 0') || errorMsg.includes('RESOURCE_EXHAUSTED') ||
                        errorMsg.includes('timeout') || errorMsg.includes('500') || errorMsg.includes('503');

                    if (isRetryable) {
                        Config.rotateKey();
                        await new Promise(r => setTimeout(r, 1000));
                        continue;
                    }
                    break;
                }
            }
        }

        return {
            text: `⚠️ File processing failed. Last error: ${lastError?.message || 'Unknown'}`,
            error: true,
        };
    }

    /**
     * Generate an image using multi-provider waterfall:
     *   1. Pollinations AI (free, no rate limits with sk_ key)
     *   2. Google Imagen 3 (free tier, ~25/day per key)
     *   3. Gemini Flash Image (paid fallback)
     */
    async generateImage(chatId, prompt) {
        const genDir = path.join(Config.get('filesDirectory') || path.join(require('os').homedir(), '.whatsapp-bot-session'), 'generated');
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
                                res.on('data', (chunk) => chunks.push(chunk));
                                res.on('end', () => {
                                    const buf = Buffer.concat(chunks);
                                    if (buf.length > 1000) resolve(buf);
                                    else reject(new Error(`Pollinations returned tiny response (${buf.length} bytes)`));
                                });
                            } else if (res.statusCode === 402) {
                                reject(new Error('POLLINATIONS_402_POLLEN_EXHAUSTED'));
                            } else if (res.statusCode === 429) {
                                reject(new Error('POLLINATIONS_429_RATE_LIMITED'));
                            } else {
                                const chunks = [];
                                res.on('data', (c) => chunks.push(c));
                                res.on('end', () => reject(new Error(`Pollinations HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString().substring(0, 100)}`)));
                            }
                        });
                        req.on('error', reject);
                        req.on('timeout', () => { req.destroy(); reject(new Error('Pollinations timeout')); });
                    });

                    fs.writeFileSync(filePath, imageBuffer);
                    console.log(`[ImageGen] ✅ Pollinations AI (${model}) success: ${filePath} (${imageBuffer.length} bytes)`);

                    this.addToHistory(chatId, 'user', `[Image generation request] ${prompt}`);
                    this.addToHistory(chatId, 'model', `[Generated image: ${filename}]`);

                    return { imagePath: filePath, text: '📸', mimeType: 'image/png' };

                } catch (err) {
                    const errMsg = err.message || '';
                    console.warn(`[ImageGen] Pollinations (${model}) failed: ${errMsg.substring(0, 150)}`);

                    // If pollen exhausted, skip all Pollinations models
                    if (errMsg.includes('POLLEN_EXHAUSTED')) {
                        console.warn('[ImageGen] Pollinations pollen exhausted, skipping to Google Imagen...');
                        break;
                    }
                    // If rate limited, try next model
                    continue;
                }
            }
        } else {
            console.log('[ImageGen] No Pollinations API key configured, skipping...');
        }

        // --- Provider 2: Google Imagen 3 (free tier) ---
        const keys = Config.getGeminiKeys();
        if (keys.length > 0) {
            let GoogleGenAI;
            try {
                GoogleGenAI = require('@google/genai').GoogleGenAI;
            } catch (e) {
                console.warn('[ImageGen] @google/genai not installed, skipping Imagen 3');
            }

            if (GoogleGenAI) {
                const triedKeys = new Set();
                while (triedKeys.size < keys.length) {
                    const currentKey = Config.getActiveKey();
                    if (triedKeys.has(currentKey)) { Config.rotateKey(); continue; }
                    triedKeys.add(currentKey);

                    try {
                        console.log(`[ImageGen] Trying Google Imagen 3 (key ${triedKeys.size}/${keys.length})...`);
                        const ai = new GoogleGenAI({ apiKey: currentKey });
                        const response = await ai.models.generateImages({
                            model: 'imagen-3.0-generate-002',
                            prompt: prompt,
                            config: { numberOfImages: 1 },
                        });

                        Config.trackKeyUsage(currentKey);

                        if (response.generatedImages && response.generatedImages.length > 0) {
                            const imgBytes = response.generatedImages[0].image.imageBytes;
                            fs.writeFileSync(filePath, Buffer.from(imgBytes, 'base64'));
                            console.log(`[ImageGen] ✅ Google Imagen 3 success: ${filePath}`);

                            this.addToHistory(chatId, 'user', `[Image generation request] ${prompt}`);
                            this.addToHistory(chatId, 'model', `[Generated image: ${filename}]`);

                            return { imagePath: filePath, text: '📸', mimeType: 'image/png' };
                        }
                    } catch (err) {
                        const errMsg = err.message || '';
                        console.warn(`[ImageGen] Imagen 3 key ${triedKeys.size} failed: ${errMsg.substring(0, 150)}`);
                        if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
                            Config.rotateKey();
                            continue;
                        }
                        break;
                    }
                }
            }
        }

        // --- All providers failed ---
        console.error('[ImageGen] All image providers failed');
        return {
            text: '⏳ Semua provider gambar sedang tidak tersedia. Coba lagi nanti ya.',
            error: true,
        };
    }

    /**
     * Generate a file — routes binary formats (xlsx, pdf, pptx) through structured
     * JSON prompting, and text formats through direct text generation.
     * Returns { filePath, filename, mimetype, caption } or uses fileManager for binaries.
     */
    async generateFile(chatId, prompt, filename, mimetype = 'text/plain') {
        const ext = path.extname(filename).toLowerCase();
        const isBinaryFormat = ['.xlsx', '.xls', '.pdf', '.pptx', '.ppt'].includes(ext);

        if (isBinaryFormat) {
            // For binary formats, return structured JSON that the caller
            // will pass to fileManager.createExcelFile / createPdfFile / createPptxFile
            const structuredData = await this.generateStructuredFileData(chatId, prompt, ext);
            if (structuredData.error) return structuredData;

            return {
                structuredData: structuredData.data,
                caption: structuredData.caption,
                filename,
                mimetype,
                format: ext,
            };
        }

        // Text-based formats: generate raw text content with caption
        const result = await this.generateResponse(chatId,
            `The user wants you to generate a file called "${filename}".
Request: ${prompt}

Respond in EXACTLY this format (two sections separated by "---FILE_CONTENT---"):
1. First line: A short 1-sentence caption/comment describing the file (this will be sent as a message alongside the file).
2. Then a separator line: ---FILE_CONTENT---
3. Then the complete raw file content (no markdown code fences, no explanations — just the raw content).

Example:
Here's the sales report you asked for! 📊
---FILE_CONTENT---
[actual file content here]`
        );

        if (result.error) return result;

        // Parse caption vs file content
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

        return {
            filePath,
            filename,
            mimetype,
            caption,
            text: caption,
        };
    }

    /**
     * Ask Gemini to produce structured JSON for binary file creation.
     * Format depends on file type:
     *   Excel: { title, headers: [], rows: [[]] }
     *   PDF:   { title, sections: [{ heading?, body }] }
     *   PPTX:  { title, slides: [{ title, content }] }
     */
    async generateStructuredFileData(chatId, prompt, ext) {
        let formatInstructions = '';

        if (ext === '.xlsx' || ext === '.xls') {
            formatInstructions = `Generate data for an Excel spreadsheet. Return valid JSON with this structure:
{
  "caption": "Short 1-sentence description to send alongside the file",
  "title": "Sheet name",
  "headers": ["Column1", "Column2", ...],
  "rows": [["cell1", "cell2", ...], ...]
}
Include realistic data with at least 5 rows. Every value must be a string.`;
        } else if (ext === '.pdf') {
            formatInstructions = `Generate content for a PDF document. Return valid JSON with this structure:
{
  "caption": "Short 1-sentence description to send alongside the file",
  "title": "Document Title",
  "sections": [
    { "heading": "Section Heading", "body": "Section body text..." },
    ...
  ]
}
Include at least 3 sections with meaningful content.`;
        } else if (ext === '.pptx' || ext === '.ppt') {
            formatInstructions = `Generate content for a PowerPoint presentation. Return valid JSON with this structure:
{
  "caption": "Short 1-sentence description to send alongside the file",
  "title": "Presentation Title",
  "slides": [
    { "title": "Slide Title", "content": "Slide body text / bullet points..." },
    ...
  ]
}
Include at least 4 slides with meaningful content.`;
        }

        const result = await this.generateResponse(chatId,
            `${prompt}

IMPORTANT: You MUST respond with ONLY valid JSON, no markdown code fences, no extra text.
${formatInstructions}`
        );

        if (result.error) return result;

        try {
            let jsonStr = result.text.trim();
            jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            const data = JSON.parse(jsonStr);
            return {
                data,
                caption: data.caption || `📎 Generated ${ext.replace('.', '').toUpperCase()} file`,
            };
        } catch (err) {
            console.error('[Gemini] Failed to parse structured file JSON:', err.message);
            console.error('[Gemini] Raw response:', result.text.substring(0, 500));
            return {
                text: '⚠️ Failed to generate the file. The AI returned invalid data. Please try again.',
                error: true,
            };
        }
    }

    /**
     * Search Google Maps for a location and return a link.
     */
    async searchGoogleMaps(chatId, query, senderName = null) {
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

        // Ask Gemini for a helpful comment about the location
        const result = await this.generateResponse(chatId,
            `[System: The user asked to find "${query}" on Google Maps. The link is: ${searchUrl}
Respond naturally with a short helpful comment about the location and include the link. Keep it brief — 1-2 sentences max.]`,
            senderName
        );

        if (result.error) return result;

        return {
            text: result.text,
            mapUrl: searchUrl,
            query,
        };
    }

    /**
     * Parse a natural language scheduling request into structured event data
     */
    async parseScheduleRequest(chatId, message) {
        const now = new Date().toISOString();
        const prompt = `Parse this scheduling request and return a valid JSON object (no markdown, no code fences, just raw JSON):
"${message}"

Current date/time: ${now}

Return format:
{
  "title": "Event title",
  "description": "Event description",
  "startTime": "ISO 8601 datetime",
  "endTime": "ISO 8601 datetime",
  "location": "Location if mentioned, otherwise null"
}`;

        const result = await this.generateResponse(chatId, prompt);
        if (result.error) return null;

        try {
            // Try to extract JSON from response
            let jsonStr = result.text.trim();
            // Remove potential markdown code fences
            jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (err) {
            console.error('[Gemini] Failed to parse schedule JSON:', err.message);
            return null;
        }
    }

    /**
     * Clear chat history for a specific conversation
     */
    clearHistory(chatId) {
        this.chatHistories.delete(chatId);
        this.saveHistories();
    }

    /**
     * Clear all chat histories
     */
    clearAllHistories() {
        this.chatHistories.clear();
        this.saveHistories();
    }

    /**
     * Test API key validity
     */
    async testKey(apiKey) {
        try {
            const client = new GoogleGenerativeAI(apiKey, { apiVersion: 'v1' });
            const model = client.getGenerativeModel({ model: Config.get('geminiModel') || 'gemini-2.0-flash' });
            const result = await model.generateContent('Say "API key is valid" in exactly those words.');
            return { valid: true, response: result.response.text() };
        } catch (err) {
            return { valid: false, error: err.message };
        }
    }
}

module.exports = GeminiService;
