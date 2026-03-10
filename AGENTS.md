# AGENTS.md — AI Agent & App Reference

This document describes the AI agents running inside the Gemini WhatsApp Bot and the Bot Manager desktop app architecture.

---

## AI Agent Overview

The bot uses a **three-tier routing architecture**:

| Agent | Model | Purpose | When Used |
|---|---|---|---|
| **InvestorAgent** | Claude Sonnet / Gemini 2.5 Flash | Stock analysis & trading plans | `/cl` or `/gm` prefix commands |
| **GroqAgent** | Llama 3.3 70B Versatile | Simple conversational replies | Short/casual messages, greetings |
| **GeminiAgent** | Gemini 2.5 Flash | Complex tasks + fallback | Files, images, maps, analysis, reminders |

---

## RouterService (`services/router.js`)

Classifies every incoming message. **No API call** — pure keyword matching.

### Classification Logic

```
1. Has media (image/PDF/file)?    → Gemini (always)
2. Empty/very long message?       → Gemini
3. Matches complex keyword list?  → Gemini
4. Matches simple greeting regex? → Groq
5. Short message (≤ 60 chars)?    → Groq
6. Default                        → Gemini
```

### Complex Keywords (→ Gemini)
- **File creation:** `excel`, `xlsx`, `pdf`, `pptx`, `create file`
- **Image generation:** `generate image`, `draw`, `gambar`
- **Reminders:** `reminder`, `remind me`, `ingatkan`, `schedule`
- **Maps:** `google maps`, `lokasi`, `location of`
- **Analysis:** `analyze`, `calculate`, `hitung`, `summarize`
- **Investment:** `/cl`, `/gm` (prefix commands → InvestorAgent)
- **Proactive:** `send +`, `kirim +`, `bilang ke +`

### Simple Patterns (→ Groq)
- Greetings: `hi`, `hello`, `halo`, `hey`
- How-are-you: `how are you`, `apa kabar`
- Salutations: `good morning/afternoon/evening`
- Acknowledgements: `thanks`, `ok`, `siap`, `noted`

---

## GroqAgent (`services/groq.js`)

- **Model:** `llama-3.3-70b-versatile`
- **Cost:** Free (~14,400 req/day)
- Maintains per-chat history (last 20 messages)
- Returns `null` on any failure → caller falls back to Gemini

**Limitations (by design):**
- No multimodal (cannot process images/files)
- No tool use / function calling
- No internet access / real-time data

---

## GeminiAgent (`services/gemini.js`)

- **Model:** `gemini-2.5-flash` (default)
- **SDK:** `@google/genai v0.9+` (stable v1 API)
- **Cost:** Free (~500 req/day per key; multiple keys supported)

**Capabilities:**
- Full multimodal: text, image, PDF, audio, video
- File generation: Excel, PDF, PPTX, CSV, TXT, HTML, JSON
- Image generation (Pollinations → Imagen 3 waterfall)
- Google Maps, Google Calendar, reminders, proactive messaging
- History persistence: 50 messages/chat, saved to disk

**Key Rotation:**
```
GEMINI_API_KEY=key1,key2,key3
```
Rotates on 429/quota errors automatically.

---

## InvestorAgent (`services/investorService.js`)

AI-powered investment analysis using real market data.

- **Data Sources:**
  - **Yahoo Finance chart API** (free, no key) — price, volume, 52W, technicals
  - **FMP API** (free, 25 req/day) — P/E, P/B, ROE, margins, D/E, FCF, EPS
  - US stocks: `AAPL`, `NVDA`, `MSFT`
  - IDX stocks: `BBRI.JK`, `BBCA.JK`, `TLKM.JK`
- **Bandarmology** (volume-based smart money analysis):
  - OBV Trend — accumulation vs distribution flow
  - Smart Money Detection — whale (🐋), stealth, accumulation, distribution
  - Bandar Score (7-day) — net accumulation vs distribution
  - Volume Pattern — 5-day visual bar chart
- **Claude credit tracking:** Cost per analysis + remaining balance (for `/cl` only)

- **AI Engines:**
  - `/gm` → Gemini 2.5 Flash (uses existing keys)
  - `/cl` → Claude Sonnet (requires `CLAUDE_API_KEY`)

- **Analysis includes:**
  - Fundamental: P/E, P/B, PEG, EV/EBITDA, ROE, margins, D/E, FCF
  - Technical: RSI-14, SMA-20/50, support/resistance
  - Signal: 🟢 BUY / 🟡 HOLD / 🔴 SELL with confidence %
  - Trading plan: entry, stop-loss, TP1, TP2, position sizing
  - Scalping specialization

- **Strict grounding:** Only uses provided Yahoo Finance data. Actual current date injected (WIB). No hallucination.

---

## Message Flow

```
WhatsApp Message
      │
      ▼
handleIncomingMessage() in server.js
      │
      ├─ /cl or /gm prefix?
      │       ├─ fetchStockData() → Yahoo Finance
      │       ├─ fetchTechnicals() → RSI, SMA, S/R
      │       └─ /cl → Claude API  |  /gm → Gemini API
      │                    │
      │             Buy/Hold/Sell report
      │
      ├─ Download media (if any)
      ├─ Check Maps intent → GeminiAgent.searchGoogleMaps()
      ├─ Check Image intent → GeminiAgent.generateImage()
      ├─ Check File intent  → GeminiAgent.generateFile()
      │
      └─ Text-only messages:
             │
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

--- Response Tag Handlers ---
[IMAGE_GEN:prompt]    → generateImage() → send photo
[STOCK_ANALYSIS:BBRI] → InvestorAgent → send analysis
[CREATE_FILE:xlsx:f]  → createExcelFile() → send file
[REMINDER:time:msg]   → Scheduler.addTask()
[SEND_TO:name:msg]    → whatsapp.sendMessage()
```

---

## Bot Manager App (`manager/`)

The macOS Electron app talks to the VPS exclusively via **SSH** using the `ssh2` library. All configuration changes are applied live to the running bot.

### Architecture

```
Renderer (HTML/CSS/JS)
     │ contextBridge (preload.js)
     ▼
Main Process (main.js)
     │ SSH exec / SFTP
     ▼
VPS (systemd + node server.js)
```

### IPC Namespaces (preload.js → main.js)

| Namespace | Methods |
|---|---|
| `store` | `get`, `set`, `getAll` — local Electron Store |
| `ssh` | `test` — SSH connection test |
| `vps` | `status`, `restart`, `backup`, `downloadBackup`, `logs`, `setEnv`, `importAll`, `changeNumber`, `pollQR` |
| `bot` | `readConfig`, `saveConfig` — bot JSON config |
| `dialog` | `chooseDirectory`, `openFile`, `saveFile` — native OS dialogs |
| `settings` | `export`, `importFromFile` — XML settings round-trip |
| `app` | `uninstall` |
| `gdrive` | `saveCredentials`, `login`, `logout`, `status`, `uploadBackup` |

### Settings Persistence

All store writes are mirrored to `~/.bot-manager-settings.json` (outside the app sandbox). On startup, if the Electron store is empty (e.g., after reinstall), settings are auto-restored from this file.

### Panels

| Panel ID | Description |
|---|---|
| `connection` | VPS SSH credentials |
| `persona` | Character prompt, bot name, timezone |
| `apikeys` | Gemini, Groq, Pollinations keys → `vps:setEnv` |
| `contacts` | Saved contact shortcuts |
| `keywords` | Group trigger, auto-reply |
| `behavior` | Human behavior engine settings |
| `groups` | Group JID allow/block lists |
| `whatsapp` | **Change number + in-app QR scanner** |
| `backup` | VPS backup, Mac download, Google Drive |
| `import` | Import from VPS/file, export to XML |
| `logs` | Live journal tail |
| `status` | Visual health dashboard |
| `uninstall` | Danger zone |

### WhatsApp Number Change Flow

```
vps:changeNumber
  → systemctl stop <service>
  → rm -rf auth_info_baileys / sessions
  → systemctl start <service>

vps:pollQR (every 5s)
  → journalctl -u <service> -n 80
  → extract QR data string from log
  → renderer renders via qrcode.js canvas
  → 60-second countdown, auto-refresh on expiry
```

---

## Extending

### Add complex keywords (→ Gemini)
Edit `services/router.js`:
```js
const COMPLEX_KEYWORDS = [
    // ...existing...
    'your new keyword',
];
```

### Add Groq simple patterns
```js
const SIMPLE_PATTERNS = [
    // ...existing...
    /^your regex$/i,
];
```

### Add a new `/prefix` command
In `server.js`, add a regex match after the `/cl` and `/gm` handlers:
```js
const myMatch = msgTextTrimmed.match(/^\/myprefix\s+(.+)/is);
if (myMatch) {
    // Your custom handler
    return;
}
```

### Modify investment analysis prompt
Edit `services/investorService.js` → `buildPrompt()` to customize the analysis structure, add sectors, or change the output format.
