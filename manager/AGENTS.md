# AGENTS.md — AI Agent & App Reference

This document describes the AI agents running inside the Gemini WhatsApp Bot and the Bot Manager desktop app architecture.

---

## AI Agent Overview

The bot uses a **two-tier routing architecture**:

| Agent | Model | Purpose | When Used |
|---|---|---|---|
| **GroqAgent** | Llama 3.3 70B Versatile | Simple conversational replies | Short/casual messages, greetings, chitchat |
| **GeminiAgent** | Gemini 2.5 Flash | Complex tasks + fallback | Files, images, maps, analysis, reminders, media |

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

## Message Flow

```
WhatsApp Message
      │
      ▼
handleIncomingMessage() in server.js
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
