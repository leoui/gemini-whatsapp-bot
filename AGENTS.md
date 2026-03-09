# AGENTS.md — AI Agent Reference

This document describes the AI agents running inside the Gemini WhatsApp Bot and how they interact.

---

## Agent Overview

The bot uses a **two-tier AI routing architecture** introduced in v2:

| Agent | Model | Purpose | When Used |
|---|---|---|---|
| **GroqAgent** | Llama 3.3 70B Versatile | Simple conversational replies | Short/casual messages, greetings, chitchat |
| **GeminiAgent** | Gemini 2.5 Flash | Complex tasks + fallback | Files, images, maps, analysis, reminders, media |

---

## RouterService (`services/router.js`)

Classifies every incoming message and decides which AI handles it. **No API call is made** — this is pure keyword matching and heuristics.

### Classification Logic

```
1. Has media (image/PDF/file)?    → Gemini (always)
2. Empty/very long message?       → Gemini (safe fallback)
3. Matches complex keyword list?  → Gemini
4. Matches simple greeting regex? → Groq
5. Short message (≤ 60 chars)?    → Groq
6. Default (ambiguous)            → Gemini
```

### Complex Keywords (routes to Gemini)
- **File creation:** `excel`, `xlsx`, `pdf`, `pptx`, `create file`, `buat file`, etc.
- **Image generation:** `generate image`, `draw`, `bikin foto`, `gambar`, etc.
- **Reminders:** `reminder`, `remind me`, `ingatkan`, `schedule`, `jadwal`
- **Maps:** `google maps`, `lokasi`, `location of`, `directions to`
- **Analysis:** `analyze`, `calculate`, `hitung`, `extract`, `summarize`
- **Proactive messaging:** `send +`, `kirim +`, `bilang ke +`

### Simple Patterns (routes to Groq)
- Greetings: `hi`, `hello`, `halo`, `hey`
- How-are-you: `how are you`, `apa kabar`
- Salutations: `good morning/afternoon/evening`, `selamat pagi/siang/sore/malam`
- Acknowledgements: `thanks`, `ok`, `siap`, `noted`

---

## GroqAgent (`services/groq.js`)

### Model: `llama-3.3-70b-versatile`
### API: Groq Cloud (OpenAI-compatible)
### Cost: Free tier (~14,400 requests/day)

**Capabilities:**
- Natural conversational replies in any language
- Maintains per-chat conversation history (last 20 messages)
- Shares the same character prompt as Gemini
- Returns `null` on failure → caller silently falls back to Gemini

**Limitations (by design):**
- No multimodal support (cannot process images/files)
- No tool use / function calling
- No internet access / real-time data
- Max response: 512 tokens (concise replies)

**Fallback behavior:**
- 429 rate limit → return `null` → Gemini handles
- Any error → return `null` → Gemini handles
- Key not configured → return `null` → Gemini handles

---

## GeminiAgent (`services/gemini.js`)

### Model: `gemini-2.5-flash` (default)
### SDK: `@google/genai` v0.9+ (stable v1 API)
### Cost: Free tier (~500 req/day per key; multiple keys supported)

**Capabilities:**
- Full multimodal: text, image, PDF, audio, video analysis
- File generation: Excel, PDF, PPTX, CSV, TXT, HTML, JSON
- Image generation (via Pollinations AI waterfall → Imagen 3)
- Google Maps link generation
- Google Calendar integration
- Reminder/scheduling (`[REMINDER:...]` tags)
- Proactive messaging (`[SEND_TO:...]` tags)
- Conversation history persistence (50 messages per chat, saved to disk)

**Key Rotation:**
- Supports unlimited API keys via `GEMINI_API_KEY=key1,key2,key3`
- Rotates on 429/quota errors automatically
- Falls back through model list: `gemini-2.5-flash` → `gemini-2.0-flash`

**API Version:** Stable `v1` (set via `httpOptions: { apiVersion: 'v1' }`)  
**No beta/preview API versions are used.**

---

## Message Flow

```
WhatsApp Message
      │
      ▼
handleIncomingMessage() in server.js
      │
      ├─ Download media (if any)
      │
      ├─ Check Maps intent → GeminiAgent.searchGoogleMaps()
      ├─ Check Image intent → GeminiAgent.generateImage()
      ├─ Check File intent  → GeminiAgent.generateFile()
      │
      └─ Remaining text-only messages:
             │
             ▼
         Router.classify(msg)
             │
         ────┼────────────────────
         'groq'              'gemini'
             │                   │
             ▼                   ▼
       GroqAgent           GeminiAgent
    .generateResponse()  .generateResponse()
             │
         null? ────────► GeminiAgent (fallback)
```

---

## Configuration

### Adding a Groq API Key
```bash
# Get a free key at https://console.groq.com
GROQ_API_KEY=gsk_your_key_here
```

### Changing the Default Gemini Model
```bash
# In your config or via node:
node -e "require('./services/config').set('geminiModel', 'gemini-2.5-flash')"
```

### Disabling Groq (use Gemini for everything)
Simply don't set `GROQ_API_KEY`. The router will still classify messages, but Groq will skip and everything goes to Gemini.

---

## Extending the Router

To add new complex keywords, edit `services/router.js`:

```js
const COMPLEX_KEYWORDS = [
    // ... existing keywords ...
    'your new keyword',
];
```

To add new simple patterns:
```js
const SIMPLE_PATTERNS = [
    // ... existing patterns ...
    /^your regex pattern$/i,
];
```
