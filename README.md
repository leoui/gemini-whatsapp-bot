<p align="center">
  <img src="https://img.shields.io/badge/WhatsApp-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="WhatsApp" />
  <img src="https://img.shields.io/badge/Gemini_AI-8E75B2?style=for-the-badge&logo=google&logoColor=white" alt="Gemini AI" />
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License" />
</p>

<h1 align="center">🤖 Gemini WhatsApp Bot</h1>

<p align="center">
  <strong>A full-featured WhatsApp AI assistant powered by Google Gemini with multi-provider image generation, file creation, scheduling, and more.</strong>
</p>

<p align="center">
  <em>Run headless on a VPS or with a desktop GUI via Electron — your AI assistant, always online.</em>
</p>

---

## ✨ Features

### 🧠 AI Chat
- Powered by **Google Gemini 2.5 Flash** with automatic key rotation across multiple API keys
- Maintains per-chat conversation history with context awareness
- Bilingual support — responds in the same language and style as the user
- Dynamic real-time date/time awareness (no hardcoded dates)

### 🖼️ Image Generation (Multi-Provider Waterfall)
- **Primary:** [Pollinations AI](https://pollinations.ai) — free, no rate limits with API key
  - Models: `flux`, `flux-2-dev`, `imagen-4`, `seedream`
  - Auto-fallback through models if one fails
- **Fallback:** Google Imagen 3 — free tier with Gemini API key rotation
- Trigger with natural language: *"bikinin foto kucing lucu"*, *"generate image of a sunset"*

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
- Combine with file creation: *"Send +Budi an Excel of sales data"*

### 🗺️ Google Maps & Calendar
- Location search and Google Maps link sharing
- Google Calendar event creation from natural language

### 📎 File Analysis
- Analyze images, PDFs, and documents sent by users
- Extract text, summarize content, answer questions about files

### 🔗 WhatsApp Connection
- **QR Code scanning** (primary)
- **Phone number pairing code** (automatic fallback after 3 QR failures)
- Auto-reconnect with exponential backoff
- Keep-alive mechanism to prevent disconnects

### 🎭 Human-Like Behavior
- Simulated read delays and typing indicators
- Configurable typing speed (WPM) and response timing
- Rate limiting to avoid detection

---

## 🏗️ Architecture

```
gemini-whatsapp-bot/
├── server.js               # Headless entry point (VPS)
├── main.js                 # Electron entry point (Desktop GUI)
├── app.js                  # Electron renderer (GUI)
├── preload.js              # Electron preload bridge
├── package.json
├── .env.example            # Environment variable template
└── services/
    ├── gemini.js            # Gemini AI + image generation (Pollinations + Imagen 3)
    ├── whatsapp.js          # Baileys WhatsApp client + pairing code support
    ├── config.js            # Configuration management (file-based + electron-store)
    ├── fileManager.js       # File generation (Excel, PDF, PPTX, etc.)
    ├── scheduler.js         # Reminder & scheduling engine
    ├── calendar.js          # Google Calendar integration
    └── humanBehavior.js     # Human-like typing simulation
```

### Image Generation Waterfall

```
User: "bikinin foto kucing lucu"
         │
         ▼
  ┌──────────────────────────────┐
  │  1. Pollinations AI          │
  │     flux → flux-2-dev →      │
  │     imagen-4 → seedream      │
  └─────────┬────────────────────┘
            │ all failed?
            ▼
  ┌──────────────────────────────┐
  │  2. Google Imagen 3          │
  │     Rotate Gemini API keys   │
  └─────────┬────────────────────┘
            │ all exhausted?
            ▼
  "⏳ Semua provider gambar sedang
   tidak tersedia. Coba lagi nanti."
```

---

## 🚀 Installation

### Prerequisites

- **Node.js** 18+ ([download](https://nodejs.org/))
- **Google Gemini API key(s)** — free at [Google AI Studio](https://aistudio.google.com/apikey)
- **Pollinations API key** (optional, for image gen) — free at [enter.pollinations.ai](https://enter.pollinations.ai)

### Option A: Headless (VPS / Server)

Best for always-on deployment. No GUI required.

```bash
# 1. Clone the repository
git clone https://github.com/leoui/gemini-whatsapp-bot.git
cd gemini-whatsapp-bot

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
nano .env  # Add your API keys

# 4. Start the bot
GEMINI_API_KEY=your_key1,your_key2 node server.js
```

Scan the QR code that appears in the terminal with WhatsApp → Linked Devices → Link a Device.

#### Running as a systemd Service (Recommended)

```bash
# Create service file
sudo tee /etc/systemd/system/whatsapp-bot.service << EOF
[Unit]
Description=Gemini WhatsApp Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/whatsapp-bot
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=GEMINI_API_KEY=your_key1,your_key2,your_key3
Environment=POLLINATIONS_API_KEY=sk_your_pollinations_key
Environment=WHATSAPP_PHONE_NUMBER=628123456789
Environment=TZ=Asia/Jakarta

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-bot
sudo systemctl start whatsapp-bot

# View logs
sudo journalctl -u whatsapp-bot -f
```

### Option B: Desktop GUI (Electron)

For local use with a visual interface.

```bash
# 1. Clone and install
git clone https://github.com/leoui/gemini-whatsapp-bot.git
cd gemini-whatsapp-bot
npm install

# 2. Start with GUI
npm start
```

The Electron app will open with a QR code scanner, configuration panel, and chat monitor.

#### Building Desktop App

```bash
# macOS
npm run build

# Windows
npm run build:win

# All platforms
npm run build:all
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | ✅ | Comma-separated Gemini API keys for rotation |
| `POLLINATIONS_API_KEY` | ❌ | Pollinations AI secret key (`sk_...`) for image generation |
| `WHATSAPP_PHONE_NUMBER` | ❌ | Phone number for pairing code fallback (digits only, e.g. `628123456789`) |
| `TZ` | ❌ | Timezone (default: system timezone, e.g. `Asia/Jakarta`) |

### API Key Rotation

The bot supports **unlimited Gemini API keys** for rotation. When one key hits the rate limit, it automatically switches to the next:

```bash
GEMINI_API_KEY=key1,key2,key3,key4,key5
```

Each free Gemini key allows ~500 requests/day. With 5 keys, you get ~2,500 requests/day.

### Character Prompt

Customize the bot's personality by editing the config on the server:

```bash
cat > /tmp/update_prompt.js << 'SCRIPT'
const fs = require('fs');
const f = require('os').homedir() + '/.gemini-whatsapp-bot-config.json';
const c = JSON.parse(fs.readFileSync(f, 'utf8'));

c.characterPrompt = `Your name is MyBot.
You are a helpful, friendly assistant on WhatsApp.
Keep responses concise and natural.
Answer in the same language as the user.`;

fs.writeFileSync(f, JSON.stringify(c, null, 2));
console.log('Updated:', c.characterPrompt);
SCRIPT

node /tmp/update_prompt.js
sudo systemctl restart whatsapp-bot
```

---

## 📱 WhatsApp Connection Methods

### Method 1: QR Code (Default)

When the bot starts, a QR code appears in the terminal or GUI. Scan it with:

**WhatsApp → Settings → Linked Devices → Link a Device**

### Method 2: Pairing Code (Fallback)

If QR scanning fails 3 times, the bot automatically requests a pairing code (requires `WHATSAPP_PHONE_NUMBER`):

1. An 8-digit code appears in the logs: `PAIRING CODE: ABCD-EFGH`
2. Open **WhatsApp → Linked Devices → Link with phone number**
3. Enter the code

---

## 🗣️ Usage Examples

| You Say | Bot Does |
|---------|----------|
| *"Hello!"* | Responds conversationally |
| *"Bikinin foto kucing astronaut"* | Generates an AI image and sends it |
| *"Create an Excel file of top 10 countries by GDP"* | Generates and sends `.xlsx` file |
| *"Remind me at 7 AM to take medicine"* | Sets a timed reminder |
| *"Send +Novita good morning"* | Sends message to saved contact |
| *"Where is Monas Jakarta?"* | Sends Google Maps link |
| *"Jam berapa sekarang?"* | Responds with current date/time (WIB) |
| *(sends a photo)* | Analyzes and describes the image |
| *(sends a PDF)* | Reads and summarizes the document |

---

## 🔒 Security Notes

- API keys are stored in environment variables or the local config file — **never committed to Git**
- WhatsApp session credentials are stored locally in `.whatsapp-bot-session/`
- Pollinations AI secret keys (`sk_`) should never be exposed in client-side code
- The `.gitignore` excludes all sensitive files

---

## 🛠️ Troubleshooting

### Bot shows wrong date/time
The bot injects real-time WIB datetime into every API call. If it shows an old date, clear chat histories and restart:
```bash
rm -f ~/.whatsapp-bot-session/chat_histories.json
sudo systemctl restart whatsapp-bot
```

### Image generation fails
Check the logs for provider status:
```bash
sudo journalctl -u whatsapp-bot -f | grep ImageGen
```
The bot tries Pollinations AI first (4 models), then falls back to Google Imagen 3.

### WhatsApp keeps disconnecting (408 timeout)
The bot includes keep-alive mechanisms. If issues persist:
```bash
# Clear session and re-link
rm -rf ~/.whatsapp-bot-session/
sudo systemctl restart whatsapp-bot
```

### Rate limit errors (429)
Add more Gemini API keys to the rotation:
```bash
# Create keys at https://aistudio.google.com/apikey
GEMINI_API_KEY=key1,key2,key3,key4,key5
```

---

## 📦 Tech Stack

| Component | Technology |
|-----------|-----------|
| **AI Engine** | Google Gemini 2.5 Flash |
| **Image Generation** | Pollinations AI (FLUX, Imagen 4, Seedream) + Google Imagen 3 |
| **WhatsApp Client** | [Baileys](https://github.com/WhiskeySockets/Baileys) (WebSocket-based, no browser needed) |
| **Desktop GUI** | Electron |
| **File Generation** | ExcelJS, PDFKit, PptxGenJS |
| **Runtime** | Node.js 18+ |

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

## ⚠️ Disclaimer

This project is not affiliated with, authorized by, or endorsed by WhatsApp or Meta. Use responsibly and in accordance with [WhatsApp's Terms of Service](https://www.whatsapp.com/legal/terms-of-service). Do not use for spam or bulk messaging.

---

<p align="center">
  Made with ☕ by <a href="https://github.com/leoui">Lewi Verdatama</a>
</p>
