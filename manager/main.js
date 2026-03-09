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
// ────────────────────────────────────────────────────────────
// Google Drive OAuth2 helpers (Desktop/Installed App flow)
// Uses loopback redirect: http://127.0.0.1:PORT
// All done with built-in Node modules — no googleapis dep needed.
// ────────────────────────────────────────────────────────────
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');

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
