'use strict';
/**
 * Bot Manager — Electron Main Process
 * macOS SSH-based configuration app for Gemini WhatsApp Bot VPS
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { Client: SshClient } = require('ssh2');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');


const store = new Store({ name: 'bot-manager-config' });

// ── Stable settings backup (survives app reinstalls/upgrades) ──
// Mirrors all store data to ~/.bot-manager-settings.json which lives
// OUTSIDE the app's userData and is never deleted on upgrade/reinstall.
const STABLE_SETTINGS_PATH = path.join(os.homedir(), '.bot-manager-settings.json');

function saveStableSettings() {
    try { fs.writeFileSync(STABLE_SETTINGS_PATH, JSON.stringify(store.store, null, 2), 'utf8'); } catch { }
}

function restoreStableSettings() {
    if (!fs.existsSync(STABLE_SETTINGS_PATH)) return;
    try {
        const saved = JSON.parse(fs.readFileSync(STABLE_SETTINGS_PATH, 'utf8'));
        // Only restore if current store is essentially empty (just installed / reinstalled)
        const hasVps = !!store.get('vps.host');
        if (!hasVps && saved['vps.host']) {
            Object.entries(saved).forEach(([k, v]) => store.set(k, v));
        }
    } catch { }
}

// Auto-restore on startup
restoreStableSettings();

let mainWindow;

app.on('ready', () => {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 900,
        minHeight: 600,
        titleBarStyle: 'hiddenInset',
        vibrancy: 'sidebar',
        backgroundColor: '#1a1b2e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) app.emit('ready');
});

// ────────────────────────────────────────────────────────────
// Local config store (VPS credentials, saved locally only)
// ────────────────────────────────────────────────────────────
ipcMain.handle('store:get', (_e, key) => store.get(key));
ipcMain.handle('store:set', (_e, key, value) => {
    store.set(key, value);
    saveStableSettings(); // mirror to stable path for upgrade resilience
    return true;
});
ipcMain.handle('store:getAll', () => store.store);

// ────────────────────────────────────────────────────────────
// IPC: Native dialog helpers
// ────────────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose Save Directory',
        properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openFile', async (_e, { title = 'Open File', filters = [] } = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title,
        properties: ['openFile'],
        filters,
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:saveFile', async (_e, { title = 'Save File', defaultPath = '', filters = [] } = {}) => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title,
        defaultPath,
        filters,
    });
    return result.canceled ? null : result.filePath;
});

// ────────────────────────────────────────────────────────────
// IPC: Settings export to XML
// ────────────────────────────────────────────────────────────
function settingsToXml(data) {
    const escape = (s) => String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const xmlVal = (v) => {
        if (typeof v === 'object' && v !== null) return `<json>${escape(JSON.stringify(v))}</json>`;
        return escape(v);
    };

    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<BotManagerSettings exported="${new Date().toISOString()}">`,
    ];

    // Sanitised export — skip secrets that shouldn't be in a file
    const safe = { ...data };
    // Keep credentials for the user's own backup; they're saving to their own Mac
    Object.entries(safe).forEach(([k, v]) => {
        const tag = k.replace(/[^a-zA-Z0-9._-]/g, '_');
        lines.push(`  <setting key="${escape(k)}">${xmlVal(v)}</setting>`);
    });
    lines.push('</BotManagerSettings>');
    return lines.join('\n');
}

function xmlToSettings(xmlStr) {
    const settings = {};
    const re = /<setting key="([^"]+)">([\s\S]*?)<\/setting>/g;
    let m;
    while ((m = re.exec(xmlStr)) !== null) {
        const key = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        let val = m[2];
        if (val.startsWith('<json>') && val.endsWith('</json>')) {
            const inner = val.slice(6, -7).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
            try { val = JSON.parse(inner); } catch { /* keep as string */ }
        } else {
            val = val.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        }
        settings[key] = val;
    }
    return settings;
}

ipcMain.handle('settings:export', async () => {
    try {
        const savePath = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Settings',
            defaultPath: path.join(os.homedir(), 'Desktop', `bot-manager-settings-${new Date().toISOString().slice(0, 10)}.xml`),
            filters: [{ name: 'XML Settings', extensions: ['xml'] }],
        });
        if (savePath.canceled || !savePath.filePath) return { ok: false, cancelled: true };
        const xml = settingsToXml(store.store);
        fs.writeFileSync(savePath.filePath, xml, 'utf8');
        return { ok: true, path: savePath.filePath };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('settings:importFromFile', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Import Settings from XML',
            properties: ['openFile'],
            filters: [{ name: 'XML Settings', extensions: ['xml'] }],
        });
        if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
        const xmlStr = fs.readFileSync(result.filePaths[0], 'utf8');
        const settings = xmlToSettings(xmlStr);
        if (!Object.keys(settings).length) throw new Error('No valid settings found in file');
        // Apply to store
        Object.entries(settings).forEach(([k, v]) => store.set(k, v));
        saveStableSettings();
        return { ok: true, settings, path: result.filePaths[0] };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Download latest VPS backup to a local directory
// ────────────────────────────────────────────────────────────
ipcMain.handle('vps:downloadBackup', async (_e, { localDir } = {}) => {
    try {
        // If no dir provided, show picker
        let saveDir = localDir;
        if (!saveDir) {
            const result = await dialog.showOpenDialog(mainWindow, {
                title: 'Choose Directory to Save Backup',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
            saveDir = result.filePaths[0];
        }

        // Find latest backup on VPS
        const latestFile = await sshExec('ls -t /root/whatsapp-bot-backup-*.tar.gz 2>/dev/null | head -1');
        if (!latestFile || !latestFile.trim() || latestFile.includes('[ERR]')) {
            throw new Error('No backup found on VPS. Take a backup first.');
        }
        const remoteFile = latestFile.trim();
        const filename = path.basename(remoteFile);
        const localPath = path.join(saveDir, filename);

        // Download via SFTP
        await new Promise((resolve, reject) => {
            const cfg = getVpsConfig();
            const conn = new SshClient();
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) { conn.end(); return reject(new Error('SFTP session failed: ' + err.message)); }
                    sftp.fastGet(remoteFile, localPath, (err) => {
                        conn.end();
                        if (err) reject(new Error('SFTP download failed: ' + err.message));
                        else resolve();
                    });
                });
            }).on('error', e => reject(new Error('SSH connection failed: ' + e.message)))
                .connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, readyTimeout: 15000 });
        });

        return { ok: true, filename, localPath, saveDir };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});


// ────────────────────────────────────────────────────────────
// SSH helpers
// ────────────────────────────────────────────────────────────
function getVpsConfig() {
    return {
        host: store.get('vps.host', ''),
        port: store.get('vps.port', 22),
        username: store.get('vps.username', 'root'),
        password: store.get('vps.password', ''),
        botDir: store.get('vps.botDir', '/root/whatsapp-bot'),
        serviceName: store.get('vps.serviceName', 'whatsapp-bot'),
    };
}

function sshExec(commands) {
    return new Promise((resolve, reject) => {
        const cfg = getVpsConfig();
        if (!cfg.host || !cfg.password) return reject(new Error('VPS not configured'));

        const conn = new SshClient();
        const output = [];

        conn.on('ready', () => {
            const script = Array.isArray(commands) ? commands.join(' && ') : commands;
            conn.exec(script, (err, stream) => {
                if (err) { conn.end(); return reject(err); }
                stream.stdout.on('data', d => output.push(d.toString()));
                stream.stderr.on('data', d => output.push('[ERR] ' + d.toString()));
                stream.on('close', () => { conn.end(); resolve(output.join('').trim()); });
            });
        })
            .on('error', reject)
            .connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, readyTimeout: 10000 });
    });
}

// ────────────────────────────────────────────────────────────
// IPC: Connection Test
// ────────────────────────────────────────────────────────────
ipcMain.handle('ssh:test', async () => {
    try {
        const result = await sshExec('echo "OK" && node --version && systemctl is-active whatsapp-bot');
        return { ok: true, output: result };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Read bot config from VPS
// ────────────────────────────────────────────────────────────
ipcMain.handle('bot:readConfig', async () => {
    const { botDir } = getVpsConfig();
    try {
        // Read config.json (internal bot config)
        const configJson = await sshExec(`cat ${botDir}/node_modules/.cache/bot-config.json 2>/dev/null || node -e "const c=require('./${botDir.split('/').pop()}/services/config');console.log(JSON.stringify(c.store||{}))" 2>/dev/null || echo "{}"`);

        // Read systemd service for env vars
        const { serviceName } = getVpsConfig();
        const serviceFile = await sshExec(`cat /etc/systemd/system/${serviceName}.service 2>/dev/null || echo ""`);

        // Parse env vars from service file
        const envVars = {};
        (serviceFile.match(/^Environment=(.+)$/gm) || []).forEach(line => {
            const [k, ...rest] = line.replace('Environment=', '').split('=');
            envVars[k] = rest.join('=');
        });

        // Read config from bot config file
        const botConfigPath = `${botDir}/../.gemini-whatsapp-bot-config.json`;
        const cfgRaw = await sshExec(`cat ${botConfigPath} 2>/dev/null || echo "{}"`);
        let botConfig = {};
        try { botConfig = JSON.parse(cfgRaw || '{}'); } catch { }

        return { ok: true, envVars, botConfig };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Gemini model selection
// ────────────────────────────────────────────────────────────

ipcMain.handle('bot:getModel', async () => {
    const { botDir } = getVpsConfig();
    try {
        const configPath = `${botDir}/../.gemini-whatsapp-bot-config.json`;
        const raw = await sshExec(`cat ${configPath} 2>/dev/null || echo "{}"`);
        let cfg = {};
        try { cfg = JSON.parse(raw || '{}'); } catch { }
        return { ok: true, model: cfg.geminiModel || 'gemini-2.5-flash' };
    } catch (e) {
        return { ok: false, error: e.message, model: 'gemini-2.5-flash' };
    }
});

ipcMain.handle('bot:setModel', async (_e, modelId) => {
    const { botDir } = getVpsConfig();
    const ALLOWED = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];
    if (!ALLOWED.includes(modelId)) {
        return { ok: false, error: `Unknown model: ${modelId}` };
    }
    try {
        const configPath = `${botDir}/../.gemini-whatsapp-bot-config.json`;
        // Read → patch geminiModel → write back
        const pyScript = `
import json, os
p = '${configPath}'
c = json.load(open(p)) if os.path.exists(p) else {}
c['geminiModel'] = '${modelId}'
json.dump(c, open(p, 'w'), indent=2)
print('OK')
`.trim();
        const result = await sshExec(`python3 -c "${pyScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
        if (!result.includes('OK')) throw new Error('Python update failed: ' + result);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Save individual config sections to VPS
// ────────────────────────────────────────────────────────────

// Update systemd env var (GEMINI_API_KEY, GROQ_API_KEY, etc.)
// Uses base64 encoding to safely handle arbitrarily long values
// (e.g. 7+ Gemini keys as a comma-separated string).
ipcMain.handle('vps:setEnv', async (_e, envVars) => {
    const { serviceName } = getVpsConfig();
    try {
        // Encode the update dict as base64 JSON — avoids all shell escaping issues
        const b64 = Buffer.from(JSON.stringify({ serviceName, envVars })).toString('base64');

        // Python script that decodes the payload and patches the service file
        const pyCode = [
            'import re, json, base64, sys',
            `payload = json.loads(base64.b64decode('${b64}').decode('utf-8'))`,
            'svc = payload["serviceName"]',
            'updates = payload["envVars"]',
            'f = f"/etc/systemd/system/{svc}.service"',
            'c = open(f).read()',
            'for k, v in updates.items():',
            '    pattern = rf"Environment={k}=.*"',
            '    replacement = f"Environment={k}={v}"',
            '    if re.search(pattern, c):',
            '        c = re.sub(pattern, replacement, c)',
            '    else:',
            '        c = c.replace("[Service]\\n", f"[Service]\\nEnvironment={k}={v}\\n", 1)',
            'open(f, "w").write(c)',
            'print("OK")',
        ].join('; ');

        await sshExec([
            `python3 -c "${pyCode}"`,
            'systemctl daemon-reload',
            `systemctl restart ${serviceName}`,
            'sleep 2',
            `systemctl is-active ${serviceName}`,
        ]);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// Update bot config (persona, contacts, etc.) via SSH node command
ipcMain.handle('bot:saveConfig', async (_e, configPatch) => {
    const { botDir } = getVpsConfig();
    try {
        // Base64-encode the JSON payload so it survives shell escaping intact.
        // This handles newlines, quotes, emoji, and any other special chars
        // that would break an inline node -e "..." command.
        const b64 = Buffer.from(JSON.stringify(configPatch)).toString('base64');
        const nodeCmd = [
            `const Config = require('./services/config');`,
            `const patch = JSON.parse(Buffer.from('${b64}', 'base64').toString('utf8'));`,
            `Object.entries(patch).forEach(([k, v]) => Config.set(k, v));`,
            `console.log('SAVED:', Object.keys(patch).join(', '));`,
        ].join(' ');
        const script = `cd ${botDir} && node -e "${nodeCmd}"`;

        const result = await sshExec(script);
        return { ok: true, output: result };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});


// Restart the bot service
ipcMain.handle('vps:restart', async () => {
    const { serviceName } = getVpsConfig();
    try {
        await sshExec([`systemctl restart ${serviceName}`, 'sleep 2', `systemctl is-active ${serviceName}`]);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Reconnect — wipe session + 120s cooldown + restart
// Uses ipcMain.on (not handle) so we push streaming progress
// events back to the renderer during the long wait.
// ────────────────────────────────────────────────────────────
ipcMain.on('vps:reconnect', async (event) => {
    const { serviceName } = getVpsConfig();

    // Helper: run one SSH command and stream its output line-by-line
    function pushStep(label, commands) {
        return new Promise((resolve) => {
            const cfg = getVpsConfig();
            const conn = new SshClient();
            const script = Array.isArray(commands) ? commands.join(' && ') : commands;

            event.sender.send('reconnect:update', `\n⏳ ${label}`);

            conn.on('ready', () => {
                conn.exec(script, (err, stream) => {
                    if (err) {
                        event.sender.send('reconnect:update', `❌ ${err.message}`);
                        conn.end();
                        return resolve();
                    }
                    stream.stdout.on('data', d => {
                        const lines = d.toString().split('\n').filter(l => l.trim());
                        lines.forEach(l => event.sender.send('reconnect:update', `  ${l}`));
                    });
                    stream.stderr.on('data', d => {
                        const lines = d.toString().split('\n').filter(l => l.trim());
                        lines.forEach(l => event.sender.send('reconnect:update', `  [err] ${l}`));
                    });
                    stream.on('close', () => { conn.end(); resolve(); });
                });
            })
                .on('error', e => {
                    event.sender.send('reconnect:update', `❌ SSH error: ${e.message}`);
                    resolve();
                })
                .connect({
                    host: cfg.host, port: cfg.port,
                    username: cfg.username, password: cfg.password,
                    readyTimeout: 15000,
                });
        });
    }

    try {
        event.sender.send('reconnect:start');

        // Step 1 — Stop bot
        await pushStep('Stopping the bot service…', `systemctl stop ${serviceName}`);
        event.sender.send('reconnect:update', '✅ Bot stopped');

        // Step 2 — Wipe session files only (not the full directory)
        await pushStep('Clearing WhatsApp session credentials…', [
            'rm -f ~/.whatsapp-bot-session/creds.json',
            'rm -f ~/.whatsapp-bot-session/pre-key-*.json',
            'rm -f ~/.whatsapp-bot-session/session-*.json',
            'rm -f ~/.whatsapp-bot-session/app-state-sync-key-*.json',
            'echo "Session files cleared"',
        ]);
        event.sender.send('reconnect:update', '✅ Session cleared');

        // Step 3 — 120-second cooldown (server-side sleep so reconnect is clean)
        event.sender.send('reconnect:update', '\n⏳ Waiting 120s for WhatsApp servers to release the session…');
        event.sender.send('reconnect:countdown', 120);
        await pushStep('Cooldown (120 seconds)…', 'sleep 120 && echo "Cooldown complete"');
        event.sender.send('reconnect:update', '✅ Cooldown complete');

        // Step 4 — Start bot
        await pushStep('Starting the bot service…', `systemctl start ${serviceName}`);
        event.sender.send('reconnect:update', '✅ Bot started');

        // Step 5 — Tail journal briefly to show boot lines / QR
        event.sender.send('reconnect:update', '\n📋 Recent logs:');
        await pushStep('Fetching boot logs…', `sleep 3 && journalctl -u ${serviceName} -n 20 --no-pager --output=short 2>/dev/null | grep -v "^--"`);

        event.sender.send('reconnect:done');
    } catch (err) {
        event.sender.send('reconnect:update', `\n❌ Reconnect failed: ${err.message}`);
        event.sender.send('reconnect:done');
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Change WhatsApp Account (wipe session → new QR code)
// ────────────────────────────────────────────────────────────
ipcMain.handle('vps:changeNumber', async () => {
    const { serviceName } = getVpsConfig();
    try {
        await sshExec([
            // Stop the bot
            `systemctl stop ${serviceName}`,
            'sleep 1',
            // Wipe the Baileys session directory (auth credentials)
            'rm -rf /root/.whatsapp-bot-session || true',
            'rm -rf /root/whatsapp-bot/auth_info_baileys || true',
            'rm -rf /root/whatsapp-bot/sessions || true',
            // Restart — bot will generate a new QR on next startup
            `systemctl start ${serviceName}`,
            'sleep 3',
            `systemctl is-active ${serviceName}`,
        ]);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Poll journal for QR code lines (called repeatedly by renderer)
// Bot logs QR as: [QR] <qr-data-string>  or  QR code:  or  QR received
// We return the raw QR string so the renderer can render it with qrcode.js
// ────────────────────────────────────────────────────────────
ipcMain.handle('vps:pollQR', async () => {
    const { serviceName } = getVpsConfig();
    try {
        // Get last 80 log lines and extract any QR block
        const logs = await sshExec(
            `journalctl -u ${serviceName} -n 80 --no-pager --output=short-iso 2>/dev/null`
        );

        // Baileys logs QR data as a multi-line ASCII art block AND/OR as:
        //   "QR:" followed by the raw data string on the next line
        // We look for the base64-looking QR data after known markers
        const lines = logs.split('\n');
        let qrData = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Match patterns used by @whiskeysockets/baileys:
            // "QR code:" or "[QR]" or "scan QR" followed by the data
            if (/qr\s*code|qr\s*received|\[qr\]|scan.*qr/i.test(line)) {
                // The actual QR string is often on the same line after a colon
                const colonIdx = line.lastIndexOf(':');
                if (colonIdx !== -1) {
                    const candidate = line.substring(colonIdx + 1).trim();
                    if (candidate.length > 20) { qrData = candidate; break; }
                }
                // Or on the very next line
                if (i + 1 < lines.length) {
                    const next = lines[i + 1].replace(/^.*\]\s*/, '').trim();
                    if (next.length > 20) { qrData = next; break; }
                }
            }
        }

        // Also check for lines that only contain QR-looking data
        // (long alphanumeric+comma+@ strings characteristic of Baileys QR)
        if (!qrData) {
            for (const line of lines.slice().reverse()) {
                const stripped = line.replace(/^[^]]*\]\s*/, '').trim();
                // Baileys QR strings contain commas, digits, letters — typically 50-200 chars
                if (/^[\w,@./+=-]{50,}$/.test(stripped)) {
                    qrData = stripped;
                    break;
                }
            }
        }

        return { ok: true, qrData, rawLogs: lines.slice(-30).join('\n') };
    } catch (e) {
        return { ok: false, error: e.message, qrData: null };
    }
});


ipcMain.handle('vps:status', async () => {
    const { serviceName, botDir } = getVpsConfig();
    try {
        const raw = await sshExec([
            `systemctl status ${serviceName} --no-pager -l 2>&1 | head -20`,
            `echo "---MEM---"`,
            `free -m | awk 'NR==2{print $3" "$2" "$4}'`,
            `echo "---UPTIME---"`,
            `uptime -p`,
            `echo "---NODE---"`,
            `node --version 2>/dev/null || echo "unknown"`,
            `echo "---BOT---"`,
            `cd ${botDir} && node -e "try{const p=require('./package.json');console.log(p.version||'?')}catch(e){console.log('?')}" 2>/dev/null || echo "?"`,
            `echo "---CPU---"`,
            `top -bn1 | grep "Cpu(s)" | awk '{print $2+$4}' 2>/dev/null || echo "?"`,
            `echo "---LOGS---"`,
            `journalctl -u ${serviceName} -n 8 --no-pager --output=short-iso 2>/dev/null | grep -v "^--"`,
        ]);

        // ── Section extractor ────────────────────────────────
        const sec = (tag) => {
            const m = raw.match(new RegExp(`---${tag}---([\\s\\S]*?)(?=---|$)`));
            return m ? m[1].trim() : '';
        };

        // ── Parse systemctl block ────────────────────────────
        const statusBlock = raw.split('---MEM---')[0].trim();
        const activeMatch = statusBlock.match(/Active:\s*(.+)/);
        const activeRaw = activeMatch ? activeMatch[1].trim() : '';
        const isActive = activeRaw.startsWith('active (running)');
        const isFailed = activeRaw.startsWith('failed');
        const sinceMatch = activeRaw.match(/since (.+?);(.+)/);
        const sinceDate = sinceMatch ? sinceMatch[1].trim() : '';
        const sinceAgo = sinceMatch ? sinceMatch[2].trim() : '';

        const pidMatch = statusBlock.match(/Main PID:\s*(\d+)/);
        const tasksMatch = statusBlock.match(/Tasks:\s*(\d+)/);
        const memHiMatch = statusBlock.match(/Memory:\s*([\d.]+\w+)/);
        const cpuMatch = statusBlock.match(/CPU:\s*([\S]+)/);
        const descMatch = statusBlock.match(/\.service - (.+)/);

        // ── Parse memory ─────────────────────────────────────
        const memParts = sec('MEM').split(/\s+/);
        const memUsed = parseInt(memParts[0]) || 0;
        const memTotal = parseInt(memParts[1]) || 1;
        const memPct = Math.round((memUsed / memTotal) * 100);

        // ── Parse logs — filter the daemon-reload warning ────
        const rawLogs = sec('LOGS').split('\n').filter(l =>
            l.trim() &&
            !l.includes('daemon-reload') &&
            !l.includes('changed on disk') &&
            !l.includes('Run \'systemctl')
        );

        return {
            ok: true,
            status: {
                service: serviceName,
                description: descMatch ? descMatch[1].trim() : '',
                state: isActive ? 'active' : isFailed ? 'failed' : 'inactive',
                activeRaw,
                sinceDate,
                sinceAgo,
                pid: pidMatch ? pidMatch[1] : '?',
                tasks: tasksMatch ? tasksMatch[1] : '?',
                processMemory: memHiMatch ? memHiMatch[1] : '?',
                cpuTime: cpuMatch ? cpuMatch[1] : '?',
                nodeVersion: sec('NODE').trim(),
                botVersion: sec('BOT').trim(),
                cpuPct: sec('CPU').trim(),
                uptime: sec('UPTIME').replace('up ', '').trim(),
                mem: { used: memUsed, total: memTotal, pct: memPct },
                logs: rawLogs,
            },
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// Take a VPS backup
ipcMain.handle('vps:backup', async () => {
    const { botDir } = getVpsConfig();
    const sessionDir = botDir.replace('whatsapp-bot', '.whatsapp-bot-session');
    try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const backupName = `whatsapp-bot-backup-${ts}.tar.gz`;
        await sshExec([
            `cd /root && tar --exclude="${botDir}/node_modules" --exclude="${sessionDir}" -czf /root/${backupName} whatsapp-bot`,
            `echo "BACKUP:${backupName}"`,
        ]);
        return { ok: true, filename: backupName };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// Read live bot logs
ipcMain.handle('vps:logs', async (_e, lines = 50) => {
    const { serviceName } = getVpsConfig();
    try {
        const result = await sshExec(`journalctl -u ${serviceName} -n ${lines} --no-pager --output=short-iso`);
        return { ok: true, logs: result };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Import ALL config from VPS (one-shot onboarding import)
// ────────────────────────────────────────────────────────────
ipcMain.handle('vps:importAll', async () => {
    const { botDir, serviceName } = getVpsConfig();
    try {
        // Run a comprehensive read in a single SSH session
        const raw = await sshExec(
            `echo '===SERVICE==='; cat /etc/systemd/system/${serviceName}.service 2>/dev/null || echo '';` +
            `echo '===BOTCONFIG==='; cat /root/.gemini-whatsapp-bot-config.json 2>/dev/null || echo '{}';` +
            `echo '===NODE==='; node --version;` +
            `echo '===UPTIME==='; uptime -p;` +
            `echo '===MEM==='; free -m | awk 'NR==2{print $3"/"$2}';`
        );

        // Split sections
        const section = (tag) => {
            const re = new RegExp(`===\\${tag}===([\\s\\S]*?)(?====|$)`);
            const m = raw.match(new RegExp(`===${tag}===([\\s\\S]*?)(?====|$)`));
            return m ? m[1].trim() : '';
        };

        // Parse env vars from systemd service file
        const serviceText = section('SERVICE');
        const envVars = {};
        (serviceText.match(/^Environment=(.+)$/gm) || []).forEach(line => {
            const [k, ...rest] = line.replace('Environment=', '').split('=');
            envVars[k] = rest.join('=');
        });

        // Parse bot JSON config
        let botConfig = {};
        try { botConfig = JSON.parse(section('BOTCONFIG') || '{}'); } catch { }

        return {
            ok: true,
            envVars,
            botConfig,
            meta: {
                nodeVersion: section('NODE'),
                uptime: section('UPTIME'),
                memory: section('MEM'),
            },
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Uninstall the app from macOS
// ────────────────────────────────────────────────────────────
ipcMain.handle('app:uninstall', async () => {
    const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Uninstall'],
        defaultId: 0,
        cancelId: 0,
        title: 'Uninstall Bot Manager',
        message: 'Are you sure you want to uninstall Bot Manager?',
        detail: 'This will:\n• Delete all saved VPS credentials and settings\n• Move the Bot Manager app to Trash\n\nYour VPS bot and its configuration will NOT be affected.',
    });
    if (choice.response !== 1) return { ok: false, cancelled: true };

    try {
        // 1. Clear all local config
        store.clear();

        // 2. Find the .app bundle path
        // process.execPath = /Applications/Bot Manager.app/Contents/MacOS/Bot Manager
        let appPath = process.execPath;
        // Walk up until we find the .app bundle
        while (appPath && !appPath.endsWith('.app')) {
            const parent = path.dirname(appPath);
            if (parent === appPath) break; // reached root
            appPath = parent;
        }

        // 3. Move .app to Trash
        if (appPath && appPath.endsWith('.app')) {
            await shell.trashItem(appPath);
        }

        // 4. Also clear Electron userData (preferences, cache)
        const userDataPath = app.getPath('userData');
        try {
            fs.rmSync(userDataPath, { recursive: true, force: true });
        } catch { }

        // 5. Quit
        setTimeout(() => app.quit(), 500);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});
// ────────────────────────────────────────────────────────────
// Google Drive OAuth2 helpers (Desktop/Installed App flow)
// Uses loopback redirect: http://127.0.0.1:PORT
// All done with built-in Node modules — no googleapis dep needed.
// ────────────────────────────────────────────────────────────
// (http, https, net, fs, os already required at top of file)

const GDRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file';
const GDRIVE_TOKEN_KEY = 'gdrive.tokens';
const GDRIVE_CREDS_KEY = 'gdrive.credentials';

/** Find a free local port */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

/** POST to Google token endpoint (built-in https) */
function tokenRequest(params) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(params).toString();
        const req = https.request({
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/** GET Google userInfo to get email */
function getUserInfo(accessToken) {
    return new Promise((resolve, reject) => {
        https.get({
            hostname: 'www.googleapis.com',
            path: '/oauth2/v2/userinfo',
            headers: { Authorization: `Bearer ${accessToken}` },
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch { resolve({}); }
            });
        }).on('error', reject);
    });
}

/** Refresh an expired access token */
async function refreshAccessToken(tokens, clientId, clientSecret) {
    if (!tokens.refresh_token) throw new Error('No refresh token — re-login required');
    const result = await tokenRequest({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
    });
    if (result.error) throw new Error(result.error_description || result.error);
    const updated = { ...tokens, access_token: result.access_token, expiry: Date.now() + result.expires_in * 1000 };
    store.set(GDRIVE_TOKEN_KEY, updated);
    return updated;
}

/** Get a valid access token (refresh if expired) */
async function getValidToken() {
    let tokens = store.get(GDRIVE_TOKEN_KEY);
    if (!tokens) throw new Error('Not signed in to Google');
    const creds = store.get(GDRIVE_CREDS_KEY);
    if (!creds) throw new Error('No Google credentials configured');
    if (!tokens.expiry || Date.now() > tokens.expiry - 60000) {
        tokens = await refreshAccessToken(tokens, creds.clientId, creds.clientSecret);
    }
    return tokens.access_token;
}

/** Upload a file to Google Drive using multipart upload */
function uploadToDrive(accessToken, filename, filePath, folderId) {
    return new Promise((resolve, reject) => {
        const fileBuffer = fs.readFileSync(filePath);
        const boundary = 'bot_manager_boundary_' + Date.now();
        const metadata = JSON.stringify({ name: filename, ...(folderId ? { parents: [folderId] } : {}) });
        const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
        const filePart = `--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`;
        const closing = `\r\n--${boundary}--`;
        const body = Buffer.concat([
            Buffer.from(metaPart),
            Buffer.from(filePart),
            fileBuffer,
            Buffer.from(closing),
        ]);
        const req = https.request({
            hostname: 'www.googleapis.com',
            path: '/upload/drive/v3/files?uploadType=multipart',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': body.length,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const result = JSON.parse(Buffer.concat(chunks).toString());
                    if (result.id) resolve(result);
                    else reject(new Error(result.error?.message || 'Drive upload failed'));
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ────────────────────────────────────────────────────────────
// IPC: Save Google credentials (Client ID + Secret)
// ────────────────────────────────────────────────────────────
ipcMain.handle('gdrive:saveCredentials', (_e, { clientId, clientSecret }) => {
    store.set(GDRIVE_CREDS_KEY, { clientId, clientSecret });
    return { ok: true };
});

// ────────────────────────────────────────────────────────────
// IPC: Google Drive OAuth2 login
// ────────────────────────────────────────────────────────────
ipcMain.handle('gdrive:login', async () => {
    const creds = store.get(GDRIVE_CREDS_KEY);
    if (!creds?.clientId || !creds?.clientSecret) {
        return { ok: false, error: 'Enter your Google OAuth Client ID and Secret first.' };
    }

    try {
        const port = await getFreePort();
        const redirectUri = `http://127.0.0.1:${port}`;
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
            `client_id=${encodeURIComponent(creds.clientId)}&` +
            `redirect_uri=${encodeURIComponent(redirectUri)}&` +
            `response_type=code&` +
            `scope=${encodeURIComponent(GDRIVE_SCOPES)}&` +
            `access_type=offline&prompt=consent`;

        // Open in default browser
        await shell.openExternal(authUrl);

        // Wait for callback with auth code
        const code = await new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                const url = new URL(req.url, `http://127.0.0.1:${port}`);
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<html><body style="font-family:sans-serif;text-align:center;padding-top:80px;background:#0f1117;color:#e8eaf6">
                    <h2>${code ? '✅ Signed In!' : '❌ ' + (error || 'Error')}</h2>
                    <p>${code ? 'You can close this tab and return to Bot Manager.' : 'Please try again in the app.'}</p>
                    <script>setTimeout(()=>window.close(),2000)</script></body></html>`);
                server.close();
                if (code) resolve(code);
                else reject(new Error(error || 'No code received'));
            });
            server.listen(port, '127.0.0.1');
            // Timeout after 3 minutes
            setTimeout(() => { server.close(); reject(new Error('Login timed out — try again')); }, 180000);
        });

        // Exchange code for tokens
        const tokens = await tokenRequest({
            code,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        });
        if (tokens.error) throw new Error(tokens.error_description || tokens.error);

        tokens.expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
        store.set(GDRIVE_TOKEN_KEY, tokens);

        // Get user email
        const userInfo = await getUserInfo(tokens.access_token);
        return { ok: true, email: userInfo.email || 'Google Account' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Google Drive status
// ────────────────────────────────────────────────────────────
ipcMain.handle('gdrive:status', async () => {
    const tokens = store.get(GDRIVE_TOKEN_KEY);
    const creds = store.get(GDRIVE_CREDS_KEY);
    if (!tokens) return { loggedIn: false, creds: creds || null };
    try {
        const accessToken = await getValidToken();
        const userInfo = await getUserInfo(accessToken);
        return { loggedIn: true, email: userInfo.email, creds: creds || null };
    } catch {
        return { loggedIn: false, creds: creds || null };
    }
});

// ────────────────────────────────────────────────────────────
// IPC: Google Drive logout
// ────────────────────────────────────────────────────────────
ipcMain.handle('gdrive:logout', () => {
    store.delete(GDRIVE_TOKEN_KEY);
    return { ok: true };
});

/**
 * Resolve a folder name or ID to a Drive folder ID.
 * - If input looks like a real Drive ID (alphanumeric, 25-50 chars, no spaces) → use as-is.
 * - Otherwise → search Drive for a folder with that exact name and return its ID.
 * - If nothing found → throw an informative error.
 */
function resolveFolderId(accessToken, folderInput) {
    // Heuristic: Drive IDs are 25–50 chars, alphanumeric + _ + -
    if (!folderInput) return Promise.resolve(null);
    const looksLikeId = /^[a-zA-Z0-9_\-]{25,}$/.test(folderInput);
    if (looksLikeId) return Promise.resolve(folderInput);

    // Search by name
    return new Promise((resolve, reject) => {
        const query = encodeURIComponent(`name='${folderInput.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        https.get({
            hostname: 'www.googleapis.com',
            path: `/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=5`,
            headers: { Authorization: `Bearer ${accessToken}` },
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const result = JSON.parse(Buffer.concat(chunks).toString());
                    if (result.error) return reject(new Error(result.error.message || 'Drive folder search failed'));
                    const files = result.files || [];
                    if (files.length === 0) return reject(new Error(`Folder "${folderInput}" not found in Google Drive. Enter the folder ID from the Drive URL instead of the folder name.`));
                    // Use the first match
                    resolve(files[0].id);
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// ────────────────────────────────────────────────────────────
// IPC: Upload latest VPS backup to Google Drive
// Downloads from VPS via SFTP → uploads to Drive
// ────────────────────────────────────────────────────────────
ipcMain.handle('gdrive:uploadBackup', async (_e, { folderId } = {}) => {
    try {
        // 1. Get valid Drive token
        const accessToken = await getValidToken();

        // 2. Resolve folder name → ID (handles both names and real IDs)
        let resolvedFolderId = null;
        if (folderId && folderId.trim()) {
            resolvedFolderId = await resolveFolderId(accessToken, folderId.trim());
        }

        // 3. Find latest backup on VPS
        const latestFile = await sshExec(`ls -t /root/whatsapp-bot-backup-*.tar.gz 2>/dev/null | head -1`);
        if (!latestFile || !latestFile.trim() || latestFile.includes('[ERR]')) {
            throw new Error('No backup file found on VPS. Click "Take Backup Now" first.');
        }
        const remoteFile = latestFile.trim();
        const filename = path.basename(remoteFile);

        // 4. Download from VPS via SFTP
        const localPath = path.join(os.tmpdir(), filename);
        await new Promise((resolve, reject) => {
            const cfg = getVpsConfig();
            const conn = new SshClient();
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) { conn.end(); return reject(new Error('SFTP session failed: ' + err.message)); }
                    sftp.fastGet(remoteFile, localPath, (err) => {
                        conn.end();
                        if (err) reject(new Error('SFTP download failed: ' + err.message));
                        else resolve();
                    });
                });
            }).on('error', e => reject(new Error('SSH connection failed: ' + e.message)))
                .connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, readyTimeout: 15000 });
        });

        // 5. Upload to Google Drive
        const driveFile = await uploadToDrive(accessToken, filename, localPath, resolvedFolderId);

        // 6. Clean up local temp file
        try { fs.unlinkSync(localPath); } catch { }

        return {
            ok: true,
            filename,
            driveFileId: driveFile.id,
            driveFileName: driveFile.name,
            folderResolved: resolvedFolderId,
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});
