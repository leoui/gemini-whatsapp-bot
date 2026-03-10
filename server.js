#!/usr/bin/env node
/**
 * Gemini WhatsApp Bot — Headless Server Mode v2
 * For Linux VPS / Cloud Server deployment (512MB RAM)
 * Runs without Electron GUI, using terminal for QR and logs.
 *
 * Usage:
 *   node server.js
 *
 * Environment:
 *   GEMINI_API_KEY=your_key1,your_key2  (required)
 *   GROQ_API_KEY=gsk_...               (optional, for free simple-chat routing)
 *   POLLINATIONS_API_KEY=sk_...        (optional, for image generation)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Config = require('./services/config');
const WhatsAppService = require('./services/whatsapp');
const GeminiService = require('./services/gemini');
const GroqService = require('./services/groq');
const CalendarService = require('./services/calendar');
const HumanBehavior = require('./services/humanBehavior');
const FileManager = require('./services/fileManager');
const Scheduler = require('./services/scheduler');
const Router = require('./services/router');
const HealthCheck = require('./services/healthCheck');
const InvestorService = require('./services/investorService');

// --- Service Instances ---
let whatsapp, gemini, groq, calendar, humanBehavior, fileManager;
let messageLog = [];

// --- Console Helpers ---
const LOG_PREFIX = {
    info: '\x1b[36m[INFO]\x1b[0m',
    ok: '\x1b[32m[OK]\x1b[0m',
    warn: '\x1b[33m[WARN]\x1b[0m',
    err: '\x1b[31m[ERROR]\x1b[0m',
    msg: '\x1b[35m[MSG]\x1b[0m',
};

function log(level, ...args) {
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`${ts} ${LOG_PREFIX[level] || ''}`, ...args);
}

// --- No-op renderer communication ---
function sendToRenderer(_channel, _data) { /* no GUI */ }

function addToLog(entry) {
    messageLog.unshift(entry);
    if (messageLog.length > 500) messageLog.pop();
}

function splitMessage(text, maxLen = 4000) {
    const parts = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let splitAt = remaining.lastIndexOf('\n', maxLen);
        if (splitAt < maxLen * 0.5) splitAt = maxLen;
        parts.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).trimStart();
    }
    if (remaining.length > 0) parts.push(remaining);
    return parts;
}

// === Copy handleIncomingMessage and all its logic from main.js ===
// We dynamically require main.js's handleIncomingMessage by duplicating the core logic here.
// This avoids pulling in Electron dependencies.

async function handleIncomingMessage(msg) {
    const logEntry = {
        id: msg.messageId,
        timestamp: Date.now(),
        sender: msg.senderName,
        senderJid: msg.senderJid,
        remoteJid: msg.remoteJid,
        text: msg.text,
        hasMedia: msg.hasMedia,
        mediaType: msg.mediaType,
        direction: 'incoming',
        status: 'received',
    };
    addToLog(logEntry);
    log('info', `[HANDLER] Processing message from ${msg.senderName} (${msg.remoteJid})`);
    log('msg', `📥 ${msg.senderName}: ${(msg.text || '[media]').substring(0, 80)}`);

    // --- Auto-reply check ---
    const autoReply = Config.get('autoReplyEnabled');
    if (autoReply === false) return;

    // --- Group handling ---
    if (msg.isGroup && Config.get('groupMentionOnly')) {
        const triggerWord = (Config.get('groupTriggerWord') || 'bot').toLowerCase();
        const msgText = (msg.text || '').toLowerCase().trim();

        // Check if message STARTS with trigger word (e.g. "cuy hello" or "cuy, help me")
        const triggeredByKeyword = msgText.startsWith(triggerWord + ',') ||
            msgText.startsWith(triggerWord + ' ') ||
            msgText.startsWith(triggerWord + ':') ||
            msgText === triggerWord;

        if (!msg.isMentioned && !triggeredByKeyword) {
            log('info', `[Bot] Group message ignored (not mentioned, no trigger word): "${(msg.text || '').substring(0, 40)}"`);
            return;
        }

        // Strip the trigger word from the beginning of the message
        if (triggeredByKeyword && msg.text) {
            msg.text = msg.text.replace(new RegExp(`^${triggerWord}[,:\\s]*`, 'i'), '').trim();
        }

        // Strip @mention tag from message text if present
        if (msg.isMentioned && msg.text) {
            msg.text = msg.text.replace(/@\d+/g, '').trim();
        }

        log('info', `[Bot] Group message accepted (mentioned=${msg.isMentioned}, triggered=${triggeredByKeyword})`);
    }

    // --- Allowed / Blocked contacts ---
    const allowed = Config.get('allowedContacts') || [];
    const blocked = Config.get('blockedContacts') || [];
    if (allowed.length > 0 && !allowed.includes(msg.senderJid) && !allowed.includes(msg.remoteJid)) return;
    if (blocked.includes(msg.senderJid) || blocked.includes(msg.remoteJid)) return;

    const chatId = msg.remoteJid;
    let responseResult = null;

    try {
        // === Health Check — whitelisted number only ===
        if (HealthCheck.isHealthCheckRequest(msg)) {
            log('info', `[HealthCheck] Request from ${msg.senderName} (${msg.senderJid})`);
            try {
                const report = await HealthCheck.generateHealthReport({ whatsapp, gemini, groq });
                await whatsapp.markRead(msg.key);
                await whatsapp.sendMessage(msg.remoteJid, report);
                log('ok', '[HealthCheck] Report sent.');
            } catch (hcErr) {
                log('err', `[HealthCheck] Failed: ${hcErr.message}`);
                await whatsapp.sendMessage(msg.remoteJid, `⚠️ Health check failed: ${hcErr.message}`);
            }
            return;
        }

        // === Silently ignore health check attempts from non-whitelisted numbers ===
        const _lowerTxt = (msg.text || '').toLowerCase();
        const _isHealthAttempt = ['/healthcheck', '/health', 'health check', 'healthcheck', 'status bot', 'bot status', 'cek status', 'cek bot'].some(t => _lowerTxt.includes(t));
        if (_isHealthAttempt) {
            log('info', `[HealthCheck] Ignored from non-whitelisted ${msg.senderJid}`);
            return;
        }

        // === /cl and /gm prefix: Investment Analysis ===
        const msgTextTrimmed = (msg.text || '').trim();
        const clMatch = msgTextTrimmed.match(/^\/cl\s+(.+)/is);
        const gmMatch = !clMatch ? msgTextTrimmed.match(/^\/gm\s+(.+)/is) : null;

        if (clMatch || gmMatch) {
            const model = clMatch ? 'claude' : 'gemini';
            const query = (clMatch || gmMatch)[1].trim();
            log('info', `[Investor] /${clMatch ? 'cl' : 'gm'} request: "${query}"`);

            // Extract ticker from query — look for stock-like patterns
            const tickerMatch = query.match(/\b([A-Z]{1,5}(?:\.JK)?)\b/i);
            const ticker = tickerMatch ? tickerMatch[1].toUpperCase() : null;

            try {
                await whatsapp.markRead(msg.key);
                await whatsapp.setPresence(msg.remoteJid, 'composing');

                let analysis;
                if (ticker) {
                    analysis = await InvestorService.analyze(ticker, query, model);
                } else {
                    analysis = `⚠️ Could not detect a stock ticker in your query.\n\nUsage examples:\n• /cl analyze BBRI.JK\n• /gm is AAPL undervalued?\n• /cl trading plan NVDA scalping\n• /gm compare BBCA.JK vs BMRI.JK`;
                }

                // Split long messages (WhatsApp limit ~4096 chars)
                if (analysis.length > 4000) {
                    const parts = splitMessage(analysis, 4000);
                    for (const part of parts) {
                        await whatsapp.sendMessage(msg.remoteJid, part);
                        await new Promise(r => setTimeout(r, 500));
                    }
                } else {
                    await whatsapp.sendMessage(msg.remoteJid, analysis);
                }

                await whatsapp.setPresence(msg.remoteJid, 'paused');
                log('ok', `[Investor] Analysis sent for ${ticker || 'unknown'} via ${model}`);
            } catch (investErr) {
                log('err', `[Investor] Failed: ${investErr.message}`);
                await whatsapp.sendMessage(msg.remoteJid, `⚠️ Investment analysis failed: ${investErr.message}`);
                await whatsapp.setPresence(msg.remoteJid, 'paused');
            }
            return;
        }

        // --- Media handling ---
        let mediaContext = null;
        if (msg.hasMedia && msg.rawMessage) {
            try {
                const buffer = await whatsapp.downloadMedia(msg.rawMessage);
                if (buffer) {
                    mediaContext = { buffer, mimetype: msg.mimetype, mediaType: msg.mediaType };
                }
            } catch (err) {
                log('warn', `Media download failed: ${err.message}`);
            }
        }

        const lowerText = (msg.text || '').toLowerCase();

        // --- Google search detection ---
        if (!responseResult && (
            lowerText.includes('search for') || lowerText.includes('google') ||
            lowerText.includes('cari ') || lowerText.includes('cariin') ||
            lowerText.includes('cari di google') || lowerText.includes('search')
        )) {
            // Let AI handle search requests
        }

        // --- Google Maps detection (skip if has reminder intent) ---
        const hasReminderIntent = ['reminder', 'remind', 'ingatkan', 'ingetin', 'jam ', 'at ', 'nanti', 'schedule', 'jadwal'].some(kw => lowerText.includes(kw));
        const hasSendToIntent = lowerText.includes('+') && ['kirim', 'send', 'chat', 'bilang', 'tell'].some(kw => lowerText.includes(kw));
        const hasMapsKeyword = (
            lowerText.includes('find on map') || lowerText.includes('search map') ||
            lowerText.includes('google maps') || lowerText.includes('where is') ||
            lowerText.includes('location of') || lowerText.includes('directions to') ||
            lowerText.includes('navigate to') || lowerText.includes('find location') ||
            lowerText.includes('maps search') || lowerText.includes('search location') ||
            lowerText.includes('lokasi')
        );

        if (!responseResult && hasMapsKeyword && !hasReminderIntent && !hasSendToIntent) {
            const placeMatch = msg.text.match(/(?:find on map|search map|google maps|where is|location of|directions to|navigate to|find location|maps search|search location|lokasi)\s*[:\-]?\s*(.+)/i);
            const query = placeMatch?.[1]?.trim() || msg.text;
            responseResult = await gemini.searchGoogleMaps(chatId, query, msg.senderName);
        }

        // --- Image generation detection ---
        const imageKeywords = [
            'generate image', 'create image', 'make an image', 'draw ', 'draw me',
            'generate a photo', 'create a photo', 'make a photo',
            'buatin foto', 'buatkan foto', 'bikin foto', 'buat foto',
            'buatin gambar', 'buatkan gambar', 'bikin gambar', 'buat gambar',
            'generate gambar', 'create gambar', 'gambarin', 'fotoin',
            'tolong buatin foto', 'tolong bikin gambar', 'coba bikin foto',
            'bikin image', 'buat image', 'generate foto',
            'bikinin foto', 'bikinin gambar',
            'tolong bikinin foto', 'tolong bikinin gambar',
            'boleh bikin foto', 'boleh buatin foto', 'boleh bikinin foto',
            'bisa bikin foto', 'bisa buatin foto', 'bisa bikinin foto',
            'boleh bikin gambar', 'boleh buatin gambar', 'boleh bikinin gambar',
            'bisa bikin gambar', 'bisa buatin gambar', 'bisa bikinin gambar',
        ];
        const hasImageIntent = imageKeywords.some(kw => lowerText.includes(kw));

        if (!responseResult && hasImageIntent) {
            log('info', `[HANDLER] 🎨 Image generation request detected`);
            responseResult = await gemini.generateImage(chatId, msg.text);

            // If image was generated, send it
            if (responseResult?.imagePath) {
                try {
                    const delays = await humanBehavior.calculateDelays(msg.text, responseResult.text || '');
                    await HumanBehavior.sleep(delays.readDelay);
                    await whatsapp.markRead(msg.key);
                    await whatsapp.setPresence(msg.remoteJid, 'composing');
                    await HumanBehavior.sleep(delays.typingDelay);
                    await whatsapp.sendImage(msg.remoteJid, responseResult.imagePath, responseResult.text || '');
                    await whatsapp.setPresence(msg.remoteJid, 'paused');
                    humanBehavior.recordMessageSent();
                    log('ok', `🎨 Generated image sent to ${msg.remoteJid}`);
                } catch (err) {
                    log('err', `Image send failed: ${err.message}`);
                    await whatsapp.sendMessage(msg.remoteJid, `⚠️ Image was generated but failed to send: ${err.message}`);
                }
                return;
            }
            // If image generation failed, responseResult.text has the error — fall through to send as text
        }

        // --- File creation detection ---
        const fileKeywords = ['excel', 'spreadsheet', 'xlsx', 'xls', '.pdf', 'pptx', 'powerpoint'];
        const hasFileTypeWord = fileKeywords.some(kw => lowerText.includes(kw));
        const hasFileAction = ['create', 'make', 'generate', 'write', 'send', 'build', 'buat', 'bikin', 'kirim', 'list', 'daftar', 'data'].some(kw => lowerText.includes(kw));
        const hasFileContext = [' in excel', ' in pdf', ' in pptx', ' ke excel', ' ke pdf', ' dalam excel', ' dalam pdf',
            ' format excel', ' format pdf', ' format xlsx', ' format csv', ' to excel', ' to pdf', ' as excel', ' as pdf',
            ' jadi excel', ' jadi pdf'].some(kw => lowerText.includes(kw));

        log('info', `[HANDLER] Intent: Media=${!!mediaContext}, FileAction=${hasFileAction}, FileType=${hasFileTypeWord}, ImageGen=${hasImageIntent}`);

        if (!responseResult && (
            lowerText.includes('generate file') || lowerText.includes('create file') ||
            lowerText.includes('make a file') || lowerText.includes('write a file') ||
            lowerText.includes('buatkan file') || lowerText.includes('bikin file') ||
            lowerText.includes('create excel') || lowerText.includes('create pdf') ||
            lowerText.includes('buat excel') || lowerText.includes('buat pdf') ||
            (hasFileTypeWord && hasFileAction) || hasFileContext
        )) {
            log('info', `[HANDLER] Triggering AI file generation...`);

            // Detect target format
            let targetExt = '.txt';
            if (lowerText.includes('excel') || lowerText.includes('xlsx') || lowerText.includes('spreadsheet')) targetExt = '.xlsx';
            else if (lowerText.includes('pdf')) targetExt = '.pdf';
            else if (lowerText.includes('pptx') || lowerText.includes('powerpoint')) targetExt = '.pptx';
            else if (lowerText.includes('csv')) targetExt = '.csv';

            const targetFilename = lowerText.match(/(?:file|nama|name)\s+([\w\-\.]+)/)?.[1] ||
                `document_${Date.now()}${targetExt}`;
            const finalFilename = targetFilename.includes('.') ? targetFilename : `${targetFilename}${targetExt}`;

            try {
                const fileResult = await gemini.generateFile(chatId, msg.text, finalFilename);

                if (fileResult?.error) {
                    responseResult = fileResult; // Let it fall through to send error as text
                } else if (fileResult?.structuredData) {
                    // Binary file — route to correct fileManager method
                    let fmResult;
                    if (targetExt === '.xlsx') {
                        fmResult = await fileManager.createExcelFile(finalFilename, fileResult.structuredData);
                    } else if (targetExt === '.pdf') {
                        fmResult = await fileManager.createPdfFile(finalFilename, fileResult.structuredData);
                    } else if (targetExt === '.pptx') {
                        fmResult = await fileManager.createPptxFile(finalFilename, fileResult.structuredData);
                    }

                    const filePath = fmResult?.path || fmResult;
                    const caption = fileResult.caption || `📎 ${finalFilename}`;

                    const delays = await humanBehavior.calculateDelays(msg.text, caption);
                    await HumanBehavior.sleep(delays.readDelay);
                    await whatsapp.markRead(msg.key);
                    await whatsapp.setPresence(msg.remoteJid, 'composing');
                    await HumanBehavior.sleep(delays.typingDelay);
                    await whatsapp.sendFile(msg.remoteJid, filePath, {
                        caption,
                        mimetype: fmResult?.mimetype || fileManager.getMimeFromPath(filePath),
                        fileName: finalFilename,
                    });
                    await whatsapp.setPresence(msg.remoteJid, 'paused');
                    humanBehavior.recordMessageSent();
                    log('ok', `📤 File sent: ${finalFilename}`);
                    return;
                } else if (fileResult?.filePath) {
                    // Text-based file — already saved to disk
                    const caption = fileResult.caption || `📎 ${finalFilename}`;

                    const delays = await humanBehavior.calculateDelays(msg.text, caption);
                    await HumanBehavior.sleep(delays.readDelay);
                    await whatsapp.markRead(msg.key);
                    await whatsapp.setPresence(msg.remoteJid, 'composing');
                    await HumanBehavior.sleep(delays.typingDelay);
                    await whatsapp.sendFile(msg.remoteJid, fileResult.filePath, {
                        caption,
                        mimetype: fileResult.mimetype || fileManager.getMimeFromPath(fileResult.filePath),
                        fileName: fileResult.filename || finalFilename,
                    });
                    await whatsapp.setPresence(msg.remoteJid, 'paused');
                    humanBehavior.recordMessageSent();
                    log('ok', `📤 File sent: ${finalFilename}`);
                    return;
                } else {
                    responseResult = { text: fileResult?.text || '⚠️ Failed to generate file.', error: true };
                }
            } catch (err) {
                log('err', `File generation failed: ${err.message}`);
                await whatsapp.sendMessage(msg.remoteJid, `⚠️ Sorry, I couldn't create the file: ${err.message}`);
                return;
            }
        }

        if (!responseResult) {
            if (mediaContext) {
                // Media always goes to Gemini (multimodal)
                log('info', `[HANDLER] Sending ${mediaContext.mediaType} (${mediaContext.mimetype}) to Gemini for analysis...`);
                const tempExt = {
                    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
                    'application/pdf': '.pdf', 'video/mp4': '.mp4', 'audio/ogg': '.ogg',
                }[mediaContext.mimetype] || '';
                const tempPath = path.join(os.tmpdir(), `whatsapp_media_${Date.now()}${tempExt}`);
                fs.writeFileSync(tempPath, mediaContext.buffer);
                const userPrompt = msg.text || (msg.filename ? `Analyze this file: ${msg.filename}` : 'Describe this file');
                responseResult = await gemini.processFile(chatId, tempPath, mediaContext.mimetype, userPrompt, msg.senderName);
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } else {
                // Route: simple chat → Groq (free), complex tasks → Gemini
                const aiTarget = Router.classify(msg);
                if (aiTarget === 'groq' && groq && groq.isAvailable()) {
                    log('info', `[Router] → Groq (simple chat)`);
                    responseResult = await groq.generateResponse(chatId, msg.text, msg.senderName);
                    if (!responseResult) {
                        log('warn', `[Router] Groq failed, falling back to Gemini`);
                    }
                }
                if (!responseResult) {
                    log('info', `[Router] → Gemini (${aiTarget === 'groq' ? 'Groq fallback' : 'complex task'})`);
                    responseResult = await gemini.generateResponse(chatId, msg.text, msg.senderName);
                }
            }
        }

        log('info', `[HANDLER] Gemini responded: ${responseResult?.error ? 'ERROR' : 'SUCCESS'}`);

        // --- Process AI response ---
        if (!responseResult || !responseResult.text) return;

        // --- Handle [CREATE_FILE:type:filename] tag ---
        const fileTagMatch = responseResult.text.match(/\[CREATE_FILE:([^:]+):([^\]]+)\]/);
        if (fileTagMatch) {
            const fileType = fileTagMatch[1].toLowerCase();
            const fileName = fileTagMatch[2].trim();
            let caption = responseResult.text.replace(/\[CREATE_FILE:[^\]]+\]/g, '').trim();

            log('info', `📄 Creating file: ${fileName} (${fileType})`);

            try {
                // Route to the correct fileManager method based on type
                let filePath;
                const ext = path.extname(fileName).toLowerCase();

                if (['excel', 'xlsx', 'xls', 'spreadsheet'].includes(fileType) || ext === '.xlsx' || ext === '.xls') {
                    const structuredResult = await gemini.generateFile(chatId, msg.text, fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`);
                    if (structuredResult?.structuredData) {
                        const result = await fileManager.createExcelFile(fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`, structuredResult.structuredData);
                        filePath = result.path || result; // fileManager returns { path, filename, mimetype, size }
                        caption = structuredResult.caption || caption;
                    } else if (structuredResult?.filePath) {
                        filePath = structuredResult.filePath;
                        caption = structuredResult.caption || caption;
                    } else {
                        throw new Error(structuredResult?.text || 'Failed to generate Excel data');
                    }
                } else if (['pdf'].includes(fileType) || ext === '.pdf') {
                    const structuredResult = await gemini.generateFile(chatId, msg.text, fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`);
                    if (structuredResult?.structuredData) {
                        const result = await fileManager.createPdfFile(fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`, structuredResult.structuredData);
                        filePath = result.path || result;
                        caption = structuredResult.caption || caption;
                    } else if (structuredResult?.filePath) {
                        filePath = structuredResult.filePath;
                        caption = structuredResult.caption || caption;
                    } else {
                        throw new Error(structuredResult?.text || 'Failed to generate PDF data');
                    }
                } else if (['pptx', 'powerpoint', 'ppt', 'presentation'].includes(fileType) || ext === '.pptx' || ext === '.ppt') {
                    const structuredResult = await gemini.generateFile(chatId, msg.text, fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`);
                    if (structuredResult?.structuredData) {
                        const result = await fileManager.createPptxFile(fileName.endsWith('.pptx') ? fileName : `${fileName}.pptx`, structuredResult.structuredData);
                        filePath = result.path || result;
                        caption = structuredResult.caption || caption;
                    } else if (structuredResult?.filePath) {
                        filePath = structuredResult.filePath;
                        caption = structuredResult.caption || caption;
                    } else {
                        throw new Error(structuredResult?.text || 'Failed to generate PPTX data');
                    }
                } else {
                    // Text-based files (csv, txt, html, json, etc.)
                    const textResult = await gemini.generateFile(chatId, msg.text, fileName);
                    if (textResult?.filePath) {
                        filePath = textResult.filePath;
                        caption = textResult.caption || caption;
                    } else {
                        throw new Error(textResult?.text || 'Failed to generate file');
                    }
                }

                // MIME type lookup
                const FILE_TYPE_MIMES = {
                    'excel': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'xls': 'application/vnd.ms-excel',
                    'pdf': 'application/pdf',
                    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                    'ppt': 'application/vnd.ms-powerpoint',
                    'powerpoint': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                    'csv': 'text/csv',
                    'txt': 'text/plain',
                    'html': 'text/html',
                    'json': 'application/json',
                };
                const mimetype = FILE_TYPE_MIMES[fileType] || fileManager.getMimeFromPath(filePath);

                // Check for SEND_TO tag
                let recipientJid = msg.remoteJid;
                let recipientName = null;
                const sendToInFile = responseResult.text?.match(/\[SEND_TO:([^:]+):([^\]]*)\]/);
                if (sendToInFile) {
                    const target = sendToInFile[1].trim();
                    const resolved = resolveContact(target);
                    if (resolved) {
                        recipientJid = resolved.jid;
                        recipientName = resolved.name;
                    }
                    caption = caption.replace(/\[SEND_TO:[^\]]+\]/g, '').trim();
                }

                await whatsapp.sendFile(recipientJid, filePath, {
                    caption: caption || `📎 ${fileName}`,
                    mimetype: mimetype,
                    fileName: fileName,
                });

                if (recipientName && recipientJid !== msg.remoteJid) {
                    await whatsapp.sendMessage(msg.remoteJid, `✅ File "${fileName}" sent to ${recipientName}!`);
                }

                log('ok', `📤 File sent: ${fileName}`);
            } catch (err) {
                log('err', `File creation failed: ${err.message}`);
                await whatsapp.sendMessage(msg.remoteJid, `⚠️ Sorry, I couldn't create the file: ${err.message}`);
            }
            return;
        }

        // --- Handle [IMAGE_GEN: prompt] tag in AI response ---
        const imageGenTagMatch = responseResult.text?.match(/\[IMAGE_GEN:\s*([^\]]+)\]/);
        if (imageGenTagMatch) {
            const imagePrompt = imageGenTagMatch[1].trim();
            const cleanText = responseResult.text.replace(/\[IMAGE_GEN:[^\]]+\]/g, '').trim();

            log('info', `[Bot] AI requested image generation: "${imagePrompt}"`);

            try {
                const imageResult = await gemini.generateImage(chatId, imagePrompt);

                if (imageResult?.imagePath) {
                    await whatsapp.markRead(msg.key);
                    await whatsapp.setPresence(msg.remoteJid, 'composing');
                    await new Promise(r => setTimeout(r, 1500));

                    await whatsapp.sendFile(msg.remoteJid, imageResult.imagePath, {
                        caption: cleanText || '📸',
                        mimetype: imageResult.mimeType || 'image/png',
                    });

                    await whatsapp.setPresence(msg.remoteJid, 'paused');
                    log('info', `[Bot] 🎨 Sent generated image: "${imagePrompt}"`);
                    return;
                } else {
                    responseResult.text = cleanText || '⚠️ Image generation failed, please try again.';
                }
            } catch (imgErr) {
                log('error', `[Bot] IMAGE_GEN failed: ${imgErr.message}`);
                responseResult.text = cleanText || '⚠️ Image generation failed, please try again.';
            }
        }

        // --- Handle [STOCK_ANALYSIS: ticker] tag in AI response ---
        const stockTagMatch = responseResult.text?.match(/\[STOCK_ANALYSIS:\s*([^\]]+)\]/);
        if (stockTagMatch) {
            const ticker = stockTagMatch[1].trim().toUpperCase();
            const cleanText = responseResult.text.replace(/\[STOCK_ANALYSIS:[^\]]+\]/g, '').trim();
            log('info', `[Investor] AI requested stock analysis: ${ticker}`);
            try {
                const analysis = await InvestorService.analyze(ticker, `Analyze ${ticker}`, 'gemini');
                await whatsapp.markRead(msg.key);
                await whatsapp.setPresence(msg.remoteJid, 'composing');
                await new Promise(r => setTimeout(r, 1500));
                if (analysis.length > 4000) {
                    const parts = splitMessage(analysis, 4000);
                    for (const part of parts) {
                        await whatsapp.sendMessage(msg.remoteJid, part);
                        await new Promise(r => setTimeout(r, 500));
                    }
                } else {
                    await whatsapp.sendMessage(msg.remoteJid, analysis);
                }
                await whatsapp.setPresence(msg.remoteJid, 'paused');
                log('ok', `[Investor] Tag-based analysis sent: ${ticker}`);
                return;
            } catch (err) {
                log('err', `[Investor] Tag analysis failed: ${err.message}`);
                responseResult.text = cleanText || `⚠️ Stock analysis for ${ticker} failed: ${err.message}`;
            }
        }

        // --- Handle [REMINDER:time:message] tag ---
        const reminderMatch = responseResult.text.match(/\[REMINDER:([^:]+):([^\]]+)\]/);
        if (reminderMatch) {
            const timeExpr = reminderMatch[1].trim();
            const reminderMsg = reminderMatch[2].trim();
            let cleanText = responseResult.text
                .replace(/\[REMINDER:[^\]]+\]/g, '')
                .replace(/\[SEND_TO:[^\]]+\]/g, '')
                .replace(/\[CREATE_FILE:[^\]]+\]/g, '')
                .replace(/[\[\]]/g, '') // Remove any stray brackets
                .trim();

            log('info', `[HANDLER] Setting reminder for "${timeExpr}"`);

            // Check if reminder should be sent to a different contact
            let targetJid = msg.remoteJid;
            const sendToInReminder = responseResult.text.match(/\[SEND_TO:([^:]+):([^\]]*)\]/);
            if (sendToInReminder) {
                const target = sendToInReminder[1].trim();
                const resolved = resolveContact(target);
                if (resolved) {
                    targetJid = resolved.jid;
                    log('info', `[HANDLER] Reminder will be sent to ${resolved.name} (${resolved.jid})`);
                }
            }

            try {
                const scheduledTime = Scheduler.parseTime(timeExpr);
                if (scheduledTime) {
                    Scheduler.addTask({
                        targetJid: targetJid,
                        message: reminderMsg,
                        dueAt: scheduledTime.toISOString(),
                        createdBy: msg.senderName,
                        type: 'reminder',
                    });
                    log('ok', `⏰ Reminder set for ${scheduledTime.toLocaleString()} → ${targetJid}`);
                }
            } catch (err) {
                log('warn', `Reminder parse failed: ${err.message}`);
            }

            // Send confirmation
            const delays = await humanBehavior.calculateDelays(msg.text, cleanText);
            await HumanBehavior.sleep(delays.readDelay);
            await whatsapp.markRead(msg.key);
            await whatsapp.setPresence(msg.remoteJid, 'composing');
            await HumanBehavior.sleep(delays.typingDelay);
            await whatsapp.sendMessage(msg.remoteJid, cleanText || `✅ Reminder set!`);
            await whatsapp.setPresence(msg.remoteJid, 'paused');
            humanBehavior.recordMessageSent();

            addToLog({
                id: `resp_${Date.now()}`, timestamp: Date.now(), sender: 'Bot',
                remoteJid: msg.remoteJid, text: cleanText, direction: 'outgoing', status: 'sent',
            });
            return;
        }

        // --- Handle [SEND_TO:target:message] tag ---
        const sendToTagMatch = responseResult.text?.match(/\[SEND_TO:([^:]+):([^\]]*)\]/);
        if (sendToTagMatch) {
            let target = sendToTagMatch[1].trim();
            const messageToSend = sendToTagMatch[2].trim();
            const cleanText = responseResult.text.replace(/\[SEND_TO:[^\]]+\]/g, '').trim();

            const resolved = resolveContact(target);
            if (!resolved) {
                await whatsapp.sendMessage(msg.remoteJid,
                    `⚠️ I couldn't find a contact named "${target}". Please provide their phone number or save them in your contact book.`);
                return;
            }

            const { jid: targetJid, name: displayName } = resolved;
            log('info', `📨 Sending to ${displayName} (${targetJid})`);

            try {
                const delays = await humanBehavior.calculateDelays(msg.text, cleanText);
                await HumanBehavior.sleep(delays.readDelay);
                await whatsapp.markRead(msg.key);

                // Forward media if present
                if (msg.hasMedia && msg.rawMessage) {
                    const mediaBuffer = await whatsapp.downloadMedia(msg.rawMessage);
                    if (mediaBuffer) {
                        const sendPayload = {};
                        const caption = messageToSend || msg.text?.replace(/\[SEND_TO:[^\]]+\]/g, '').trim() || '';

                        if (msg.mediaType === 'image') {
                            sendPayload.image = mediaBuffer;
                            sendPayload.caption = caption;
                            sendPayload.mimetype = msg.mimetype || 'image/jpeg';
                        } else if (msg.mediaType === 'video') {
                            sendPayload.video = mediaBuffer;
                            sendPayload.caption = caption;
                            sendPayload.mimetype = msg.mimetype || 'video/mp4';
                        } else if (msg.mediaType === 'audio') {
                            sendPayload.audio = mediaBuffer;
                            sendPayload.mimetype = msg.mimetype || 'audio/mpeg';
                        } else {
                            sendPayload.document = mediaBuffer;
                            sendPayload.caption = caption;
                            sendPayload.mimetype = msg.mimetype || 'application/octet-stream';
                            sendPayload.fileName = msg.filename || 'file';
                        }
                        await whatsapp.sock.sendMessage(targetJid, sendPayload);
                    }
                } else if (messageToSend) {
                    await whatsapp.sendMessage(targetJid, messageToSend);
                }

                // Confirm to requester
                const confirmMsg = msg.hasMedia
                    ? `✅ ${msg.mediaType === 'image' ? '📷 Image' : '📎 File'} sent to ${displayName}!`
                    : `✅ Message sent to ${displayName}!`;
                await whatsapp.sendMessage(msg.remoteJid, cleanText || confirmMsg);
                humanBehavior.recordMessageSent();

                log('ok', `📤 Sent to ${displayName}`);
            } catch (err) {
                log('err', `Send-to failed: ${err.message}`);
                await whatsapp.sendMessage(msg.remoteJid, `⚠️ Failed to send to ${displayName}: ${err.message}`);
            }
            return;
        }

        // --- Handle image response (imagePath from any flow) ---
        if (responseResult.imagePath) {
            try {
                const delays = await humanBehavior.calculateDelays(msg.text, responseResult.text || '');
                await HumanBehavior.sleep(delays.readDelay);
                await whatsapp.markRead(msg.key);
                await whatsapp.setPresence(msg.remoteJid, 'composing');
                await HumanBehavior.sleep(delays.typingDelay);
                await whatsapp.sendImage(msg.remoteJid, responseResult.imagePath, responseResult.text || '');
                await whatsapp.setPresence(msg.remoteJid, 'paused');
                humanBehavior.recordMessageSent();
                log('ok', `🎨 Image sent to ${msg.remoteJid}`);
            } catch (err) {
                log('err', `Image send failed: ${err.message}`);
                await whatsapp.sendMessage(msg.remoteJid, responseResult.text || '⚠️ Failed to send image.');
            }
            return;
        }

        // --- Handle file response (filePath from generateFile direct routing) ---
        if (responseResult.filePath && !fileTagMatch) {
            try {
                const delays = await humanBehavior.calculateDelays(msg.text, responseResult.caption || '');
                await HumanBehavior.sleep(delays.readDelay);
                await whatsapp.markRead(msg.key);
                await whatsapp.setPresence(msg.remoteJid, 'composing');
                await HumanBehavior.sleep(delays.typingDelay);
                await whatsapp.sendFile(msg.remoteJid, responseResult.filePath, {
                    caption: responseResult.caption || responseResult.text || `📎 ${responseResult.filename || 'file'}`,
                    mimetype: responseResult.mimetype || fileManager.getMimeFromPath(responseResult.filePath),
                    fileName: responseResult.filename || path.basename(responseResult.filePath),
                });
                await whatsapp.setPresence(msg.remoteJid, 'paused');
                humanBehavior.recordMessageSent();
                log('ok', `📤 File sent: ${responseResult.filename || responseResult.filePath}`);
            } catch (err) {
                log('err', `File send failed: ${err.message}`);
                await whatsapp.sendMessage(msg.remoteJid, responseResult.text || '⚠️ Failed to send file.');
            }
            return;
        }

        // --- Default: send text reply ---
        const cleanText = responseResult.text
            .replace(/\[CREATE_FILE:[^\]]+\]/g, '')
            .replace(/\[REMINDER:[^\]]+\]/g, '')
            .replace(/\[SEND_TO:[^\]]+\]/g, '')
            .replace(/^\s*[\[\]]\s*$/gm, '') // Remove lines that are just stray brackets
            .replace(/\n{3,}/g, '\n\n') // Collapse excessive newlines
            .trim();

        if (cleanText) {
            const delays = await humanBehavior.calculateDelays(msg.text, cleanText);
            await HumanBehavior.sleep(delays.readDelay);
            await whatsapp.markRead(msg.key);
            await whatsapp.setPresence(msg.remoteJid, 'composing');
            await HumanBehavior.sleep(delays.typingDelay);
            await whatsapp.sendMessage(msg.remoteJid, cleanText);
            await whatsapp.setPresence(msg.remoteJid, 'paused');
            humanBehavior.recordMessageSent();

            addToLog({
                id: `resp_${Date.now()}`, timestamp: Date.now(), sender: 'Bot',
                remoteJid: msg.remoteJid, text: cleanText.substring(0, 100), direction: 'outgoing', status: 'sent',
            });
            log('msg', `📤 Bot: ${cleanText.substring(0, 80)}`);
        }

    } catch (err) {
        log('err', `Message handler error: ${err.message}`);
    }
}

// --- Contact Resolution Helper ---
function resolveContact(target) {
    // Step 1: Saved contacts (shortcode or name)
    const savedContacts = Config.get('savedContacts') || [];
    const shortcodeTarget = target.startsWith('+') ? target.toLowerCase() : `+${target}`.toLowerCase();
    const savedByShortcode = savedContacts.find(c => c.shortcode.toLowerCase() === shortcodeTarget);
    const savedByName = !savedByShortcode ? savedContacts.find(c => c.name.toLowerCase() === target.toLowerCase()) : null;
    const savedContact = savedByShortcode || savedByName;

    if (savedContact) {
        let phone = savedContact.phone;
        if (phone.startsWith('0')) phone = '62' + phone.substring(1);
        phone = phone.replace(/[^\d]/g, '');
        return { jid: `${phone}@s.whatsapp.net`, name: savedContact.name };
    }

    // Step 2: Raw phone number
    if (/^\d+$/.test(target)) {
        let phone = target;
        if (phone.startsWith('0')) phone = '62' + phone.substring(1);
        return { jid: `${phone}@s.whatsapp.net`, name: phone };
    }

    // Step 3: Live WhatsApp contacts
    const matches = whatsapp.findContactByName(target);
    if (matches.length > 0) {
        return { jid: matches[0].jid, name: matches[0].name || matches[0].pushName || target };
    }

    return null;
}

// === Initialize ===
function initializeServices() {
    whatsapp = new WhatsAppService();
    gemini = new GeminiService();
    groq = new GroqService();
    calendar = new CalendarService();
    humanBehavior = new HumanBehavior();
    fileManager = new FileManager();

    calendar.initialize();

    Scheduler.start(whatsapp, (task) => {
        log('ok', `⏰ Reminder fired: ${task.message}`);
        addToLog({
            id: `reminder_${Date.now()}`, timestamp: Date.now(), sender: 'Bot (Reminder)',
            remoteJid: task.targetJid, text: `⏰ ${task.message.substring(0, 60)}`, direction: 'outgoing', status: 'sent',
        });
    });

    // --- WhatsApp Events ---
    whatsapp.on('qr', (qr) => {
        log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('info', '📱 Scan QR code with WhatsApp:');
        log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        // Display QR in terminal
        try {
            const qrTerminal = require('qrcode-terminal');
            qrTerminal.generate(qr, { small: true });
        } catch {
            log('warn', 'Install qrcode-terminal: npm install qrcode-terminal');
            log('info', `QR Data: ${qr}`);
        }
    });

    whatsapp.on('pairing_code', ({ code, formatted }) => {
        log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('info', `📱 PAIRING CODE: ${formatted}`);
        log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        log('info', 'Open WhatsApp → Linked Devices → Link with phone number');
        log('info', `Enter code: ${formatted}`);
    });

    whatsapp.on('status', (status) => {
        if (status.state === 'connected') {
            log('ok', `✅ WhatsApp connected as ${status.user?.name || status.user?.id || 'Unknown'}`);
        } else if (status.state === 'disconnected') {
            log('warn', `❌ WhatsApp disconnected: ${status.message}`);
        } else if (status.state === 'reconnecting') {
            log('info', `🔄 ${status.message}`);
        }
    });

    whatsapp.on('message', async (msg) => {
        await handleIncomingMessage(msg);
    });
}

// === Simple Status HTTP Server (optional, port 3001) ===
function startStatusServer() {
    const port = process.env.STATUS_PORT || 3001;

    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');

        if (req.url === '/status') {
            res.end(JSON.stringify({
                status: whatsapp?.connectionState || 'unknown',
                uptime: process.uptime(),
                memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
                logs: messageLog.length,
                scheduledTasks: (Config.get('scheduledTasks') || []).length,
                savedContacts: (Config.get('savedContacts') || []).length,
            }));
        } else if (req.url === '/logs') {
            res.end(JSON.stringify(messageLog.slice(0, 50)));
        } else if (req.url === '/health') {
            res.end(JSON.stringify({ ok: true, connected: whatsapp?.connectionState === 'connected' }));
        } else {
            res.end(JSON.stringify({ endpoints: ['/status', '/logs', '/health'] }));
        }
    });

    server.listen(port, '0.0.0.0', () => {
        log('ok', `📡 Status API running on http://0.0.0.0:${port}`);
    });
}

// === Main Entry ===
async function main() {
    console.log('');
    console.log('\x1b[36m╔══════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[36m║   🤖 Gemini WhatsApp Bot — Server Mode   ║\x1b[0m');
    console.log('\x1b[36m║   Headless • Low Memory • VPS Ready      ║\x1b[0m');
    console.log('\x1b[36m╚══════════════════════════════════════════╝\x1b[0m');
    console.log('');

    // Check for API key
    let keys = Config.get('geminiKeys') || [];
    const envKey = process.env.GEMINI_API_KEY;

    if (envKey) {
        // Split by comma and cleanup to support multiple keys
        const newKeys = envKey.split(',').map(k => k.trim()).filter(k => k.length > 0);
        if (newKeys.length > 0) {
            Config.set('geminiKeys', newKeys);
            keys = newKeys;
            log('ok', `Loaded ${newKeys.length} API key(s) from GEMINI_API_KEY env`);
        }
    }

    if (keys.length === 0) {
        log('err', 'No Gemini API key configured!');
        log('info', 'Set via: GEMINI_API_KEY=key1,key2 node server.js');
        log('info', 'Or add to config: node -e "require(\'./services/config\').set(\'geminiKeys\', [\'key1\', \'key2\'])"');
        process.exit(1);
    }

    log('info', `API keys: ${(Config.get('geminiKeys') || []).length} configured`);
    log('info', `Model: ${Config.get('geminiModel') || 'gemini-2.5-flash'}`);
    log('info', `Groq routing: ${(process.env.GROQ_API_KEY || Config.get('groqApiKey')) ? 'enabled (simple chat → Llama 3.3 70B)' : 'disabled (set GROQ_API_KEY to enable)'}`);
    log('info', `Saved contacts: ${(Config.get('savedContacts') || []).length}`);
    log('info', `Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);

    initializeServices();
    startStatusServer();

    // Auto-connect WhatsApp
    log('info', '📱 Connecting to WhatsApp...');
    try {
        await whatsapp.connect();
    } catch (err) {
        log('err', `WhatsApp connect failed: ${err.message}`);
    }

    // Graceful shutdown
    process.on('SIGINT', async () => {
        log('info', '\n🛑 Shutting down...');
        Scheduler.stop();
        if (whatsapp) await whatsapp.disconnect().catch(() => { });
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        log('info', '\n🛑 SIGTERM received, shutting down...');
        Scheduler.stop();
        if (whatsapp) await whatsapp.disconnect().catch(() => { });
        process.exit(0);
    });

    // Keep process alive
    process.on('uncaughtException', (err) => {
        log('err', `Uncaught exception: ${err.message}`);
        console.error(err.stack);
    });

    process.on('unhandledRejection', (err) => {
        log('err', `Unhandled rejection: ${err}`);
    });
}

main();
