'use strict';

/**
 * RouterService — Classifies incoming messages to route to the appropriate AI.
 *
 * Simple conversational messages → Groq (Llama 3.3 70B, free tier, fast)
 * Complex tasks / media / context-dependent queries → Gemini
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
    // Reminders & scheduling — ALWAYS Gemini (needs scheduler + task context)
    'reminder', 'remind me', 'ingatkan', 'ingetin', 'schedule', 'jadwal',
    'jadwalkan', 'atur jadwal', 'set reminder', 'set alarm',
    'scheduled task', 'scheduled tasks', 'task apa', 'tasks apa',
    'reminder apa', 'reminders apa', 'ada reminder', 'ada jadwal', 'ada task',
    'list task', 'list reminder', 'daftar task', 'daftar reminder',
    'hapus task', 'hapus reminder', 'cancel task', 'cancel reminder',
    // Date / time — ALWAYS Gemini (has correct WIB datetime context)
    'jam berapa', 'pukul berapa', 'jam dan tanggal', 'tanggal berapa',
    'hari apa', 'hari ini', 'sekarang jam', 'sekarang pukul', 'sekarang tanggal',
    'what time', 'what day', 'what date', 'current time', 'current date',
    "today's date", 'today is', 'waktu sekarang', 'tanggal sekarang',
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

// Patterns for greetings and simple one-liner chitchat (Groq only for these)
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

        // Check for complex keywords (includes date/time and task queries)
        for (const kw of COMPLEX_KEYWORDS) {
            if (lower.includes(kw)) {
                return 'gemini';
            }
        }

        // Check for simple one-liner patterns (greetings only)
        for (const pattern of SIMPLE_PATTERNS) {
            if (pattern.test(text)) {
                return 'groq';
            }
        }

        // Only route very short messages (≤ 30 chars) to Groq — these are
        // trivially conversational. Longer messages may need date/task context.
        // Previously this was ≤ 60 which misrouted 'jam dan tanggal berapa?' (32 chars).
        if (text.length <= 30) {
            return 'groq';
        }

        // Default: Gemini (safe fallback for anything ambiguous)
        return 'gemini';
    }
}

module.exports = new RouterService();
