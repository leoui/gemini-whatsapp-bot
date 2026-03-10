# 🤖 Gemini WhatsApp Bot v3

A full-featured WhatsApp AI assistant powered by **Google Gemini** for complex tasks, **Groq (Llama 3.3 70B)** for fast simple conversations, and **Claude AI** for investment analysis. Supports stock analysis, image generation, file creation, reminders, scheduling, Google Maps, and more.

Run headless on a VPS or manage via the **Bot Manager** macOS desktop app.

Made with ☕ by [Lewi Verdatama](https://github.com/leoui)

---

## ✨ Features

### 🧠 Smart AI Routing
- **Simple chat** (greetings, Q&A, chitchat) → Groq Llama 3.3 70B (free, fast, ~14,400 req/day)
- **Complex tasks** (files, images, maps, analysis, reminders) → Google Gemini 2.5 Flash
- Automatic fallback: if Groq is unavailable, everything goes to Gemini seamlessly

### 🖼️ Image Generation (Multi-Provider Waterfall)
- **Primary:** [Pollinations AI](https://pollinations.ai) — free, no rate limits with API key
  Models: `flux`, `flux-2-dev`, `imagen-4`, `seedream`
- **Fallback:** Google Imagen 3 — free tier with Gemini API key rotation

### 📄 File Creation
Generate and send files directly in WhatsApp:
- 📊 Excel spreadsheets (`.xlsx`)
- 📄 PDF documents
- 📽️ PowerPoint presentations (`.pptx`)
- 📝 CSV, TXT, HTML, JSON, and code files

### ⏰ Reminders & Scheduling
- Natural language scheduling: *"Remind me at 7 AM to take medicine"*
- Supports relative time: *"in 30 minutes"*, *"tomorrow 9 AM"*
- Timezone-aware (configurable, defaults to `Asia/Jakarta`)

### 📨 Proactive Messaging
- Send messages to other contacts: *"Send +Novita good morning"*
- Contact resolution: saved shortcodes → contact names → phone numbers

### 🗺️ Google Maps & Calendar
- Location search and Google Maps link sharing
- Google Calendar event creation from natural language

### 📎 File Analysis
- Analyze images, PDFs, and documents sent by users
- Extract text, summarize content, answer questions about files

### 🔗 WhatsApp Connection
- QR Code scanning (primary) — **scannable directly in the Bot Manager app**
- Phone number pairing code (automatic fallback after 3 QR failures)
- Auto-reconnect with exponential backoff

### 🎭 Human-Like Behavior
- Simulated read delays and typing indicators
- Configurable typing speed (WPM) and response timing

### 📊 Investment Manager
- `/gm analyze AAPL` → Gemini-powered stock analysis (free)
- `/cl analyze BBRI.JK` → Claude-powered stock analysis (paid, shows credit used)
- **Fundamental data via FMP API** — P/E, P/B, ROE, margins, D/E, FCF, EPS, beta
- **Technical analysis via Yahoo Finance** — RSI, SMA20/50, support/resistance levels
- **🕵️ Bandarmology** — Volume-based smart money tracking:
  - OBV trend (accumulation vs distribution)
  - Whale activity detection (🐋 >2x avg volume)
  - Smart money signals (🟢 ACC, 🔴 DIST, 🕵️ STEALTH, 💤 DRY-UP)
  - 7-day Bandar Score (net acc/dist)
- **Scalping specialization** — entry zones, momentum, volume profile
- **Trading plans** — entry, stop-loss, TP1, TP2, position sizing
- **Buy/Hold/Sell signals** with confidence percentage
- **💳 Claude credit tracking** — shows cost per analysis + remaining balance
- US stocks + IDX stocks (BBRI.JK, BBCA.JK, TLKM.JK...)

---

## 🖥️ Bot Manager — macOS Desktop App (v1.3.0)

A polished Electron app for managing the bot remotely via SSH — no terminal required.

### Panels

| Panel | What it does |
|---|---|
| VPS Connection | Configure SSH credentials, test connection, restart bot |
| Bot Persona | Edit character prompt, bot name, timezone |
| API Keys | Manage Gemini / Groq / Pollinations keys |
| Saved Contacts | Add/remove contact shortcuts |
| Bot Keywords | Group trigger word, auto-reply toggle |
| Human Behavior | Typing speed, read delay, burst pause |
| Group Behavior | Mention-only mode, allowed/blocked group JIDs |
| **📱 WhatsApp Number** | **Change linked number + in-app QR scanner** |
| Backup | VPS backup, download to Mac (dir picker), Google Drive upload |
| Import Settings | Import from VPS or XML file; export to XML |
| Live Logs | Real-time journal tail |
| Bot Status | Visual health dashboard |

### Changelog

#### v1.3.0 (2026-03-10)
- **📊 Investment Manager:** `/cl` and `/gm` prefix commands for AI-powered stock analysis
- **🕵️ Bandarmology:** Volume-based smart money tracking (OBV, whale, Bandar Score)
- **💳 Claude credit tracking:** Shows cost per analysis + remaining balance
- **🧠 Anthropic API Key:** New field in API Keys panel for Claude `/cl` analysis
- **📈 FMP API Key:** New field for Financial Modeling Prep fundamentals
- Yahoo Finance chart API (no crumb, works from EU VPS)
- Scalping analysis, trading plans, buy/hold/sell signals

#### v1.2.7 (2026-03-09)
- **💾 Local persistence:** All settings auto-saved and restored on app restart
- **🖼️ Image generation fix:** `[IMAGE_GEN:]` tag handler
- **👥 Group filter fix:** Trigger word must be at start of message

#### v1.2.1 (2026-03-09)
- **🐛 Fix:** Startup crash `SyntaxError: Identifier 'fs' has already been declared`
- **📱 WhatsApp Number panel:** Change linked account without SSH
- **📷 In-app QR scanner:** QR renders directly in app with auto-refresh

#### v1.2.0 (2026-03-09)
- **🔒 Settings survive upgrades:** Mirrored to `~/.bot-manager-settings.json` outside the app sandbox; auto-restored on next launch after reinstall
- **💾 Download backup to Mac:** SFTP download with native directory picker, saves chosen path for future use
- **📄 XML export/import:** Export all settings (VPS creds, API keys, persona, contacts, behavior, Google Drive creds) to `.xml`; import from file to restore without needing VPS access
- **🗂️ Import tabs:** "Import from VPS" | "Import from File" tab UI

#### v1.1.0 (2026-03-09)
- **📊 Visual Bot Status dashboard:** Hero status card with pulsing dot, 6 metric cards, animated RAM progress bar, color-coded log tail
- **☁️ Google Drive backup:** Full OAuth2 flow, folder name/ID resolution, SFTP → Drive pipeline
- **🐛 Fix:** `SyntaxError` when saving personas with special characters — fixed with Base64 encoding
- `daemon-reload` warning filtered from log tail

#### v1.0.0
- Initial release

### Download

| Platform | File |
|---|---|
| Apple Silicon (M1–M4) | `Bot Manager-1.3.0-arm64.dmg` |
| Intel Mac | `Bot Manager-1.3.0-x64.dmg` |

> **Upgrading from v1.1.x?** Your settings now auto-restore. As a safeguard, use **Import → Export Settings as XML** before upgrading to keep a local backup.

---

## 🏗️ Architecture

```
Incoming Message
      │
      ├─ /cl or /gm prefix? ───────────────────────────────► InvestorService
      │       /cl → Claude AI analysis                        (Yahoo Finance data)
      │       /gm → Gemini analysis
      │
      ├─ Has media (image/PDF/file)?  ──────────────────────► Gemini (multimodal)
      │
      ├─ Complex intent keyword detected? ─────────────────► Gemini
      │
      └─ Short/simple text? ───────────────────────────────► Groq (Llama 3.3 70B)
                                                                   │
                                                     Groq fails? ──┘
                                                                   └──► Gemini
```

---

## 🚀 Installation

See [INSTALL.md](./INSTALL.md) for full setup instructions.

### Prerequisites
- Node.js 18+
- Google Gemini API key(s) — free at [aistudio.google.com](https://aistudio.google.com/apikey)
- Groq API key (optional, free at [console.groq.com](https://console.groq.com))
- Pollinations API key (optional, free at [enter.pollinations.ai](https://enter.pollinations.ai))
- Claude API key (optional, for `/cl` investment analysis — [console.anthropic.com](https://console.anthropic.com))
- FMP API key (optional, for stock fundamentals — [financialmodelingprep.com](https://site.financialmodelingprep.com))

### Quick Start
```bash
git clone https://github.com/leoui/gemini-whatsapp-bot.git
cd gemini-whatsapp-bot
npm install
cp .env.example .env
nano .env       # Add your API keys
node server.js  # QR code appears in terminal
```

---

## ⚙️ Configuration

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Comma-separated keys for rotation |
| `GROQ_API_KEY` | Optional | Free simple-chat routing |
| `POLLINATIONS_API_KEY` | Optional | Image generation |
| `CLAUDE_API_KEY` | Optional | `/cl` investment analysis (Claude AI) |
| `FMP_API_KEY` | Optional | Stock fundamentals (P/E, ROE, margins) |
| `WHATSAPP_PHONE_NUMBER` | Optional | Pairing code fallback |
| `TZ` | Optional | Timezone (default: `Asia/Jakarta`) |

```
GEMINI_API_KEY=key1,key2,key3   # Each free key ≈ 500 req/day
```

---

## 📱 WhatsApp Connection

### Via Bot Manager App (easiest)
1. Open Bot Manager → **WhatsApp Number**
2. Click **Change WhatsApp Number**
3. Scan QR code that appears directly in the app

### Via Terminal
Run `node server.js` → scan QR in terminal with WhatsApp → **Linked Devices** → **Link a Device**.

---

## 🗣️ Usage Examples

| Request | AI | Result |
|---|---|---|
| *"Hello!"* | Groq | Greeting reply |
| *"Create an Excel of top 10 countries"* | Gemini | `.xlsx` sent |
| *"Generate image of a sunset"* | Gemini | Image sent |
| *"Remind me at 7 AM to exercise"* | Gemini | Reminder set |
| *"Where is the Eiffel Tower?"* | Gemini | Maps link |
| `/gm analyze AAPL` | Gemini | Stock analysis + trading plan |
| `/cl analyze BBRI.JK` | Claude | IDX stock analysis + scalping plan |
| `/gm is NVDA undervalued?` | Gemini | Valuation assessment |

---

## 📦 Tech Stack

| Component | Library |
|---|---|
| WhatsApp | [Baileys](https://github.com/WhiskeySockets/Baileys) `^6.7.17` |
| Gemini AI | `@google/genai ^0.9.0` |
| Claude AI | Anthropic API (`/v1/messages`) |
| Groq AI | `groq-sdk ^0.9.0` |
| Stock Data | Yahoo Finance chart API + FMP API |
| Desktop App | Electron 33 + Electron Builder |
| Excel | exceljs · PDF: pdfkit · PPTX: pptxgenjs |

---

## 📄 License

MIT License — see [LICENSE](./LICENSE).

## ⚠️ Disclaimer

Not affiliated with WhatsApp or Meta. Use responsibly per [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service).
