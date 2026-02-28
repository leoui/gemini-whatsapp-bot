const pino = require('pino');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const Config = require('./config');

// Dynamic import for ESM-only Baileys
let baileys = null;
async function loadBaileys() {
    if (!baileys) {
        baileys = await import('@whiskeysockets/baileys');
    }
    return baileys;
}

class WhatsAppService extends EventEmitter {
    constructor() {
        super();
        this.sock = null;
        this.qrCode = null;
        this.pairingCode = null;
        this.connectionState = 'disconnected';
        this.qrAttempts = 0;
        this.maxQrAttempts = 3; // After 3 QR failures, offer pairing code
        this.retryCount = 0;
        this.maxRetries = 5;
        this.logger = pino({ level: 'silent' });

        // Contact store: { jid: { name, pushName, notify } }
        this._contacts = new Map();

        // Keep-alive heartbeat interval
        this._keepAliveInterval = null;
        this._keepAliveMs = 45000; // 45 seconds

        // Track sent message IDs to prevent self-reply feedback loops
        this._sentMessageIds = new Set();
    }

    /**
     * Track a sent message ID so we can ignore it when echoed back.
     * Auto-expires after 30 seconds to prevent memory leaks.
     */
    _trackSentMessage(result) {
        if (result?.key?.id) {
            this._sentMessageIds.add(result.key.id);
            setTimeout(() => this._sentMessageIds.delete(result.key.id), 30000);
        }
    }

    async connect() {
        try {
            this.connectionState = 'connecting';
            this.emit('status', { state: 'connecting', message: 'Initializing...' });

            const { default: makeWASocket, useMultiFileAuthState, DisconnectReason,
                fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = await loadBaileys();

            const sessionPath = Config.get('whatsappSessionPath');
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, this.logger),
                },
                logger: this.logger,
                printQRInTerminal: false,
                browser: ['Chrome (Linux)', '', ''],
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                markOnlineOnConnect: false,
                connectTimeoutMs: 120000,
                keepAliveIntervalMs: 15000,
                retryRequestDelayMs: 3000,
                defaultQueryTimeoutMs: undefined,
                emitOwnEvents: false
            });

            this.sock.ev.on('connection.update', (update) => {
                this.handleConnectionUpdate(update);
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('messages.upsert', (upsert) => {
                this.handleMessagesUpsert(upsert);
            });

            // Track contacts
            this.sock.ev.on('contacts.upsert', (contacts) => {
                for (const c of contacts) {
                    this._contacts.set(c.id, {
                        jid: c.id,
                        name: c.name || c.verifiedName || c.notify || '',
                        pushName: c.notify || '',
                        verifiedName: c.verifiedName || '',
                    });
                }
                console.log(`[WhatsApp] Loaded ${contacts.length} contacts (total: ${this._contacts.size})`);
            });

            this.sock.ev.on('contacts.update', (updates) => {
                for (const u of updates) {
                    const existing = this._contacts.get(u.id) || { jid: u.id };
                    if (u.notify) existing.pushName = u.notify;
                    if (u.name) existing.name = u.name;
                    if (u.verifiedName) existing.verifiedName = u.verifiedName;
                    existing.name = existing.name || existing.pushName || existing.verifiedName || '';
                    this._contacts.set(u.id, existing);
                }
            });

            console.log('[WhatsApp] Connection initiated');
        } catch (err) {
            console.error('[WhatsApp] Connection error:', err.message);
            this.connectionState = 'disconnected';
            this.emit('status', { state: 'error', message: err.message });
            throw err;
        }
    }

    handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            this.qrAttempts++;
            this.qrCode = qr;
            this.connectionState = 'qr';
            this.emit('qr', qr);
            this.emit('status', { state: 'qr', message: `Scan QR code with WhatsApp (attempt ${this.qrAttempts}/${this.maxQrAttempts})` });
            console.log(`[WhatsApp] QR code generated (attempt ${this.qrAttempts}/${this.maxQrAttempts})`);

            // After maxQrAttempts, suggest pairing code
            if (this.qrAttempts >= this.maxQrAttempts) {
                const phoneNumber = Config.get('whatsappPhoneNumber') || process.env.WHATSAPP_PHONE_NUMBER || '';
                if (phoneNumber) {
                    console.log(`[WhatsApp] QR failed ${this.maxQrAttempts} times, auto-switching to pairing code...`);
                    this.requestPairingCode(phoneNumber);
                } else {
                    console.log(`[WhatsApp] QR failed ${this.maxQrAttempts} times. Set WHATSAPP_PHONE_NUMBER env for pairing code fallback.`);
                    this.emit('status', { 
                        state: 'qr_failed', 
                        message: `QR failed ${this.maxQrAttempts} times. Use pairing code instead — set WHATSAPP_PHONE_NUMBER env (digits only, with country code, e.g. 628123456789)` 
                    });
                }
            }
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = reason === 401;
            const shouldReconnect = !loggedOut;

            this._stopKeepAlive();
            console.log(`[WhatsApp] Connection closed. Reason: ${reason}. Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                this.retryCount++;
                this.connectionState = 'connecting';
                this.emit('status', {
                    state: 'reconnecting',
                    message: `Reconnecting... (attempt ${this.retryCount})`
                });
                // 408 = timeout, reconnect immediately; other errors use backoff
                const delay = (reason === 408) ? 1000 : Math.min(1000 * Math.pow(2, this.retryCount), 60000);
                setTimeout(() => this.connect(), delay);
            } else {
                this.connectionState = 'disconnected';
                this.emit('status', {
                    state: 'disconnected',
                    message: 'Logged out'
                });
            }
        }

        if (connection === 'open') {
            this.connectionState = 'connected';
            this.retryCount = 0;
            this.qrCode = null;
            this.pairingCode = null;
            this.qrAttempts = 0;

            // Keep-alive handled by Baileys internally (keepAliveIntervalMs: 15000)

            const user = this.sock.user;
            this.emit('status', {
                state: 'connected',
                message: `Connected as ${user?.name || user?.id || 'Unknown'}`,
                user: { id: user?.id, name: user?.name }
            });
            console.log(`[WhatsApp] Connected as ${user?.name || user?.id}`);
        }
    }

    _startKeepAlive() {
        this._stopKeepAlive();
        console.log(`[WhatsApp] Keep-alive started (every ${this._keepAliveMs / 1000}s)`);
        this._keepAliveInterval = setInterval(async () => {
            if (this.connectionState !== 'connected' || !this.sock) return;
            try {
                // Send presence update to keep connection alive
                await this.sock.sendPresenceUpdate('available');
                // Also ping the WS connection directly if available
                if (this.sock.ws?.socket?.ping) {
                    this.sock.ws.socket.ping();
                }
            } catch (err) {
                console.warn('[WhatsApp] Keep-alive ping failed:', err.message);
            }
        }, this._keepAliveMs);
    }

    _stopKeepAlive() {
        if (this._keepAliveInterval) {
            clearInterval(this._keepAliveInterval);
            this._keepAliveInterval = null;
            console.log('[WhatsApp] Keep-alive stopped');
        }
    }

    /**
     * Request a pairing code for phone number linking (alternative to QR).
     * Phone number must be digits only with country code, no +, (), or -.
     * e.g. "628123456789" for Indonesian number +62-812-3456-789
     */
    async requestPairingCode(phoneNumber) {
        if (!this.sock) {
            console.error('[WhatsApp] Cannot request pairing code: socket not initialized');
            return null;
        }

        // Clean phone number: remove +, -, (), spaces
        const cleanNumber = phoneNumber.replace(/[\s\+\-\(\)]/g, '');

        if (!/^\d{10,15}$/.test(cleanNumber)) {
            console.error(`[WhatsApp] Invalid phone number format: "${phoneNumber}" → "${cleanNumber}". Must be 10-15 digits with country code.`);
            this.emit('status', { 
                state: 'error', 
                message: `Invalid phone number: ${cleanNumber}. Use digits only with country code (e.g. 628123456789)` 
            });
            return null;
        }

        try {
            console.log(`[WhatsApp] Requesting pairing code for ${cleanNumber}...`);
            const code = await this.sock.requestPairingCode(cleanNumber);
            this.pairingCode = code;
            this.connectionState = 'pairing';

            // Format code with dash for readability: ABCD-EFGH
            const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;

            console.log(`[WhatsApp] ════════════════════════════════════════`);
            console.log(`[WhatsApp] 📱 PAIRING CODE: ${formattedCode}`);
            console.log(`[WhatsApp] ════════════════════════════════════════`);
            console.log(`[WhatsApp] Open WhatsApp → Linked Devices → Link with phone number`);
            console.log(`[WhatsApp] Enter the code above to connect.`);

            this.emit('pairing_code', { code, formatted: formattedCode });
            this.emit('status', { 
                state: 'pairing', 
                message: `Enter pairing code in WhatsApp: ${formattedCode}`,
                pairingCode: formattedCode
            });

            return code;
        } catch (err) {
            console.error(`[WhatsApp] Pairing code request failed:`, err.message);
            this.emit('status', { 
                state: 'error', 
                message: `Pairing code failed: ${err.message}` 
            });
            return null;
        }
    }

    handleMessagesUpsert(upsert) {
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
            console.log(`[WhatsApp] DEBUG: Message arrived from ${msg.key.remoteJid}`);
            // --- SELF-MESSAGE FILTERS (prevent feedback loops) ---

            // 1. Skip status broadcasts
            if (msg.key.remoteJid === 'status@broadcast') continue;

            // 2. Skip messages flagged as fromMe
            if (msg.key.fromMe) continue;

            // 3. Double-check: skip if sender JID matches the bot's own JID
            const botJid = this.getBotJid();
            const senderJid = msg.key.participant || msg.key.remoteJid;
            if (botJid && senderJid) {
                const botNumber = botJid.split('@')[0].split(':')[0];
                const senderNumber = senderJid.split('@')[0].split(':')[0];
                if (botNumber === senderNumber) {
                    continue; // This is our own message echoed back
                }
            }

            // 4. Skip protocol messages, reactions, and ephemeral updates
            const message = msg.message;
            if (!message) continue;
            if (message.protocolMessage) continue;
            if (message.reactionMessage) continue;
            if (message.senderKeyDistributionMessage && !message.conversation && !message.extendedTextMessage) continue;

            // 5. Skip messages we recently sent (track by message ID)
            if (this._sentMessageIds && this._sentMessageIds.has(msg.key.id)) {
                continue;
            }

            // 6. Skip if auto-reply is disabled or contact not allowed
            if (!Config.get('autoReplyEnabled')) {
                console.log(`[WhatsApp] Skipping message from ${msg.key.remoteJid}: autoReplyEnabled=false`);
                continue;
            }
            if (!Config.isContactAllowed(msg.key.remoteJid)) {
                console.log(`[WhatsApp] Skipping message from ${msg.key.remoteJid}: Contact not in Allowed List or is Blocked`);
                continue;
            }

            // Track this contact's pushName for name-based lookups
            this.trackContactFromMessage(msg);

            const messageInfo = this.extractMessageInfo(msg);
            if (!messageInfo) continue;

            console.log(`[WhatsApp] New message from ${messageInfo.senderName}: ${messageInfo.text?.substring(0, 50) || '[media]'}`);

            this.emit('message', {
                key: msg.key,
                remoteJid: msg.key.remoteJid,
                messageId: msg.key.id,
                senderJid: msg.key.participant || msg.key.remoteJid,
                senderName: messageInfo.senderName,
                text: messageInfo.text,
                hasMedia: messageInfo.hasMedia,
                mediaType: messageInfo.mediaType,
                mimetype: messageInfo.mimetype,
                filename: messageInfo.filename,
                isGroup: messageInfo.isGroup,
                isMentioned: messageInfo.isMentioned,
                rawMessage: msg,
                timestamp: msg.messageTimestamp,
            });
        }
    }

    extractMessageInfo(msg) {
        const message = msg.message;
        if (!message) return null;

        const isGroup = msg.key.remoteJid?.endsWith('@g.us');
        const senderName = msg.pushName || msg.key.participant || msg.key.remoteJid;

        // Check if bot is mentioned in the message
        const botJid = this.getBotJid();
        // Baileys multi-device format: "12345:67@s.whatsapp.net" — strip ":XX" device suffix
        const botNumber = botJid ? botJid.split('@')[0].split(':')[0] : null;

        const mentionedJids = message.extendedTextMessage?.contextInfo?.mentionedJid ||
            message.imageMessage?.contextInfo?.mentionedJid ||
            message.videoMessage?.contextInfo?.mentionedJid ||
            message.conversation?.contextInfo?.mentionedJid || [];

        // Check if bot is in the mentionedJid list (compare phone numbers only, strip device suffix)
        let isMentioned = false;
        if (botNumber && mentionedJids.length > 0) {
            isMentioned = mentionedJids.some(jid => {
                const mentionedNumber = jid?.split('@')[0]?.split(':')[0];
                return mentionedNumber === botNumber;
            });
        }

        // Fallback: check if bot number appears in message text (e.g. "@62812345678")
        if (!isMentioned && botNumber && isGroup) {
            const msgText = message.conversation || message.extendedTextMessage?.text || '';
            if (msgText.includes(`@${botNumber}`)) {
                isMentioned = true;
            }
        }

        if (isGroup) {
            console.log(`[WhatsApp] Group msg — botNumber=${botNumber}, mentionedJids=${JSON.stringify(mentionedJids)}, isMentioned=${isMentioned}`);
        }

        if (message.conversation || message.extendedTextMessage) {
            return {
                text: message.conversation || message.extendedTextMessage?.text || '',
                hasMedia: false, senderName, isGroup, isMentioned,
            };
        }

        if (message.imageMessage) {
            return {
                text: message.imageMessage.caption || '',
                hasMedia: true, mediaType: 'image',
                mimetype: message.imageMessage.mimetype, senderName, isGroup, isMentioned,
            };
        }

        if (message.videoMessage) {
            return {
                text: message.videoMessage.caption || '',
                hasMedia: true, mediaType: 'video',
                mimetype: message.videoMessage.mimetype, senderName, isGroup, isMentioned,
            };
        }

        if (message.audioMessage) {
            return {
                text: '', hasMedia: true, mediaType: 'audio',
                mimetype: message.audioMessage.mimetype, senderName, isGroup, isMentioned,
            };
        }

        if (message.documentMessage) {
            return {
                text: message.documentMessage.caption || '',
                hasMedia: true, mediaType: 'document',
                mimetype: message.documentMessage.mimetype,
                filename: message.documentMessage.fileName, senderName, isGroup, isMentioned,
            };
        }

        if (message.stickerMessage) {
            return {
                text: '[Sticker]', hasMedia: true, mediaType: 'sticker',
                mimetype: message.stickerMessage.mimetype, senderName, isGroup, isMentioned,
            };
        }

        return null;
    }

    async downloadMedia(rawMessage) {
        try {
            const { downloadMediaMessage } = await loadBaileys();
            const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
            return buffer;
        } catch (err) {
            console.error('[WhatsApp] Media download error:', err.message);
            return null;
        }
    }

    async sendMessage(jid, text) {
        if (!this.sock || this.connectionState !== 'connected') {
            throw new Error('WhatsApp not connected');
        }
        const result = await this.sock.sendMessage(jid, { text });
        this._trackSentMessage(result);
        console.log(`[WhatsApp] Sent message to ${jid}: ${text.substring(0, 50)}...`);
        return result;
    }

    async sendImage(jid, imagePath, caption = '') {
        if (!this.sock || this.connectionState !== 'connected') {
            throw new Error('WhatsApp not connected');
        }
        const buffer = fs.readFileSync(imagePath);
        const ext = path.extname(imagePath).toLowerCase();
        const mimetype = ext === '.png' ? 'image/png' : 'image/jpeg';
        const result = await this.sock.sendMessage(jid, { image: buffer, caption, mimetype });
        this._trackSentMessage(result);
        return result;
    }

    async sendDocument(jid, filePath, mimetype, filename = null) {
        if (!this.sock || this.connectionState !== 'connected') {
            throw new Error('WhatsApp not connected');
        }
        const buffer = fs.readFileSync(filePath);
        const fname = filename || path.basename(filePath);
        const result = await this.sock.sendMessage(jid, {
            document: buffer,
            mimetype: mimetype || 'application/octet-stream',
            fileName: fname,
        });
        this._trackSentMessage(result);
        return result;
    }

    async sendVideo(jid, videoPath, caption = '') {
        if (!this.sock || this.connectionState !== 'connected') {
            throw new Error('WhatsApp not connected');
        }
        const buffer = fs.readFileSync(videoPath);
        const result = await this.sock.sendMessage(jid, { video: buffer, caption, mimetype: 'video/mp4' });
        this._trackSentMessage(result);
        return result;
    }

    /**
     * Generic file sender — auto-detects type and sends with caption.
     * Images → sent as image with caption.
     * Videos → sent as video with caption.
     * Everything else (PDF, DOC, XLS, PPT, TXT, etc.) → sent as document with caption.
     */
    async sendFile(jid, filePath, { caption = '', mimetype = null, filename = null } = {}) {
        if (!this.sock || this.connectionState !== 'connected') {
            throw new Error('WhatsApp not connected');
        }

        const buffer = fs.readFileSync(filePath);
        const fname = filename || path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();

        // Auto-detect MIME type if not provided
        if (!mimetype) {
            const mimeMap = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp',
                '.mp4': 'video/mp4', '.3gp': 'video/3gpp',
                '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
                '.pdf': 'application/pdf',
                '.doc': 'application/msword',
                '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                '.xls': 'application/vnd.ms-excel',
                '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                '.ppt': 'application/vnd.ms-powerpoint',
                '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
                '.json': 'application/json', '.zip': 'application/zip',
            };
            mimetype = mimeMap[ext] || 'application/octet-stream';
        }

        // Route by type
        if (mimetype.startsWith('image/')) {
            const result = await this.sock.sendMessage(jid, { image: buffer, caption, mimetype });
            this._trackSentMessage(result);
            return result;
        }

        if (mimetype.startsWith('video/')) {
            const result = await this.sock.sendMessage(jid, { video: buffer, caption, mimetype });
            this._trackSentMessage(result);
            return result;
        }

        if (mimetype.startsWith('audio/')) {
            // Audio messages can't have captions in WhatsApp, send caption as separate text
            const result = await this.sock.sendMessage(jid, { audio: buffer, mimetype, ptt: false });
            this._trackSentMessage(result);
            if (caption) {
                const captionResult = await this.sock.sendMessage(jid, { text: caption });
                this._trackSentMessage(captionResult);
            }
            return result;
        }

        // Everything else → document (PDF, Word, Excel, PPT, TXT, etc.)
        const result = await this.sock.sendMessage(jid, {
            document: buffer,
            mimetype,
            fileName: fname,
            caption,
        });
        console.log(`[WhatsApp] Sent file ${fname} (${mimetype}) to ${jid}${caption ? ' with caption' : ''}`);
        this._trackSentMessage(result);
        return result;
    }

    /**
     * Send a link with a comment/message
     */
    async sendLink(jid, url, comment = '') {
        if (!this.sock || this.connectionState !== 'connected') {
            throw new Error('WhatsApp not connected');
        }
        // WhatsApp auto-generates link previews when a URL is in the text
        const text = comment ? `${comment}\n\n${url}` : url;
        const result = await this.sock.sendMessage(jid, { text });
        this._trackSentMessage(result);
        return result;
    }

    async setPresence(jid, type = 'composing') {
        if (!this.sock || this.connectionState !== 'connected') return;
        try {
            await this.sock.presenceSubscribe(jid);
            await this.sock.sendPresenceUpdate(type, jid);
        } catch (err) { /* Non-critical */ }
    }

    async markRead(messageKey) {
        if (!this.sock || this.connectionState !== 'connected') return;
        try {
            await this.sock.readMessages([messageKey]);
        } catch (err) { /* Non-critical */ }
    }

    async disconnect() {
        this._stopKeepAlive();
        if (this.sock) {
            this.sock.ev.removeAllListeners();
            await this.sock.logout().catch(() => { });
            this.sock = null;
        }
        this.connectionState = 'disconnected';
        this.qrCode = null;
        this.emit('status', { state: 'disconnected', message: 'Disconnected' });
    }

    getStatus() {
        return { state: this.connectionState, qrCode: this.qrCode };
    }

    getBotJid() {
        return this.sock?.user?.id || null;
    }

    /**
     * Track a contact from an incoming message (via pushName).
     * This supplements the contacts.upsert event which may not fire for all contacts.
     */
    trackContactFromMessage(msg) {
        if (msg.pushName && msg.key.remoteJid) {
            const jid = msg.key.participant || msg.key.remoteJid;
            if (!jid.endsWith('@g.us')) { // Don't store group JIDs as contacts
                const existing = this._contacts.get(jid) || { jid };
                existing.pushName = msg.pushName;
                if (!existing.name) existing.name = msg.pushName;
                this._contacts.set(jid, existing);
            }
        }
    }

    /**
     * Find contacts by name (fuzzy, case-insensitive search).
     * Searches across pushName, name, and verifiedName.
     * @param {string} query - Name to search for
     * @returns {Array<{jid, name, pushName, verifiedName, matchScore}>}
     */
    findContactByName(query) {
        if (!query) return [];
        const q = query.toLowerCase().trim();
        const results = [];

        for (const [jid, contact] of this._contacts) {
            // Skip groups
            if (jid.endsWith('@g.us')) continue;

            const names = [
                contact.name || '',
                contact.pushName || '',
                contact.verifiedName || '',
            ].filter(Boolean);

            let bestScore = 0;
            let bestName = '';

            for (const name of names) {
                const nameLower = name.toLowerCase();

                if (nameLower === q) {
                    bestScore = 100; // Exact match
                    bestName = name;
                } else if (nameLower.includes(q)) {
                    const score = 80 - (nameLower.length - q.length); // Partial match
                    if (score > bestScore) { bestScore = score; bestName = name; }
                } else if (q.includes(nameLower)) {
                    const score = 60;
                    if (score > bestScore) { bestScore = score; bestName = name; }
                } else {
                    // Check each word
                    const queryWords = q.split(/\s+/);
                    const nameWords = nameLower.split(/\s+/);
                    const matchedWords = queryWords.filter(qw =>
                        nameWords.some(nw => nw.includes(qw) || qw.includes(nw))
                    );
                    if (matchedWords.length > 0) {
                        const score = (matchedWords.length / queryWords.length) * 50;
                        if (score > bestScore) { bestScore = score; bestName = name; }
                    }
                }
            }

            if (bestScore > 0) {
                results.push({
                    jid,
                    name: bestName || contact.name || contact.pushName || jid,
                    pushName: contact.pushName,
                    verifiedName: contact.verifiedName,
                    matchScore: bestScore,
                });
            }
        }

        // Sort by match score (best first)
        return results.sort((a, b) => b.matchScore - a.matchScore);
    }

    /**
     * Get all known contacts
     * @returns {Array<{jid, name, pushName}>}
     */
    getContacts() {
        const contacts = [];
        for (const [jid, c] of this._contacts) {
            if (jid.endsWith('@g.us')) continue;
            contacts.push({
                jid,
                name: c.name || c.pushName || c.verifiedName || jid,
                pushName: c.pushName || '',
            });
        }
        return contacts.sort((a, b) => a.name.localeCompare(b.name));
    }
}

module.exports = WhatsAppService;
