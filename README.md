# 🤖 Gemini WhatsApp Bot v2

A full-featured WhatsApp AI assistant powered by **Google Gemini** for complex tasks and **Groq (Llama 3.3 70B)** for fast, free simple conversations. Supports image generation, file creation, reminders, scheduling, Google Maps, and more.

Run headless on a VPS or with a desktop GUI via Electron — your AI assistant, always online.

Made with ☕ by [Lewi Verdatama](https://github.com/leoui)

---

## ✨ Features

### 🧠 Smart AI Routing (New in v2)
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
- QR Code scanning (primary)
- Phone number pairing code (automatic fallback after 3 QR failures)
- Auto-reconnect with exponential backoff
- Keep-alive mechanism to prevent disconnects

### 🎭 Human-Like Behavior
- Simulated read delays and typing indicators
- Configurable typing speed (WPM) and response timing
- Rate limiting to avoid detection

---

## 🏗️ Architecture

```
Incoming Message
      │
      ├─ Has media (image/PDF/file)?  ──────────────────────► Gemini (multimodal)
      │
      ├─ Complex intent keyword detected? ─────────────────► Gemini
      │   (excel, pdf, image gen, maps, reminder, calculate, etc.)
      │
      └─ Short/simple conversational text? ────────────────► Groq (Llama 3.3 70B)
                                                                   │
                                                     Groq fails? ──┘
                                                                   └──► Gemini (fallback)
```

### Image Generation Waterfall
```
Pollinations AI (flux/flux-2-dev/imagen-4/seedream)
        │ fails?
        ▼
Google Imagen 3 (free tier, key rotation)
        │ fails?
        ▼
Error message returned
```

---

## 🚀 Installation

See [INSTALL.md](./INSTALL.md) for detailed step-by-step instructions.

### Prerequisites
- Node.js 18+ ([download](https://nodejs.org/))
- Google Gemini API key(s) — free at [Google AI Studio](https://aistudio.google.com/apikey)
- Groq API key (optional, free at [console.groq.com](https://console.groq.com)) — no credit card
- Pollinations API key (optional, free at [enter.pollinations.ai](https://enter.pollinations.ai))

### Quick Start — Headless (VPS)
```bash
# 1. Clone
git clone https://github.com/leoui/gemini-whatsapp-bot.git
cd gemini-whatsapp-bot

# 2. Install
npm install

# 3. Configure
cp .env.example .env
nano .env  # Add your API keys

# 4. Start
node server.js
```

### Quick Start — Desktop GUI (Electron)
```bash
git clone https://github.com/leoui/gemini-whatsapp-bot.git
cd gemini-whatsapp-bot
npm install
npm start
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ Yes | Comma-separated Gemini keys for rotation |
| `GROQ_API_KEY` | Optional | Groq key for free simple-chat routing |
| `POLLINATIONS_API_KEY` | Optional | Pollinations key (`sk_...`) for image gen |
| `WHATSAPP_PHONE_NUMBER` | Optional | Phone for pairing code fallback |
| `TZ` | Optional | Timezone (default: `Asia/Jakarta`) |

### API Key Rotation
The bot supports unlimited Gemini API keys for rotation. When one key hits the rate limit, it automatically switches to the next:

```
GEMINI_API_KEY=key1,key2,key3,key4,key5
```

Each free Gemini key allows ~500 requests/day. With 5 keys = ~2,500 requests/day.

### Character Prompt
Customize the bot's personality by editing the config on the server:

```bash
cat > /tmp/update_prompt.js << 'SCRIPT'
const fs = require('fs');
const f = require('os').homedir() + '/.gemini-whatsapp-bot-config.json';
const c = JSON.parse(fs.readFileSync(f, 'utf8'));
c.characterPrompt = `Your name is MyBot. You are a helpful, friendly assistant on WhatsApp. Keep responses concise and natural. Answer in the same language as the user.`;
fs.writeFileSync(f, JSON.stringify(c, null, 2));
console.log('Updated!');
SCRIPT
node /tmp/update_prompt.js
sudo systemctl restart whatsapp-bot
```

---

## 📱 WhatsApp Connection

### Method 1: QR Code (Default)
Run `node server.js` and scan the QR code printed in the terminal with WhatsApp → **Linked Devices** → **Link a Device**.

### Method 2: Pairing Code (Fallback)
After 3 failed QR attempts, the bot automatically generates a pairing code. Set `WHATSAPP_PHONE_NUMBER` in your `.env` to speed this up.

---

## 🗣️ Usage Examples

| Request | AI Used | Result |
|---|---|---|
| *"Hello!"* | Groq (free) | Friendly greeting reply |
| *"How are you?"* | Groq (free) | Natural conversation |
| *"Create an Excel of top 10 countries"* | Gemini | `.xlsx` file sent |
| *"Generate image of a sunset"* | Gemini | Image sent |
| *"Remind me at 7 AM to exercise"* | Gemini | Reminder set |
| *"Where is the Eiffel Tower?"* | Gemini | Google Maps link |
| (send a PDF) | Gemini | File analyzed |

---

## 🛠️ Troubleshooting

### Bot shows wrong date/time
The bot uses dynamic date/time from the server's system clock. Set `TZ=Asia/Jakarta` in your environment.

### Image generation fails
Check `POLLINATIONS_API_KEY` is set correctly. Imagen 3 fallback uses `GEMINI_API_KEY`.

### WhatsApp keeps disconnecting (408 timeout)
The bot has built-in auto-reconnect. If it persists, check your VPS internet connection and firewall rules.

### Rate limit errors (429)
Add more Gemini API keys. Each free key allows ~500 requests/day. See API Key Rotation docs above.

### Groq not being used
Verify `GROQ_API_KEY` is set in your `.env` or systemd service file. Check startup logs for `[Groq] Service initialized`.

---

## 📦 Tech Stack

| Component | Library |
|---|---|
| WhatsApp protocol | [Baileys](https://github.com/WhiskeySockets/Baileys) `^6.7.17` |
| Gemini AI (complex) | [@google/genai](https://www.npmjs.com/package/@google/genai) `^0.9.0` (stable v1 API) |
| Groq AI (simple chat) | [groq-sdk](https://www.npmjs.com/package/groq-sdk) `^0.9.0` |
| Excel generation | exceljs |
| PDF generation | pdfkit |
| Presentation | pptxgenjs |
| Google APIs | googleapis |

---

## 📄 License

MIT License — see [LICENSE](./LICENSE) file.

## ⚠️ Disclaimer

This project is not affiliated with, authorized by, or endorsed by WhatsApp or Meta. Use responsibly and in accordance with [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service). Do not use for spam or bulk messaging.
