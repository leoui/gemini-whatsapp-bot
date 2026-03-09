'use strict';

/**
 * GroqService — Lightweight AI for simple conversational messages.
 *
 * Uses Groq's free tier (llama-3.3-70b-versatile) via the OpenAI-compatible API.
 * Falls back gracefully: if Groq fails for any reason, returns null so the
 * caller can fall back to Gemini without breaking the user experience.
 *
 * Rate limits (free tier): ~14,400 req/day, ~30 req/min
 * Get a free key at: https://console.groq.com
 */

const Groq = require('groq-sdk');
const Config = require('./config');

// Keep last N messages per chat for context
const MAX_HISTORY = 20;

class GroqService {
    constructor() {
        this.apiKey = Config.get('groqApiKey') || process.env.GROQ_API_KEY || '';
        this.client = null;
        this.chatHistories = new Map(); // chatId → Array of {role, content}
        this.model = 'llama-3.3-70b-versatile';

        if (this.apiKey) {
            this.client = new Groq({ apiKey: this.apiKey });
            console.log('[Groq] Service initialized with llama-3.3-70b-versatile');
        } else {
            console.log('[Groq] No GROQ_API_KEY configured — simple chat will fall back to Gemini');
        }
    }

    /**
     * Check if Groq is available (key configured)
     */
    isAvailable() {
        return !!this.client && !!this.apiKey;
    }

    /**
     * Get (or create) conversation history for a chat
     */
    getHistory(chatId) {
        if (!this.chatHistories.has(chatId)) {
            this.chatHistories.set(chatId, []);
        }
        return this.chatHistories.get(chatId);
    }

    /**
     * Add a message to history (keeps last MAX_HISTORY messages)
     */
    addToHistory(chatId, role, content) {
        const history = this.getHistory(chatId);
        history.push({ role, content });
        if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
        }
    }

    /**
     * Generate a response for a simple conversational message.
     *
     * @param {string} chatId - WhatsApp chat ID (for history)
     * @param {string} userMessage - The user's text
     * @param {string|null} senderName - Display name of the sender
     * @returns {{ text: string, error?: boolean }|null} - Returns null if Groq unavailable/failed
     */
    async generateResponse(chatId, userMessage, senderName = null) {
        if (!this.isAvailable()) {
            return null; // No key → caller falls back to Gemini
        }

        const characterPrompt = Config.get('characterPrompt') ||
            'You are a friendly, casual WhatsApp assistant. Use the same language as the user. Be genuine, warm, and natural — like texting a friend.';

        // Compute GMT+7 explicitly (no TZ env dependency)
        const nowUtc = new Date();
        const wib = new Date(nowUtc.getTime() + 7 * 60 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const WIB_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const WIB_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const dateTimeStr = `${WIB_DAYS[wib.getUTCDay()]}, ${WIB_MONTHS[wib.getUTCMonth()]} ${wib.getUTCDate()}, ${wib.getUTCFullYear()}, ${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}:${pad(wib.getUTCSeconds())} WIB (UTC+7)`;
        const dateTimeContext = `\n\n=== CURRENT DATE & TIME ===\nRight now: ${dateTimeStr}\nWhen asked about the date or time, state this exactly. Do NOT say you cannot show real-time time.\n`;

        // IMPORTANT: persona MUST come first and be the dominant instruction.
        // Do NOT append instructions that tell the model to be brief or conservative —
        // those will override the character prompt and make responses feel cold/robotic.
        const systemContent = characterPrompt + dateTimeContext;

        const history = this.getHistory(chatId);
        const messages = [
            {
                role: 'system',
                content: systemContent,
            },
            ...history,
            {
                role: 'user',
                content: senderName ? `[Message from ${senderName}]: ${userMessage}` : userMessage,
            },
        ];

        try {
            const completion = await this.client.chat.completions.create({
                model: this.model,
                messages,
                max_tokens: 1024,  // was 512 — allows full casual/expressive replies
                temperature: 0.85, // was 0.7  — more personality, less robotic
            });

            const responseText = completion.choices?.[0]?.message?.content || '';
            if (!responseText) return null;

            // Update history
            this.addToHistory(chatId, 'user', userMessage);
            this.addToHistory(chatId, 'assistant', responseText);

            console.log(`[Groq] SUCCESS — responded to ${chatId}`);
            return { text: responseText };
        } catch (err) {
            const msg = err.message || '';
            // 429 = rate limited, just fall back to Gemini silently
            if (msg.includes('429') || msg.includes('rate') || msg.includes('limit')) {
                console.warn('[Groq] Rate limited — falling back to Gemini');
            } else {
                console.warn(`[Groq] Failed: ${msg.substring(0, 120)} — falling back to Gemini`);
            }
            return null; // null = caller should fall back to Gemini
        }
    }
}

module.exports = GroqService;
