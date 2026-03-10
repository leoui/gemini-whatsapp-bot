const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Config = require('./services/config');
const WhatsAppService = require('./services/whatsapp');
const GeminiService = require('./services/gemini');
const CalendarService = require('./services/calendar');
const HumanBehavior = require('./services/humanBehavior');
const FileManager = require('./services/fileManager');
const Scheduler = require('./services/scheduler');
const QRCode = require('qrcode');

// --- Service Instances ---
let whatsapp, gemini, calendar, humanBehavior, fileManager;
let mainWindow;
let messageLog = []; // In-memory log for UI display

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        titleBarStyle: 'hiddenInset',
        vibrancy: 'under-window',
        visualEffectState: 'active',
        backgroundColor: '#0a0a0f',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// --- Initialize Services ---
function initializeServices() {
    whatsapp = new WhatsAppService();
    gemini = new GeminiService();
    calendar = new CalendarService();
    humanBehavior = new HumanBehavior();
    fileManager = new FileManager();

    // Try to initialize calendar
    calendar.initialize();

    // Start the scheduler (fires reminders when due)
    Scheduler.start(whatsapp, (task) => {
        console.log(`[Scheduler] Reminder fired: ${task.message}`);
        addToLog({
            id: `reminder_${Date.now()}`,
            timestamp: Date.now(),
            sender: 'Bot (Reminder)',
            remoteJid: task.targetJid,
            text: `⏰ Reminder sent: "${task.message.substring(0, 60)}"`,
            direction: 'outgoing',
            status: 'sent',
        });
    });

    // --- WhatsApp Event Handlers ---
    whatsapp.on('qr', async (qr) => {
        try {
            const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
            sendToRenderer('whatsapp:qr', qrDataUrl);
        } catch (err) {
            console.error('QR generation error:', err);
        }
    });

    whatsapp.on('status', (status) => {
        sendToRenderer('whatsapp:status', status);
    });

    whatsapp.on('message', async (msg) => {
        await handleIncomingMessage(msg);
    });
}

// --- Core Message Handler ---
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

    // Check active hours
    if (!humanBehavior.isWithinActiveHours()) {
        console.log('[Bot] Outside active hours, ignoring message');
        logEntry.status = 'ignored (outside active hours)';
        sendToRenderer('log:update', logEntry);
        return;
    }

    // --- Group filter: respond when mentioned OR trigger word used ---
    if (msg.isGroup && Config.get('groupMentionOnly')) {
        const triggerWord = (Config.get('groupTriggerWord') || 'bot').toLowerCase();
        const msgText = (msg.text || '').toLowerCase().trim();

        // Check if message starts with trigger word (e.g. "bot, hello" or "bot hello")
        const triggeredByKeyword = msgText.startsWith(triggerWord + ',') ||
            msgText.startsWith(triggerWord + ' ') ||
            msgText.startsWith(triggerWord + ':') ||
            msgText === triggerWord;

        if (!msg.isMentioned && !triggeredByKeyword) {
            console.log('[Bot] Group message ignored (not mentioned, no trigger word)');
            logEntry.status = 'ignored (not mentioned in group)';
            sendToRenderer('log:update', logEntry);
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

        console.log(`[Bot] Group message accepted (mentioned=${msg.isMentioned}, triggered=${triggeredByKeyword})`);
    }

    // Check rate limit
    const rateCheck = humanBehavior.canSendMessage();
    if (!rateCheck.allowed) {
        console.log(`[Bot] Rate limited: ${rateCheck.reason}`);
        logEntry.status = `rate limited (retry in ${Math.round(rateCheck.retryAfterMs / 1000)}s)`;
        sendToRenderer('log:update', logEntry);
        return;
    }

    try {
        let responseResult;
        const chatId = msg.remoteJid; // Use conversation JID as chat ID

        // --- Handle media messages ---
        if (msg.hasMedia && msg.mediaType !== 'sticker') {
            const buffer = await whatsapp.downloadMedia(msg.rawMessage);
            if (buffer) {
                const savedFile = await fileManager.saveReceivedMedia(
                    buffer, msg.mimetype, msg.filename, msg.senderJid
                );

                // Notify UI of received file
                sendToRenderer('file:received', savedFile);

                // Process with Gemini (for images and documents)
                if (['image', 'document'].includes(msg.mediaType)) {
                    const filePrompt = msg.text || 'The user sent this file. Describe what you see and respond helpfully.';
                    responseResult = await gemini.processFile(
                        chatId, savedFile.path, msg.mimetype, filePrompt, msg.senderName
                    );
                } else {
                    responseResult = await gemini.generateResponse(
                        chatId,
                        `The user sent a ${msg.mediaType} file. ${msg.text || 'Acknowledge receipt and respond naturally.'}`,
                        msg.senderName
                    );
                }
            }
        }

        // --- Check for special commands ---
        const lowerText = (msg.text || '').toLowerCase().trim();

        // Clear chat history command
        if (lowerText === 'clear history' || lowerText === 'reset chat' || lowerText === 'forget everything' ||
            lowerText === 'start fresh' || lowerText === 'new conversation' || lowerText === 'clear memory' ||
            lowerText === 'hapus riwayat' || lowerText === 'reset' || lowerText === 'mulai baru') {
            gemini.clearHistory(chatId);
            const delays = await humanBehavior.calculateDelays(msg.text, 'Done!');
            await HumanBehavior.sleep(delays.readDelay);
            await whatsapp.markRead(msg.key);
            await HumanBehavior.sleep(delays.typingDelay);
            await whatsapp.setPresence(msg.remoteJid, 'composing');
            await HumanBehavior.sleep(500);
            await whatsapp.sendMessage(msg.remoteJid, '🔄 Chat history cleared! Starting fresh. How can I help you?');
            await whatsapp.setPresence(msg.remoteJid, 'paused');
            humanBehavior.recordMessageSent();
            addToLog({
                id: `resp_${Date.now()}`,
                timestamp: Date.now(),
                sender: 'Bot',
                remoteJid: msg.remoteJid,
                text: '🔄 Chat history cleared',
                direction: 'outgoing',
                status: 'sent',
            });
            return;
        }

        // Image generation request
        if (!responseResult && (lowerText.startsWith('generate image') || lowerText.startsWith('create image') ||
            lowerText.startsWith('draw ') || lowerText.startsWith('make an image'))) {
            responseResult = await gemini.generateImage(chatId, msg.text);
        }

        // Schedule request
        if (!responseResult && (lowerText.includes('schedule') || lowerText.includes('reminder') ||
            lowerText.includes('calendar') || lowerText.includes('meeting'))) {
            if (calendar.isConnected()) {
                const eventData = await gemini.parseScheduleRequest(chatId, msg.text);
                if (eventData) {
                    try {
                        const event = await calendar.createEvent(eventData);
                        responseResult = await gemini.generateResponse(
                            chatId,
                            `[System: Calendar event created successfully. Title: "${event.title}", Start: ${event.start}, Link: ${event.link}. Inform the user naturally.]`,
                            msg.senderName
                        );
                    } catch (calErr) {
                        responseResult = { text: `I tried to create a calendar event but encountered an error: ${calErr.message}` };
                    }
                }
            }
        }

        // Google Maps location search
        // Skip if the message ALSO contains reminder/send-to intent — let the AI handle combined requests
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
            // Extract the place/query from the message
            const placeMatch = msg.text.match(/(?:find on map|search map|google maps|where is|location of|directions to|navigate to|find location|maps search|search location|lokasi)\s*[:\-]?\s*(.+)/i);
            const query = placeMatch?.[1]?.trim() || msg.text;

            responseResult = await gemini.searchGoogleMaps(chatId, query, msg.senderName);
        }

        // Generate file request — comprehensive detection
        // Checks explicit phrases + contextual patterns like "... in excel" or "... ke pdf"
        const fileKeywords = ['excel', 'spreadsheet', 'xlsx', 'xls', '.pdf', 'pptx', 'powerpoint'];
        const hasFileTypeWord = fileKeywords.some(kw => lowerText.includes(kw));
        const hasFileAction = ['create', 'make', 'generate', 'write', 'send', 'build', 'buat', 'bikin', 'kirim', 'list', 'daftar', 'data'].some(kw => lowerText.includes(kw));
        const hasFileContext = [' in excel', ' in pdf', ' in pptx', ' ke excel', ' ke pdf', ' dalam excel', ' dalam pdf',
            ' format excel', ' format pdf', ' format xlsx', ' format csv', ' to excel', ' to pdf', ' as excel', ' as pdf',
            ' jadi excel', ' jadi pdf'].some(kw => lowerText.includes(kw));

        if (!responseResult && (
            // Explicit file creation phrases
            lowerText.includes('generate file') || lowerText.includes('create file') ||
            lowerText.includes('make a file') || lowerText.includes('write a file') ||
            lowerText.includes('create a pdf') || lowerText.includes('generate a pdf') ||
            lowerText.includes('create a document') || lowerText.includes('write a document') ||
            lowerText.includes('create a spreadsheet') || lowerText.includes('create an excel') ||
            lowerText.includes('create a csv') || lowerText.includes('write a csv') ||
            lowerText.includes('create a text') || lowerText.includes('write a text') ||
            lowerText.includes('create a report') || lowerText.includes('generate a report') ||
            lowerText.includes('create a presentation') || lowerText.includes('make a presentation') ||
            lowerText.includes('make an excel') || lowerText.includes('make a pdf') ||
            lowerText.includes('generate excel') || lowerText.includes('generate spreadsheet') ||
            lowerText.includes('send me a file') || lowerText.includes('buatkan file') ||
            lowerText.includes('buat file') || lowerText.includes('buat excel') ||
            lowerText.includes('buat pdf') || lowerText.includes('buat dokumen') ||
            // Contextual: "... in excel", "... ke pdf", "... format xlsx"
            hasFileContext ||
            // Smart: file type word + action word together (e.g. "list countries excel")
            (hasFileTypeWord && hasFileAction)
        )) {
            // Try to extract filename from the message
            const filenameMatch = msg.text.match(/(?:named?|called?|filename:?|save\s+(?:as|to))\s*[\"\'"]?([^\s\"\'",]+\.\w{2,5})/i);
            let filename = filenameMatch?.[1];

            // Auto-detect filename/extension from context if not specified
            if (!filename) {
                if (lowerText.includes('pdf')) filename = `document_${Date.now()}.pdf`;
                else if (lowerText.includes('excel') || lowerText.includes('spreadsheet') || lowerText.includes('.xlsx')) filename = `spreadsheet_${Date.now()}.xlsx`;
                else if (lowerText.includes('csv')) filename = `data_${Date.now()}.csv`;
                else if (lowerText.includes('presentation') || lowerText.includes('ppt')) filename = `presentation_${Date.now()}.pptx`;
                else if (lowerText.includes('html') || lowerText.includes('web page')) filename = `page_${Date.now()}.html`;
                else if (lowerText.includes('json')) filename = `data_${Date.now()}.json`;
                else if (lowerText.includes('word') || lowerText.includes('.doc')) filename = `document_${Date.now()}.txt`;
                else filename = `generated_${Date.now()}.txt`;
            }

            // Detect MIME type from filename
            const ext = path.extname(filename).toLowerCase();
            const mimeMap = {
                '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
                '.json': 'application/json', '.pdf': 'application/pdf',
                '.doc': 'application/msword',
                '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                '.xls': 'application/vnd.ms-excel',
                '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                '.ppt': 'application/vnd.ms-powerpoint',
                '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            };
            const mimetype = mimeMap[ext] || 'text/plain';

            // Ask Gemini to generate file data
            responseResult = await gemini.generateFile(chatId, msg.text, filename, mimetype);

            // For binary formats, Gemini returns structuredData — create the real binary file
            if (responseResult?.structuredData) {
                try {
                    let fileResult;
                    if (responseResult.format === '.xlsx' || responseResult.format === '.xls') {
                        fileResult = await fileManager.createExcelFile(filename, responseResult.structuredData);
                    } else if (responseResult.format === '.pdf') {
                        fileResult = await fileManager.createPdfFile(filename, responseResult.structuredData);
                    } else if (responseResult.format === '.pptx' || responseResult.format === '.ppt') {
                        fileResult = await fileManager.createPptxFile(filename, responseResult.structuredData);
                    }

                    if (fileResult) {
                        responseResult.filePath = fileResult.path;
                        responseResult.mimetype = fileResult.mimetype;
                    }
                } catch (fileErr) {
                    console.error('[Bot] Binary file creation error:', fileErr);
                    responseResult = {
                        text: `⚠️ Failed to create the ${ext} file: ${fileErr.message}`,
                        error: true,
                    };
                }
            }

            // Send if file was generated
            if (responseResult?.filePath) {
                const caption = responseResult.caption || `📎 ${filename}`;
                const delays = await humanBehavior.calculateDelays(msg.text, caption);
                await HumanBehavior.sleep(delays.readDelay);
                await whatsapp.markRead(msg.key);
                await whatsapp.setPresence(msg.remoteJid, 'composing');
                await HumanBehavior.sleep(delays.typingDelay);

                await whatsapp.sendFile(msg.remoteJid, responseResult.filePath, {
                    caption,
                    mimetype: responseResult.mimetype,
                    filename: responseResult.filename,
                });

                await whatsapp.setPresence(msg.remoteJid, 'paused');
                humanBehavior.recordMessageSent();
                addToLog({
                    id: `resp_${Date.now()}`,
                    timestamp: Date.now(),
                    sender: 'Bot',
                    remoteJid: msg.remoteJid,
                    text: `📎 Sent file: ${responseResult.filename} — "${caption}"`,
                    direction: 'outgoing',
                    status: 'sent',
                });
                return;
            }
        }

        // --- Default: regular text response ---
        if (!responseResult) {
            responseResult = await gemini.generateResponse(chatId, msg.text || '[Empty message]', msg.senderName);
        }

        if (responseResult.error) {
            console.error('[Bot] Gemini error:', responseResult.text);
            logEntry.status = 'error';
            sendToRenderer('log:update', logEntry);
            return;
        }

        // --- Detect [CREATE_FILE:type:filename] tag in AI response ---
        const fileTagMatch = responseResult.text?.match(/\[CREATE_FILE:(\w+):([^\]]+)\]/);
        if (fileTagMatch) {
            const fileType = fileTagMatch[1].toLowerCase(); // excel, pdf, pptx, csv, txt, html, json
            const fileName = fileTagMatch[2].trim();
            let caption = responseResult.text.replace(/\[CREATE_FILE:[^\]]+\]/g, '').trim();

            console.log(`[Bot] AI requested file creation: type=${fileType}, name=${fileName}`);

            try {
                // Map file type to extension and MIME
                const typeMap = {
                    excel: { ext: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
                    pdf: { ext: '.pdf', mime: 'application/pdf' },
                    pptx: { ext: '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
                    csv: { ext: '.csv', mime: 'text/csv' },
                    txt: { ext: '.txt', mime: 'text/plain' },
                    html: { ext: '.html', mime: 'text/html' },
                    json: { ext: '.json', mime: 'application/json' },
                };
                const typeInfo = typeMap[fileType] || typeMap.txt;
                const isBinary = ['excel', 'pdf', 'pptx'].includes(fileType);

                let filePath;

                if (isBinary) {
                    // Generate structured data for binary formats
                    const structuredResult = await gemini.generateStructuredFileData(chatId, msg.text, typeInfo.ext);
                    if (structuredResult.error) {
                        await whatsapp.sendMessage(msg.remoteJid, `⚠️ File generation failed. ${structuredResult.text}`);
                        return;
                    }

                    let fileResult;
                    if (fileType === 'excel') {
                        fileResult = await fileManager.createExcelFile(fileName, structuredResult.data);
                    } else if (fileType === 'pdf') {
                        fileResult = await fileManager.createPdfFile(fileName, structuredResult.data);
                    } else if (fileType === 'pptx') {
                        fileResult = await fileManager.createPptxFile(fileName, structuredResult.data);
                    }
                    filePath = fileResult.path;
                } else {
                    // For text-based formats, generate content directly
                    const textResult = await gemini.generateFile(chatId, msg.text, fileName, typeInfo.mime);
                    if (textResult.error) {
                        await whatsapp.sendMessage(msg.remoteJid, `⚠️ File generation failed. ${textResult.text}`);
                        return;
                    }
                    filePath = textResult.filePath;
                }

                // Determine recipient: check if SEND_TO tag is also present
                let recipientJid = msg.remoteJid;
                let recipientName = null;
                const sendToInFile = responseResult.text?.match(/\[SEND_TO:([^:]+):([^\]]*)\]/);
                if (sendToInFile) {
                    const sendTarget = sendToInFile[1].trim();
                    // Resolve target using same logic as SEND_TO handler
                    const savedContacts = Config.get('savedContacts') || [];
                    const shortcodeTarget = sendTarget.startsWith('+') ? sendTarget.toLowerCase() : `+${sendTarget}`.toLowerCase();
                    const savedByShortcode = savedContacts.find(c => c.shortcode.toLowerCase() === shortcodeTarget);
                    const savedByName = !savedByShortcode ? savedContacts.find(c => c.name.toLowerCase() === sendTarget.toLowerCase()) : null;
                    const savedContact = savedByShortcode || savedByName;

                    if (savedContact) {
                        let phone = savedContact.phone;
                        if (phone.startsWith('0')) phone = '62' + phone.substring(1);
                        phone = phone.replace(/[^\d]/g, '');
                        recipientJid = `${phone}@s.whatsapp.net`;
                        recipientName = savedContact.name;
                    } else if (/^\d+$/.test(sendTarget)) {
                        let num = sendTarget;
                        if (num.startsWith('0')) num = '62' + num.substring(1);
                        recipientJid = `${num}@s.whatsapp.net`;
                        recipientName = num;
                    } else {
                        const matches = whatsapp.findContactByName(sendTarget);
                        if (matches.length > 0) {
                            recipientJid = matches[0].jid;
                            recipientName = matches[0].name || sendTarget;
                        }
                    }
                    // Strip SEND_TO tag from caption too
                    caption = caption.replace(/\[SEND_TO:[^\]]+\]/g, '').trim();
                }

                // Send the file
                const delays = await humanBehavior.calculateDelays(msg.text, caption);
                await HumanBehavior.sleep(delays.readDelay);
                await whatsapp.markRead(msg.key);
                await whatsapp.setPresence(msg.remoteJid, 'composing');
                await HumanBehavior.sleep(delays.typingDelay);

                await whatsapp.sendFile(recipientJid, filePath, {
                    caption: caption || `📎 ${fileName}`,
                    mimetype: typeInfo.mime,
                    filename: fileName,
                });

                // If sent to someone else, confirm to the requester
                if (recipientName && recipientJid !== msg.remoteJid) {
                    await whatsapp.sendMessage(msg.remoteJid, `✅ File "${fileName}" sent to ${recipientName}!`);
                }

                await whatsapp.setPresence(msg.remoteJid, 'paused');
                humanBehavior.recordMessageSent();
                addToLog({
                    id: `resp_${Date.now()}`,
                    timestamp: Date.now(),
                    sender: 'Bot',
                    remoteJid: recipientJid,
                    text: `📎 Sent ${fileType}: ${fileName}${recipientName ? ` → ${recipientName}` : ''}`,
                    direction: 'outgoing',
                    status: 'sent',
                });
                return;
            } catch (fileErr) {
                console.error('[Bot] File creation from tag failed:', fileErr);
                await whatsapp.sendMessage(msg.remoteJid, `⚠️ Sorry, I couldn't create the file: ${fileErr.message}`);
                return;
            }
        }

        // --- Detect [IMAGE_GEN: prompt] tag in AI response ---
        const imageGenTagMatch = responseResult.text?.match(/\[IMAGE_GEN:\s*([^\]]+)\]/);
        if (imageGenTagMatch) {
            const imagePrompt = imageGenTagMatch[1].trim();
            const cleanText = responseResult.text.replace(/\[IMAGE_GEN:[^\]]+\]/g, '').trim();

            console.log(`[Bot] AI requested image generation: "${imagePrompt}"`);

            try {
                const imageResult = await gemini.generateImage(chatId, imagePrompt);

                if (imageResult?.imagePath) {
                    const delays = await humanBehavior.calculateDelays(msg.text, cleanText || '📸');
                    await HumanBehavior.sleep(delays.readDelay);
                    await whatsapp.markRead(msg.key);
                    await whatsapp.setPresence(msg.remoteJid, 'composing');
                    await HumanBehavior.sleep(delays.typingDelay);

                    await whatsapp.sendFile(msg.remoteJid, imageResult.imagePath, {
                        caption: cleanText || '📸',
                        mimetype: imageResult.mimeType || 'image/png',
                    });

                    await whatsapp.setPresence(msg.remoteJid, 'paused');
                    humanBehavior.recordMessageSent();
                    addToLog({
                        id: `resp_${Date.now()}`,
                        timestamp: Date.now(),
                        sender: 'Bot',
                        remoteJid: msg.remoteJid,
                        text: `🎨 Generated image: "${imagePrompt}"`,
                        direction: 'outgoing',
                        status: 'sent',
                    });
                    return;
                } else {
                    // Image generation failed — send the clean text with an error note
                    responseResult.text = cleanText || '⚠️ Image generation failed, please try again.';
                }
            } catch (imgErr) {
                console.error('[Bot] IMAGE_GEN tag handler failed:', imgErr);
                responseResult.text = cleanText || '⚠️ Image generation failed, please try again.';
            }
        }

        // --- Detect [REMINDER:time:message] tag in AI response ---
        const reminderTagMatch = responseResult.text?.match(/\[REMINDER:([^:]+):([^\]]+)\]/);
        if (reminderTagMatch) {
            const timeExpr = reminderTagMatch[1].trim();
            const reminderMessage = reminderTagMatch[2].trim();
            const cleanText = responseResult.text.replace(/\[REMINDER:[^\]]+\]/g, '').trim();

            console.log(`[Bot] AI requested reminder: time="${timeExpr}", message="${reminderMessage}"`);

            const dueDate = Scheduler.parseTime(timeExpr);
            if (dueDate) {
                Scheduler.addTask({
                    targetJid: msg.remoteJid,
                    message: reminderMessage,
                    dueAt: dueDate.toISOString(),
                    createdBy: msg.senderName || msg.senderJid,
                    type: 'reminder',
                });

                // Send confirmation to user (strip the tag)
                const delays = await humanBehavior.calculateDelays(msg.text, cleanText);
                await HumanBehavior.sleep(delays.readDelay);
                await whatsapp.markRead(msg.key);
                await whatsapp.setPresence(msg.remoteJid, 'composing');
                await HumanBehavior.sleep(delays.typingDelay);
                await whatsapp.sendMessage(msg.remoteJid, cleanText || `⏰ Reminder set for ${dueDate.toLocaleTimeString()}!`);
                await whatsapp.setPresence(msg.remoteJid, 'paused');
                humanBehavior.recordMessageSent();
                addToLog({
                    id: `resp_${Date.now()}`,
                    timestamp: Date.now(),
                    sender: 'Bot',
                    remoteJid: msg.remoteJid,
                    text: `⏰ Reminder set: "${reminderMessage}" at ${dueDate.toLocaleString()}`,
                    direction: 'outgoing',
                    status: 'sent',
                });
                return;
            } else {
                // Couldn't parse time — send the message as-is
                console.warn(`[Bot] Could not parse reminder time: "${timeExpr}"`);
            }
        }

        // --- Detect [SEND_TO:name_or_number:message] tag in AI response ---
        const sendToTagMatch = responseResult.text?.match(/\[SEND_TO:([^:]+):([^\]]*)\]/);
        if (sendToTagMatch) {
            let target = sendToTagMatch[1].trim();
            const messageToSend = sendToTagMatch[2].trim();
            const cleanText = responseResult.text.replace(/\[SEND_TO:[^\]]+\]/g, '').trim();

            let targetJid = null;
            let displayName = target;

            // --- Step 1: Check saved contacts (shortcodes like +Novita, or by name) ---
            const savedContacts = Config.get('savedContacts') || [];
            const shortcodeTarget = target.startsWith('+') ? target.toLowerCase() : `+${target}`.toLowerCase();
            const savedByShortcode = savedContacts.find(c => c.shortcode.toLowerCase() === shortcodeTarget);
            const savedByName = !savedByShortcode ? savedContacts.find(c => c.name.toLowerCase() === target.toLowerCase()) : null;
            const savedContact = savedByShortcode || savedByName;

            if (savedContact) {
                let phone = savedContact.phone;
                if (phone.startsWith('0')) phone = '62' + phone.substring(1);
                phone = phone.replace(/[^\d]/g, ''); // Strip non-digits
                targetJid = `${phone}@s.whatsapp.net`;
                displayName = savedContact.name;
                console.log(`[Bot] Resolved via contact book: "${target}" → ${displayName} (${phone})`);
            }
            // --- Step 2: Check if it's a raw phone number ---
            else if (/^\d+$/.test(target)) {
                if (target.startsWith('0')) {
                    target = '62' + target.substring(1);
                }
                targetJid = `${target}@s.whatsapp.net`;
                displayName = target;
            }
            // --- Step 3: Search live WhatsApp contacts by name ---
            else {
                const matches = whatsapp.findContactByName(target);
                if (matches.length > 0) {
                    targetJid = matches[0].jid;
                    displayName = matches[0].name || matches[0].pushName || target;
                    console.log(`[Bot] Contact lookup: "${target}" → ${displayName} (${targetJid}) [score: ${matches[0].matchScore}]`);
                } else {
                    console.log(`[Bot] Contact not found: "${target}". Known contacts: ${whatsapp.getContacts().length}`);
                    await whatsapp.sendMessage(msg.remoteJid,
                        `⚠️ I couldn't find a contact named "${target}". Please provide their phone number instead, or make sure they've chatted with this WhatsApp account before so I can learn their name.`
                    );
                    return;
                }
            }

            console.log(`[Bot] AI requested send-to: target="${displayName}", jid=${targetJid}, message="${messageToSend}", hasMedia=${msg.hasMedia}`);

            try {
                const delays = await humanBehavior.calculateDelays(msg.text, cleanText);
                await HumanBehavior.sleep(delays.readDelay);
                await whatsapp.markRead(msg.key);

                // --- If original message has media, forward it ---
                if (msg.hasMedia && msg.rawMessage) {
                    console.log(`[Bot] Forwarding ${msg.mediaType} to ${displayName}...`);
                    const mediaBuffer = await whatsapp.downloadMedia(msg.rawMessage);
                    if (mediaBuffer) {
                        const caption = messageToSend || msg.text?.replace(/\[SEND_TO:[^\]]+\]/g, '').trim() || '';
                        const sendPayload = {};

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
                        } else if (msg.mediaType === 'document') {
                            sendPayload.document = mediaBuffer;
                            sendPayload.caption = caption;
                            sendPayload.mimetype = msg.mimetype || 'application/octet-stream';
                            sendPayload.fileName = msg.filename || 'file';
                        } else {
                            // Fallback: send as document
                            sendPayload.document = mediaBuffer;
                            sendPayload.caption = caption;
                            sendPayload.mimetype = msg.mimetype || 'application/octet-stream';
                        }

                        await whatsapp.sock.sendMessage(targetJid, sendPayload);
                        whatsapp._trackSentMessage({ key: { id: `fwd_${Date.now()}` } });
                    } else {
                        console.error('[Bot] Failed to download media for forwarding');
                        await whatsapp.sendMessage(msg.remoteJid, `⚠️ Could not download the media to forward to ${displayName}.`);
                        return;
                    }
                }
                // --- Otherwise send text message ---
                else if (messageToSend) {
                    await whatsapp.sendMessage(targetJid, messageToSend);
                } else {
                    await whatsapp.sendMessage(msg.remoteJid, `⚠️ No message or media to send to ${displayName}.`);
                    return;
                }

                // Confirm to the requester
                await whatsapp.setPresence(msg.remoteJid, 'composing');
                await HumanBehavior.sleep(delays.typingDelay);
                const confirmMsg = msg.hasMedia
                    ? `✅ ${msg.mediaType === 'image' ? '📷 Image' : msg.mediaType === 'video' ? '🎥 Video' : '📎 File'} sent to ${displayName}!`
                    : `✅ Message sent to ${displayName}!`;
                await whatsapp.sendMessage(msg.remoteJid, cleanText || confirmMsg);
                await whatsapp.setPresence(msg.remoteJid, 'paused');
                humanBehavior.recordMessageSent();

                addToLog({
                    id: `resp_${Date.now()}`,
                    timestamp: Date.now(),
                    sender: 'Bot',
                    remoteJid: msg.remoteJid,
                    text: `📨 ${msg.hasMedia ? 'Forwarded media' : 'Sent'} to ${displayName}`,
                    direction: 'outgoing',
                    status: 'sent',
                });
                return;
            } catch (sendErr) {
                console.error('[Bot] Send-to failed:', sendErr);
                await whatsapp.sendMessage(msg.remoteJid, `⚠️ Failed to send message to ${displayName}: ${sendErr.message}`);
                return;
            }
        }

        // --- Fallback: detect when AI outputs structured JSON data as text ---
        // This catches responses like ```json { "headers": [...], "rows": [...] } ```
        if (responseResult?.text && !responseResult.filePath && !responseResult.imagePath) {
            const text = responseResult.text.trim();
            // Check if response looks like JSON (with or without markdown fences)
            const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ||
                (text.startsWith('{') && text.endsWith('}') ? [null, text] : null);

            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

                    // Detect Excel-like data (has headers+rows or data array)
                    const isExcelData = (parsed.headers && parsed.rows) ||
                        (Array.isArray(parsed.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]));
                    // Detect PDF-like data
                    const isPdfData = parsed.sections && Array.isArray(parsed.sections);
                    // Detect PPTX-like data
                    const isPptxData = parsed.slides && Array.isArray(parsed.slides);

                    if (isExcelData || isPdfData || isPptxData) {
                        console.log('[Bot] Auto-detected structured JSON in response, creating file...');
                        const caption = parsed.caption || '📎 Here\'s your file!';

                        try {
                            let fileResult;
                            if (isExcelData) {
                                // Normalize data format
                                const excelData = {
                                    title: parsed.title || 'Sheet1',
                                    headers: parsed.headers || (Array.isArray(parsed.data?.[0]) ? parsed.data[0] : []),
                                    rows: parsed.rows || (Array.isArray(parsed.data) ? parsed.data.slice(1) : []),
                                };
                                // Ensure all values are strings
                                excelData.headers = excelData.headers.map(h => String(h));
                                excelData.rows = excelData.rows.map(row =>
                                    (Array.isArray(row) ? row : [row]).map(cell => String(cell))
                                );
                                const fname = `spreadsheet_${Date.now()}.xlsx`;
                                fileResult = await fileManager.createExcelFile(fname, excelData);
                            } else if (isPdfData) {
                                const fname = `document_${Date.now()}.pdf`;
                                fileResult = await fileManager.createPdfFile(fname, parsed);
                            } else if (isPptxData) {
                                const fname = `presentation_${Date.now()}.pptx`;
                                fileResult = await fileManager.createPptxFile(fname, parsed);
                            }

                            if (fileResult) {
                                const delays = await humanBehavior.calculateDelays(msg.text, caption);
                                await HumanBehavior.sleep(delays.readDelay);
                                await whatsapp.markRead(msg.key);
                                await whatsapp.setPresence(msg.remoteJid, 'composing');
                                await HumanBehavior.sleep(delays.typingDelay);

                                await whatsapp.sendFile(msg.remoteJid, fileResult.path, {
                                    caption,
                                    mimetype: fileResult.mimetype,
                                    filename: fileResult.filename,
                                });

                                await whatsapp.setPresence(msg.remoteJid, 'paused');
                                humanBehavior.recordMessageSent();
                                addToLog({
                                    id: `resp_${Date.now()}`,
                                    timestamp: Date.now(),
                                    sender: 'Bot',
                                    remoteJid: msg.remoteJid,
                                    text: `📎 Auto-created file: ${fileResult.filename}`,
                                    direction: 'outgoing',
                                    status: 'sent',
                                });
                                return;
                            }
                        } catch (autoFileErr) {
                            console.error('[Bot] Auto file creation failed:', autoFileErr);
                            // Fall through to send as text
                        }
                    }
                } catch (e) {
                    // Not valid JSON, continue as normal text
                }
            }
        }

        // --- Apply human-like delays ---
        const delays = await humanBehavior.calculateDelays(msg.text, responseResult.text);

        // Phase 1: Read delay (mark as read after delay)
        await HumanBehavior.sleep(delays.readDelay);
        await whatsapp.markRead(msg.key);

        // Phase 2: Thinking pause
        await HumanBehavior.sleep(delays.thinkingPause);

        // Phase 3: Typing indicator
        await whatsapp.setPresence(msg.remoteJid, 'composing');
        await HumanBehavior.sleep(delays.typingDelay);

        // Phase 4: Send response
        if (responseResult.imagePath) {
            // Send generated image with AI text as caption
            await whatsapp.sendFile(msg.remoteJid, responseResult.imagePath, {
                caption: responseResult.text || '',
                mimetype: responseResult.mimeType,
            });
        } else if (responseResult.filePath) {
            // Send a generated file with caption
            await whatsapp.sendFile(msg.remoteJid, responseResult.filePath, {
                caption: responseResult.caption || responseResult.text || '',
                mimetype: responseResult.mimetype,
                filename: responseResult.filename,
            });
        } else {
            await whatsapp.sendMessage(msg.remoteJid, responseResult.text);
        }

        // Clear typing indicator
        await whatsapp.setPresence(msg.remoteJid, 'paused');

        humanBehavior.recordMessageSent();

        // Log the response
        addToLog({
            id: `resp_${Date.now()}`,
            timestamp: Date.now(),
            sender: 'Bot',
            remoteJid: msg.remoteJid,
            text: responseResult.text?.substring(0, 200),
            direction: 'outgoing',
            status: 'sent',
            delays: {
                read: delays.readDelay,
                thinking: delays.thinkingPause,
                typing: delays.typingDelay,
                total: delays.totalDelay,
            },
            keyIndex: responseResult.keyIndex,
        });

    } catch (err) {
        console.error('[Bot] Message handling error:', err);
        logEntry.status = `error: ${err.message}`;
        sendToRenderer('log:update', logEntry);
    }
}

// --- Helper Functions ---
function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

function addToLog(entry) {
    messageLog.unshift(entry);
    if (messageLog.length > 200) messageLog.pop();
    sendToRenderer('log:new', entry);
}

// --- IPC Handlers ---
function setupIPC() {
    // WhatsApp
    ipcMain.handle('whatsapp:connect', async () => {
        try {
            await whatsapp.connect();
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('whatsapp:disconnect', async () => {
        await whatsapp.disconnect();
        return { success: true };
    });

    ipcMain.handle('whatsapp:status', () => whatsapp.getStatus());

    ipcMain.handle('whatsapp:sendMessage', async (_, jid, text) => {
        try {
            await whatsapp.sendMessage(jid, text);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Gemini
    ipcMain.handle('gemini:testKey', async (_, key) => {
        return await gemini.testKey(key);
    });

    ipcMain.handle('gemini:addKey', (_, key) => {
        try {
            return { success: true, keys: Config.addGeminiKey(key) };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('gemini:removeKey', (_, index) => {
        try {
            return { success: true, keys: Config.removeGeminiKey(index) };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('gemini:getKeys', () => {
        const keys = Config.getGeminiKeys();
        return keys.map((k, i) => ({
            index: i,
            masked: `${k.substring(0, 8)}...${k.substring(k.length - 4)}`,
            isActive: i === (Config.get('activeKeyIndex') || 0),
            usage: Config.getKeyUsage()[k] || { used: 0 },
        }));
    });

    ipcMain.handle('gemini:chat', async (_, chatId, message) => {
        return await gemini.generateResponse(chatId, message);
    });

    ipcMain.handle('gemini:clearHistory', (_, chatId) => {
        if (chatId) {
            gemini.clearHistory(chatId);
        } else {
            gemini.clearAllHistories();
        }
        return { success: true };
    });

    ipcMain.handle('gemini:clearAllHistories', () => {
        gemini.clearAllHistories();
        return { success: true };
    });

    // Calendar
    ipcMain.handle('calendar:setCredentials', async (_, creds) => {
        return { success: calendar.setCredentials(creds) };
    });

    ipcMain.handle('calendar:getAuthUrl', () => {
        const url = calendar.getAuthUrl();
        return { url };
    });

    ipcMain.handle('calendar:exchangeCode', async (_, code) => {
        try {
            await calendar.exchangeCode(code);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('calendar:isConnected', () => calendar.isConnected());

    ipcMain.handle('calendar:listEvents', async () => {
        try {
            const events = await calendar.listEvents();
            return { success: true, events };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Config
    ipcMain.handle('config:get', (_, key) => Config.get(key));
    ipcMain.handle('config:set', (_, key, value) => {
        Config.set(key, value);
        return { success: true };
    });
    ipcMain.handle('config:getAll', () => Config.getAll());
    ipcMain.handle('config:getBehavior', () => Config.getBehavior());
    ipcMain.handle('config:updateBehavior', (_, updates) => {
        Config.updateBehavior(updates);
        return { success: true };
    });

    // Logs
    ipcMain.handle('logs:get', () => messageLog);
    ipcMain.handle('logs:clear', () => {
        messageLog = [];
        return { success: true };
    });

    // File Manager
    ipcMain.handle('files:list', (_, type) => fileManager.listReceivedFiles(type));
    ipcMain.handle('files:cleanup', () => {
        const cleaned = fileManager.cleanupOldFiles();
        return { cleaned };
    });

    // Open external links
    ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url));

    // File dialog
    ipcMain.handle('dialog:openFile', async (_, options) => {
        const result = await dialog.showOpenDialog(mainWindow, options);
        return result;
    });

    ipcMain.handle('dialog:saveFile', async (_, options) => {
        const result = await dialog.showSaveDialog(mainWindow, options);
        return result;
    });

    // --- Uninstall / Config Management ---
    ipcMain.handle('app:exportConfig', async () => {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Configuration',
            defaultPath: path.join(os.homedir(), 'Desktop', 'gemini-whatsapp-bot-config.json'),
            filters: [
                { name: 'JSON', extensions: ['json'] },
                { name: 'XML', extensions: ['xml'] },
            ],
        });
        if (result.canceled || !result.filePath) return { success: false };
        try {
            Config.exportConfig(result.filePath);
            return { success: true, path: result.filePath };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('app:importConfig', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Import Configuration',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths.length) return { success: false };
        try {
            Config.importConfig(result.filePaths[0]);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('app:uninstall', async (_, { saveConfig }) => {
        try {
            // 1. Export config if user chose to save
            let exportPath = null;
            if (saveConfig) {
                exportPath = path.join(os.homedir(), 'Desktop', 'gemini-whatsapp-bot-config.json');
                Config.exportConfig(exportPath);
            }

            // 2. Disconnect WhatsApp
            if (whatsapp) {
                await whatsapp.disconnect().catch(() => { });
            }

            // 3. Delete WhatsApp session
            const sessionPath = Config.get('whatsappSessionPath');
            if (sessionPath && fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }

            // 4. Delete downloaded files
            const filesDir = Config.get('filesDirectory');
            if (filesDir && fs.existsSync(filesDir)) {
                fs.rmSync(filesDir, { recursive: true, force: true });
            }

            // 5. Clear config store
            Config.clearAll();

            // 6. Move app to Trash (if running as packaged app)
            const appPath = app.getAppPath();
            const isPackaged = !appPath.includes('node_modules');
            if (isPackaged) {
                const appBundlePath = path.resolve(appPath, '..', '..');
                if (appBundlePath.endsWith('.app')) {
                    shell.trashItem(appBundlePath);
                }
            }

            // 7. Quit
            setTimeout(() => app.quit(), 500);

            return { success: true, exportPath };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
}

// --- App Lifecycle ---
app.whenReady().then(() => {
    initializeServices();
    setupIPC();
    createWindow();

    // Cleanup old files on startup
    fileManager.cleanupOldFiles();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async () => {
    // Save histories before quitting
    if (gemini) {
        gemini.saveHistories();
    }
});
