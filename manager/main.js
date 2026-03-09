'use strict';
/**
 * Bot Manager — Electron Main Process
 * macOS SSH-based configuration app for Gemini WhatsApp Bot VPS
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { Client: SshClient } = require('ssh2');

const store = new Store({ name: 'bot-manager-config' });

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
ipcMain.handle('store:set', (_e, key, value) => { store.set(key, value); return true; });
ipcMain.handle('store:getAll', () => store.store);

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
// IPC: Save individual config sections to VPS
// ────────────────────────────────────────────────────────────

// Update systemd env var (GEMINI_API_KEY, GROQ_API_KEY, etc.)
ipcMain.handle('vps:setEnv', async (_e, envVars) => {
    const { serviceName } = getVpsConfig();
    try {
        // Build python one-liner to update specific env lines
        const updates = Object.entries(envVars);
        let pyScript = `import re; f='/etc/systemd/system/${serviceName}.service'; c=open(f).read();\n`;
        for (const [k, v] of updates) {
            const escaped = v.replace(/'/g, "\\'");
            pyScript += `c=re.sub(r'Environment=${k}=.*', "Environment=${k}=${escaped}", c); c=c if 'Environment=${k}=' in c else c.replace('[Service]\\n', '[Service]\\nEnvironment=${k}=${escaped}\\n');\n`;
        }
        pyScript += `open(f,'w').write(c); print('OK')`;

        await sshExec([
            `python3 -c "${pyScript.replace(/\n/g, ' ')}"`,
            'systemctl daemon-reload',
            'systemctl restart whatsapp-bot',
            'sleep 2',
            'systemctl is-active whatsapp-bot',
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
        const escaped = JSON.stringify(JSON.stringify(configPatch));
        const script = `cd ${botDir} && node -e "
const Config = require('./services/config');
const patch = JSON.parse(${escaped});
Object.entries(patch).forEach(([k, v]) => Config.set(k, v));
console.log('SAVED:', Object.keys(patch).join(', '));
"`;
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

// Fetch live bot status
ipcMain.handle('vps:status', async () => {
    const { serviceName, botDir } = getVpsConfig();
    try {
        const result = await sshExec([
            `systemctl status ${serviceName} --no-pager -l | head -15`,
            `echo "---MEMORY---"`,
            `free -m | awk 'NR==2{print $3"/"$2" MB"}'`,
            `echo "---UPTIME---"`,
            `uptime -p`,
        ]);
        return { ok: true, output: result };
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
        const fs = require('fs');
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
