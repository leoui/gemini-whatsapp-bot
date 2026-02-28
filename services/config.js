const path = require('path');
const os = require('os');
const fs = require('fs');

// Detect if running in Electron environment
const isElectron = !!process.versions.electron;

let store;

/**
 * Simple file-based store for headless/VPS mode
 */
class HeadlessStore {
    constructor(options) {
        this.path = path.join(os.homedir(), '.gemini-whatsapp-bot-config.json');
        this.defaults = options.defaults || {};
        this.data = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.path)) {
                return JSON.parse(fs.readFileSync(this.path, 'utf8'));
            }
        } catch (err) {
            console.error('[Config] Failed to load headless config:', err.message);
        }
        return { ...this.defaults };
    }

    _save() {
        try {
            fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (err) {
            console.error('[Config] Failed to save headless config:', err.message);
        }
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        this.data[key] = value;
        this._save();
    }

    get store() {
        return this.data;
    }

    clear() {
        this.data = { ...this.defaults };
        this._save();
    }
}

if (isElectron) {
    try {
        const Store = require('electron-store');
        store = new Store({
            name: 'gemini-whatsapp-bot-config',
            defaults: { /* same defaults as below */ }
        });
    } catch (e) {
        console.warn('[Config] Electron detected but electron-store failed, falling back to headless mode.');
        store = new HeadlessStore({ defaults: {} });
    }
} else {
    store = new HeadlessStore({ defaults: {} });
}

// Common defaults
const defaults = {
    // Gemini API Keys (up to 3)
    geminiKeys: [],
    activeKeyIndex: 0,
    keyUsage: {}, // { key: { used: 0, lastReset: timestamp } }
    geminiModel: 'gemini-2.5-pro',

    // Character / Persona
    characterPrompt: `You are a helpful, friendly assistant responding via WhatsApp. 
Keep responses concise and natural — like texting a friend. 
Use casual language, emojis occasionally, and break long responses into short paragraphs.
Never mention that you are an AI unless directly asked.`,

    // Human Behavior Settings
    behavior: {
        enabled: true,
        minReadDelay: 1000,      // ms - minimum time to "read" a message
        maxReadDelay: 5000,      // ms - maximum read delay
        typingSpeedWPM: 40,      // words per minute typing simulation
        randomVariance: 0.3,     // ±30% randomness on delays
        maxMessagesPerMinute: 5,
        maxMessagesPerHour: 60,
        activeHoursEnabled: false,
        activeHoursStart: 8,     // 8 AM
        activeHoursEnd: 23,      // 11 PM
    },

    // Auto-reply
    autoReplyEnabled: true,

    // Group behavior: only respond when mentioned or trigger word used
    groupMentionOnly: true,
    groupTriggerWord: 'bot',  // Keyword trigger: "bot, hello" triggers a response

    // Scheduled tasks (reminders, timed messages)
    scheduledTasks: [],

    // Saved contacts (address book with shortcodes)
    // Format: [{ name, shortcode, phone }]
    savedContacts: [],

    // File storage
    filesDirectory: path.join(os.homedir(), 'WhatsAppBot', 'files'),

    // Google Calendar OAuth
    calendarCredentials: null,
    calendarTokens: null,

    // WhatsApp session
    whatsappSessionPath: path.join(os.homedir(), '.whatsapp-bot-session'),

    // Message history retention (days)
    historyRetentionDays: 30,

    // Allowed contacts (empty = respond to all)
    allowedContacts: [],
    blockedContacts: [],
};

// Apply defaults for HeadlessStore
if (store instanceof HeadlessStore) {
    store.defaults = defaults;
    // Merge existing data with defaults to ensure all keys exist
    store.data = { ...defaults, ...store.data };
} else if (isElectron) {
    // For electron-store, we re-initialize with full defaults if we just created it above
    // (Note: we need to handle the case where it was already initialized)
    // Actually, setting defaults in constructor is enough for electron-store.
    // But since we had a simplified version above, let's fix it.
    const Store = require('electron-store');
    store = new Store({
        name: 'gemini-whatsapp-bot-config',
        defaults: defaults
    });
}

class Config {
    static get(key) {
        return store.get(key);
    }

    static set(key, value) {
        store.set(key, value);
    }

    static getAll() {
        return store.store;
    }

    // --- Gemini Key Management ---
    static getGeminiKeys() {
        return store.get('geminiKeys') || [];
    }

    static addGeminiKey(key) {
        const keys = this.getGeminiKeys();
        if (keys.length >= 3) throw new Error('Maximum 3 API keys allowed');
        if (keys.includes(key)) throw new Error('Key already exists');
        keys.push(key);
        store.set('geminiKeys', keys);
        // Initialize usage for this key
        const usage = store.get('keyUsage') || {};
        usage[key] = { used: 0, lastReset: Date.now() };
        store.set('keyUsage', usage);
        return keys;
    }

    static removeGeminiKey(index) {
        const keys = this.getGeminiKeys();
        if (index < 0 || index >= keys.length) throw new Error('Invalid key index');
        const removedKey = keys.splice(index, 1)[0];
        store.set('geminiKeys', keys);
        // Remove usage tracking
        const usage = store.get('keyUsage') || {};
        delete usage[removedKey];
        store.set('keyUsage', usage);
        // Reset active key index if needed
        const activeIndex = store.get('activeKeyIndex');
        if (activeIndex >= keys.length) {
            store.set('activeKeyIndex', 0);
        }
        return keys;
    }

    static getActiveKey() {
        const keys = this.getGeminiKeys();
        if (keys.length === 0) return null;
        const index = store.get('activeKeyIndex') || 0;
        return keys[index % keys.length];
    }

    static rotateKey() {
        const keys = this.getGeminiKeys();
        if (keys.length <= 1) return null;
        let currentIndex = store.get('activeKeyIndex') || 0;
        currentIndex = (currentIndex + 1) % keys.length;
        store.set('activeKeyIndex', currentIndex);
        console.log(`[Config] Rotated to API key ${currentIndex + 1}/${keys.length}`);
        return keys[currentIndex];
    }

    static trackKeyUsage(key) {
        const usage = store.get('keyUsage') || {};
        if (!usage[key]) {
            usage[key] = { used: 0, lastReset: Date.now() };
        }
        // Reset daily counter if past midnight PT
        const now = Date.now();
        const msSinceReset = now - usage[key].lastReset;
        if (msSinceReset > 24 * 60 * 60 * 1000) {
            usage[key].used = 0;
            usage[key].lastReset = now;
        }
        usage[key].used++;
        store.set('keyUsage', usage);
        return usage[key];
    }

    static getKeyUsage() {
        return store.get('keyUsage') || {};
    }

    // --- Behavior Settings ---
    static getBehavior() {
        return store.get('behavior');
    }

    static updateBehavior(updates) {
        const current = this.getBehavior();
        store.set('behavior', { ...current, ...updates });
    }

    // --- Contact Management ---
    static isContactAllowed(jid) {
        const allowed = store.get('allowedContacts') || [];
        const blocked = store.get('blockedContacts') || [];
        if (blocked.includes(jid)) return false;
        if (allowed.length === 0) return true; // Empty = allow all
        return allowed.includes(jid);
    }

    // --- Export / Import for Uninstall ---
    static exportConfig(filePath) {
        const config = store.store;
        // Remove session-specific data, keep keys & settings
        const exportData = {
            geminiKeys: config.geminiKeys,
            geminiModel: config.geminiModel,
            characterPrompt: config.characterPrompt,
            behavior: config.behavior,
            autoReplyEnabled: config.autoReplyEnabled,
            groupMentionOnly: config.groupMentionOnly,
            groupTriggerWord: config.groupTriggerWord,
            calendarCredentials: config.calendarCredentials,
            calendarTokens: config.calendarTokens,
            allowedContacts: config.allowedContacts,
            blockedContacts: config.blockedContacts,
            historyRetentionDays: config.historyRetentionDays,
            savedContacts: config.savedContacts || [],
            scheduledTasks: config.scheduledTasks || [],
            exportedAt: new Date().toISOString(),
        };

        // Export as XML or JSON based on file extension
        if (filePath.endsWith('.xml')) {
            const xml = this._toXml(exportData);
            fs.writeFileSync(filePath, xml, 'utf-8');
        } else {
            fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf-8');
        }
        console.log(`[Config] Exported config to ${filePath}`);
        return filePath;
    }

    static _toXml(obj, rootTag = 'config', indent = '') {
        let xml = indent === '' ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '';
        xml += `${indent}<${rootTag}>\n`;
        for (const [key, value] of Object.entries(obj)) {
            if (Array.isArray(value)) {
                xml += `${indent}  <${key}>\n`;
                for (const item of value) {
                    if (typeof item === 'object' && item !== null) {
                        xml += this._toXml(item, 'item', indent + '    ');
                    } else {
                        xml += `${indent}    <item>${this._escXml(String(item))}</item>\n`;
                    }
                }
                xml += `${indent}  </${key}>\n`;
            } else if (typeof value === 'object' && value !== null) {
                xml += this._toXml(value, key, indent + '  ');
            } else {
                xml += `${indent}  <${key}>${this._escXml(String(value ?? ''))}</${key}>\n`;
            }
        }
        xml += `${indent}</${rootTag}>\n`;
        return xml;
    }

    static _escXml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    static importConfig(filePath) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const importableKeys = [
            'geminiKeys', 'geminiModel', 'characterPrompt', 'behavior',
            'autoReplyEnabled', 'groupMentionOnly', 'groupTriggerWord',
            'calendarCredentials', 'calendarTokens', 'allowedContacts',
            'blockedContacts', 'historyRetentionDays',
            'savedContacts', 'scheduledTasks',
        ];
        for (const key of importableKeys) {
            if (data[key] !== undefined) {
                store.set(key, data[key]);
            }
        }
        // Re-initialize key usage for imported keys
        if (data.geminiKeys) {
            const usage = {};
            for (const k of data.geminiKeys) {
                usage[k] = { used: 0, lastReset: Date.now() };
            }
            store.set('keyUsage', usage);
            store.set('activeKeyIndex', 0);
        }
        console.log(`[Config] Imported config from ${filePath}`);
        return true;
    }

    static clearAll() {
        store.clear();
        console.log('[Config] All settings cleared');
    }

    static getConfigStorePath() {
        return store.path;
    }
}

module.exports = Config;
