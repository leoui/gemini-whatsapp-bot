'use strict';

/**
 * RouterService — Classifies incoming messages to route to the appropriate AI.
 *
 * Simple conversational messages → Groq (Llama 3.3 70B, free tier, fast)
 * Complex tasks / media → Gemini (multimodal, file gen, image gen, etc.)
 */

// Keywords that indicate a complex task requiring Gemini
const COMPLEX_KEYWORDS = [
    // File creation
    'excel', 'spreadsheet', 'xlsx', 'xls', '.pdf', 'pptx', 'powerpoint',
    'create file', 'make file', 'generate file', 'buat file', 'bikin file',
    'create excel', 'buat excel', 'bikin excel', 'generate excel',
    'create pdf', 'buat pdf', 'bikin pdf', 'generate pdf',
    'buatkan file', 'buatkan excel', 'buatkan pdf',
    // Image generation
    'generate image', 'create image', 'make an image', 'draw ', 'draw me',
    'generate a photo', 'create a photo', 'make a photo',
    'buatin foto', 'buatkan foto', 'bikin foto', 'buat foto',
    'buatin gambar', 'buatkan gambar', 'bikin gambar', 'buat gambar',
    'generate gambar', 'gambarin', 'fotoin', 'bikinin foto', 'bikinin gambar',
    'boleh bikin foto', 'bisa bikin foto', 'boleh bikin gambar', 'bisa bikin gambar',
    // Reminders & scheduling
    'reminder', 'remind me', 'ingatkan', 'ingetin', 'schedule', 'jadwal',
    'jadwalkan', 'atur jadwal', 'set reminder', 'set alarm',
    // Proactive messaging (send to others)
    'send +', 'kirim +', 'bilang ke +', 'chat +', 'tell +',
    // Google Maps / location
    'find on map', 'search map', 'google maps', 'where is', 'location of',
    'directions to', 'navigate to', 'maps search', 'lokasi', 'cari lokasi',
    // Calendar
    'calendar', 'create event', 'add event', 'kalender',
    // Calculations / data processing
    'calculate', 'hitung', 'kalkulator', 'compute', 'formula',
    'analyze', 'analisa', 'analyse', 'analysis', 'data processing',
    'extract', 'ekstrak', 'summarize', 'ringkas',
    // Web search
    'search for', 'cari di google', 'google it', 'search the web',
    'latest news', 'berita terbaru', 'what is the current',
];

// Patterns for greetings and simple chitchat (always Groq)
const SIMPLE_PATTERNS = [
    /^(hi|hello|hey|halo|hai|hei|yo|sup|howdy)[^a-z]?$/i,
    /^(how are you|how r u|hows it going|how's it|apa kabar|kabar (gimana|bagaimana|baik))[?!]?$/i,
    /^good (morning|afternoon|evening|night|day)[.!]?$/i,
    /^(selamat (pagi|siang|sore|malam))[.!]?$/i,
    /^(thanks|thank you|thx|ty|makasih|terima kasih)[.!]?$/i,
    /^(ok|okay|oke|siap|noted|noted\.?)[.!]?$/i,
];

class RouterService {
    /**
     * Classify a message and return target AI: 'groq' or 'gemini'
     * @param {Object} msg - Message object from WhatsApp handler
     * @returns {'groq'|'gemini'}
     */
    classify(msg) {
        // Always use Gemini for media (images, PDFs, files)
        if (msg.hasMedia) {
            return 'gemini';
        }

        const text = (msg.text || '').trim();

        // Empty messages → Gemini
        if (!text) return 'gemini';

        // Very long messages (likely complex request) → Gemini
        if (text.length > 300) return 'gemini';

        const lower = text.toLowerCase();

        // Check for complex keywords
        for (const kw of COMPLEX_KEYWORDS) {
            if (lower.includes(kw)) {
                return 'gemini';
            }
        }

        // Check for simple one-liner patterns
        for (const pattern of SIMPLE_PATTERNS) {
            if (pattern.test(text)) {
                return 'groq';
            }
        }

        // Short messages (≤ 60 chars) with no complex keywords → Groq
        if (text.length <= 60) {
            return 'groq';
        }

        // Default: Gemini (safe fallback for ambiguous cases)
        return 'gemini';
    }
}

module.exports = new RouterService();
