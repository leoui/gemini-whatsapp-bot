# INSTALL.md — Installation & Deployment Guide

## Quick Navigation
- [VPS Installation (Recommended)](#-vps-installation-headless)
- [Desktop Installation (Electron GUI)](#-desktop-installation-electron-gui)
- [API Keys Setup](#-api-keys-setup)
- [systemd Service Setup](#-systemd-service-setup)
- [Restore from Backup](#-restore-from-backup)
- [Upgrading](#-upgrading)

---

## 🖥️ VPS Installation (Headless)

### Step 1 — System Requirements

| Requirement | Minimum |
|---|---|
| OS | Ubuntu 20.04+ / Debian 11+ |
| RAM | 512 MB (1 GB recommended) |
| Disk | 1 GB free |
| Node.js | v18 or later |
| Internet | Required (outbound HTTPS) |

### Step 2 — Install Node.js 18+

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # Should print v18.x.x or later
```

### Step 3 — Clone & Install

```bash
git clone https://github.com/leoui/gemini-whatsapp-bot.git
cd gemini-whatsapp-bot
npm install
```

### Step 4 — Configure Environment

```bash
cp .env.example .env
nano .env
```

Edit the `.env` file with your keys:

```dotenv
# Required
GEMINI_API_KEY=your_key_1,your_key_2

# Optional (highly recommended — free simple-chat routing)
GROQ_API_KEY=gsk_your_groq_key

# Optional (for image generation)
POLLINATIONS_API_KEY=sk_your_pollinations_key

# Optional (for pairing code fallback)
WHATSAPP_PHONE_NUMBER=628123456789

TZ=Asia/Jakarta
```

### Step 5 — First Run & QR Code Scan

```bash
node server.js
```

A QR code will appear in the terminal. Open WhatsApp on your phone:
1. Tap **⋮ (Menu)** → **Linked Devices**
2. Tap **Link a Device**
3. Scan the QR code

The bot will confirm: `✅ WhatsApp connected as YourName`

Press `Ctrl+C` to stop. Then proceed to set up systemd for persistent running.

---

## 🔧 systemd Service Setup

This makes the bot start automatically on boot and restart if it crashes.

### Step 1 — Create the Service File

```bash
sudo tee /etc/systemd/system/whatsapp-bot.service << EOF
[Unit]
Description=Gemini WhatsApp Bot v2
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
Environment=GROQ_API_KEY=gsk_your_groq_key
Environment=POLLINATIONS_API_KEY=sk_your_pollinations_key
Environment=WHATSAPP_PHONE_NUMBER=628123456789
Environment=TZ=Asia/Jakarta

[Install]
WantedBy=multi-user.target
EOF
```

> ⚠️ Replace the `Environment=` values with your actual keys.

### Step 2 — Enable & Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-bot
sudo systemctl start whatsapp-bot
```

### Step 3 — Verify

```bash
sudo systemctl status whatsapp-bot
```

Expected output: `Active: active (running)`

### Useful Commands

```bash
# View live logs
sudo journalctl -u whatsapp-bot -f

# Restart the bot
sudo systemctl restart whatsapp-bot

# Stop the bot
sudo systemctl stop whatsapp-bot

# Check health API
curl http://localhost:3001/health

# Check status API
curl http://localhost:3001/status
```

---

## 💻 Desktop Installation (Electron GUI)

### Requirements
- macOS 10.15+ or Windows 10+
- Node.js 18+

### Steps

```bash
git clone https://github.com/leoui/gemini-whatsapp-bot.git
cd gemini-whatsapp-bot
npm install
npm start
```

The Electron app will open with a QR code scanner and configuration panel.

### Build Standalone App

```bash
# macOS (.dmg)
npm run build

# Windows (.exe installer + portable)
npm run build:win

# All platforms
npm run build:all
```

---

## 🔑 API Keys Setup

### Google Gemini API Key (Required)
1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **Create API key**
3. Copy the key — no credit card required for free tier
4. ✅ Free tier: ~500 requests/day per key
5. Add multiple keys comma-separated: `key1,key2,key3`

### Groq API Key (Optional — Recommended)
1. Go to [console.groq.com](https://console.groq.com)
2. Sign up with email — **no credit card required**
3. Click **API Keys** → **Create API Key**
4. Copy the `gsk_...` key
5. ✅ Free tier: ~14,400 requests/day (Llama 3.3 70B)

### Pollinations API Key (Optional)
1. Go to [enter.pollinations.ai](https://enter.pollinations.ai)
2. Sign up and generate a key
3. ✅ Free: no strict daily limit with API key

---

## 🔄 Restore from Backup

If something goes wrong after an upgrade, restore the backup:

### Step 1 — Stop the Service
```bash
sudo systemctl stop whatsapp-bot
```

### Step 2 — Restore from Backup Archive
```bash
# On your VPS, navigate to where the backup is
cd /root

# Extract the backup (replace filename with your actual backup)
tar -xzf whatsapp-bot-backup-YYYYMMDD-HHMMSS.tar.gz

# If the current folder exists, remove it first
rm -rf /root/whatsapp-bot

# Rename restored folder
mv whatsapp-bot /root/whatsapp-bot  # (already in place if same name)

# Reinstall dependencies
cd /root/whatsapp-bot
npm install
```

### Step 3 — Restart
```bash
sudo systemctl start whatsapp-bot
sudo systemctl status whatsapp-bot
```

> ℹ️ The backup **does not include** `node_modules` or the WhatsApp session (`.whatsapp-bot-session`). You only need to re-run `npm install` and re-scan the QR code if the session was lost.

---

## ⬆️ Upgrading

### From v1 to v2

v2 changes:
- Replaced `@google/generative-ai` (deprecated) with `@google/genai` SDK
- Added Groq smart routing
- Added `services/router.js` and `services/groq.js`

```bash
# 1. Stop current bot
sudo systemctl stop whatsapp-bot

# 2. Backup (always before upgrading!)
cd /root
tar --exclude='whatsapp-bot/node_modules' --exclude='whatsapp-bot/.whatsapp-bot-session' \
    -czf whatsapp-bot-backup-$(date +%Y%m%d).tar.gz whatsapp-bot

# 3. Pull latest code
cd /root/whatsapp-bot
git pull origin main

# 4. Install new dependencies
npm install

# 5. Add GROQ_API_KEY to your systemd service (optional but recommended)
sudo nano /etc/systemd/system/whatsapp-bot.service
# Add: Environment=GROQ_API_KEY=gsk_your_key

# 6. Reload and restart
sudo systemctl daemon-reload
sudo systemctl start whatsapp-bot
sudo journalctl -u whatsapp-bot -f
```

---

## 🔒 Security Notes

- Never commit your `.env` file or API keys to Git (`.gitignore` covers this)
- The Status API (port 3001) is bound to `0.0.0.0` — consider blocking it with `ufw` if not needed:
  ```bash
  sudo ufw deny 3001
  ```
- WhatsApp session files in `~/.whatsapp-bot-session` contain authentication tokens — keep them private
- Rotate your API keys regularly
