# INSTALL.md — Installation & Deployment Guide

## Quick Navigation
- [VPS Installation](#-vps-installation-headless)
- [systemd Service Setup](#-systemd-service-setup)
- [Bot Manager macOS App](#-bot-manager-macos-app)
- [API Keys Setup](#-api-keys-setup)
- [Investment Analysis Setup](#-investment-analysis-setup)
- [Upgrading](#-upgrading)
- [Restore from Backup](#-restore-from-backup)

---

## 🖥️ VPS Installation (Headless)

### System Requirements

| Requirement | Minimum |
|---|---|
| OS | Ubuntu 20.04+ / Debian 11+ |
| RAM | 512 MB (1 GB recommended) |
| Disk | 1 GB free |
| Node.js | v18 or later |
| Internet | Required (outbound HTTPS) |

### Install Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # Should print v18.x.x or later
```

### Clone & Install

```bash
git clone https://github.com/leoui/gemini-whatsapp-bot.git
cd gemini-whatsapp-bot
npm install
```

### Configure Environment

```bash
cp .env.example .env
nano .env
```

```dotenv
# Required
GEMINI_API_KEY=your_key_1,your_key_2

# Optional (free simple-chat routing via Groq)
GROQ_API_KEY=gsk_your_key

# Optional (image generation)
POLLINATIONS_API_KEY=sk_your_key

# Optional (pairing code fallback)
WHATSAPP_PHONE_NUMBER=628123456789

TZ=Asia/Jakarta
```

> ⚠️ Never commit this file. It's in `.gitignore` by default.

### First Run & QR Scan

```bash
node server.js
```

A QR code appears in the terminal. Open WhatsApp → **⋮ Menu** → **Linked Devices** → **Link a Device** → scan QR.

Or use the **Bot Manager app** to change number and scan QR directly in the app (see below).

---

## 🔧 systemd Service Setup

Makes the bot start on boot and restart on crash.

### Create the Service File

```bash
sudo tee /etc/systemd/system/whatsapp-bot.service << EOF
[Unit]
Description=Gemini WhatsApp Bot v3
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/whatsapp-bot
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=GEMINI_API_KEY=your_key1,your_key2
Environment=GROQ_API_KEY=gsk_your_key
Environment=POLLINATIONS_API_KEY=sk_your_key
Environment=CLAUDE_API_KEY=sk-ant-your_key
Environment=TZ=Asia/Jakarta

[Install]
WantedBy=multi-user.target
EOF
```

> ⚠️ Replace `Environment=` values with your actual API keys.

### Enable & Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-bot
sudo systemctl start whatsapp-bot
sudo systemctl status whatsapp-bot
```

Expected: `Active: active (running)`

### Useful Commands

```bash
# Live logs
sudo journalctl -u whatsapp-bot -f

# Restart / Stop
sudo systemctl restart whatsapp-bot
sudo systemctl stop whatsapp-bot

# Health check
curl http://localhost:3001/health
```

---

## 💻 Bot Manager macOS App (v1.3.0)

A native macOS desktop app to manage the bot remotely via SSH — no terminal needed.

### Install

1. Download the correct DMG for your Mac:
   - **Apple Silicon (M1–M4):** `Bot Manager-1.3.0-arm64.dmg`
   - **Intel Mac:** `Bot Manager-1.3.0-x64.dmg`
2. Open the DMG → drag **Bot Manager** to Applications
3. Launch the app — your settings auto-restore from the previous version

### First-Time Setup

1. **VPS Connection panel** → enter your VPS IP, SSH port (22), username, password, bot directory, and service name
2. Click **Save Connection** then **Test Connection**
3. Go to **Import Settings** → **Import from VPS** to auto-fill all panels

### Upgrade Notes

- **From v1.2.x:** Settings auto-restore — just drag-replace in Applications and launch
- **From v1.1.x or earlier:** Before upgrading, go to **Import → Export Settings as XML** to save a backup, then restore it after upgrade via **Import from File**
- The app never touches `~/.bot-manager-settings.json` on uninstall (only cleared by the explicit Uninstall panel)

### Backup & Restore Settings (XML)

**Export:** Import panel → Export Settings card → **Export Settings as XML**

**Import:** Import panel → Import from File tab → **Browse & Import XML File**

> 🔒 The XML contains your VPS password and API keys — keep it private.

### Changing the WhatsApp Number

1. Go to **WhatsApp Number** panel (under MONITOR in sidebar)
2. Click **Change WhatsApp Number** → confirm
3. The app clears the Baileys session on VPS and restarts the bot
4. QR code appears automatically in the app — scan with WhatsApp → Linked Devices → Link a Device

### Google Drive Backup Setup (Optional)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project → Enable **Google Drive API**
3. APIs & Services → Credentials → **Create OAuth Client ID** → Desktop app
4. Copy Client ID and Secret → paste in Bot Manager **Backup** → Google Drive section
5. Click **Sign in with Google** → authorize → upload backups to Drive

---

## 🔑 API Keys Setup

### Google Gemini API Key (Required)
1. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → Create API key
2. Free tier: ~500 requests/day per key
3. Add multiple keys for rotation: `key1,key2,key3`

### Groq API Key (Recommended, Free)
1. [console.groq.com](https://console.groq.com) → Sign up (no credit card)
2. API Keys → Create API Key → copy `gsk_...`
3. Free tier: ~14,400 requests/day (Llama 3.3 70B)

### Pollinations API Key (Optional)
1. [enter.pollinations.ai](https://enter.pollinations.ai) → Sign up
2. Free: no strict daily limit with API key

### Claude API Key (Optional — for `/cl` investment analysis)
1. [console.anthropic.com](https://console.anthropic.com) → Sign up
2. API Keys → Create Key → copy `sk-ant-...`
3. Pay-as-you-go: ~$0.01–$0.03 per stock analysis

---

## 📊 Investment Analysis Setup

The bot includes an AI-powered investment manager for US and IDX (Indonesia) stocks.

### How It Works

1. **User sends** `/gm analyze AAPL` or `/cl analyze BBRI.JK`
2. **Bot fetches** real-time data from Yahoo Finance (free, no key needed)
3. **AI analyzes** the data and returns: valuation, growth, fundamentals, scalping levels, trading plan, buy/hold/sell signal

### Supported Commands

| Command | Description |
|---|---|
| `/gm analyze AAPL` | Gemini analysis of Apple |
| `/cl analyze BBRI.JK` | Claude analysis of Bank BRI |
| `/gm is NVDA undervalued?` | Valuation check |
| `/cl trading plan TLKM.JK` | Scalping trading plan |

### Configuration

- `/gm` uses your existing **Gemini API keys** (no extra config)
- `/cl` requires a **Claude API key** — add to systemd service:
  ```bash
  sudo systemctl edit whatsapp-bot
  # Add: Environment=CLAUDE_API_KEY=sk-ant-your_key
  sudo systemctl daemon-reload && sudo systemctl restart whatsapp-bot
  ```

### Data Coverage

| Market | Ticker Format | Examples |
|---|---|---|
| US (NYSE/NASDAQ) | `AAPL`, `NVDA` | Standard tickers |
| Indonesia (IDX) | `BBRI.JK`, `BBCA.JK` | Append `.JK` |

| Data Source | What It Provides |
|---|---|
| Yahoo Finance (chart API) | Price, volume, 52W range, RSI, SMA, S/R |
| FMP API (free, 25 req/day) | P/E, P/B, ROE, margins, D/E, FCF, EPS, beta |
| Bandarmology (algorithmic) | OBV trend, smart money signals, whale detection, Bandar Score |

### Credit Tracking (`/cl` only)
Every Claude response shows:
- **Credit used** for that specific analysis
- **Remaining balance** (estimated from token usage)
- Pricing: Claude Sonnet 4 = $3/M input, $15/M output tokens

---

## ⬆️ Upgrading the Bot (VPS)

```bash
# 1. Backup first (always!)
cd /root
tar --exclude='whatsapp-bot/node_modules' \
    --exclude='whatsapp-bot/auth_info_baileys' \
    -czf whatsapp-bot-backup-$(date +%Y%m%d).tar.gz whatsapp-bot

# 2. Pull and install
cd /root/whatsapp-bot
git pull origin main
npm install

# 3. Reload systemd and restart
sudo systemctl daemon-reload
sudo systemctl restart whatsapp-bot
sudo journalctl -u whatsapp-bot -f
```

---

## 🔄 Restore from Backup

```bash
# Stop service
sudo systemctl stop whatsapp-bot

# Extract backup
cd /root
tar -xzf whatsapp-bot-backup-YYYYMMDD.tar.gz

# Reinstall deps
cd /root/whatsapp-bot
npm install

# Start
sudo systemctl start whatsapp-bot
```

> The backup does **not** include `node_modules` or the WhatsApp session (`auth_info_baileys`). Re-run `npm install` and re-scan the QR after restore.

---

## 🔒 Security Notes

- Never commit `.env` or API keys to Git (`.gitignore` covers this)
- The Health API (port 3001) is bound to `0.0.0.0` — block externally if not needed:
  ```bash
  sudo ufw deny 3001
  ```
- WhatsApp session files in `auth_info_baileys/` contain auth tokens — keep them private
- Bot Manager XML exports contain credentials — store them securely
