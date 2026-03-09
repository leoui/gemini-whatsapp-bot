'use strict';
/**
 * Bot Manager — Renderer Process
 * Handles all UI interactions, SSH calls via BotManager bridge, and state management.
 */

const BM = window.BotManager;

// ── Local state ──────────────────────────────────────────────
let contacts = [];
let logsAutoRefreshTimer = null;

// ── Utilities ────────────────────────────────────────────────
function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

function setOutput(id, text, type = '') {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = `output-box ${type}`;
    el.style.display = 'block';
}

function showLoading(btnId, label = 'Loading...') {
    const btn = document.getElementById(btnId);
    if (btn) { btn.dataset.orig = btn.textContent; btn.textContent = label; btn.disabled = true; }
}
function stopLoading(btnId) {
    const btn = document.getElementById(btnId);
    if (btn) { btn.textContent = btn.dataset.orig || btn.textContent; btn.disabled = false; }
}

function setBadge(state) {
    const badge = document.getElementById('vps-badge');
    badge.className = 'vps-badge ' + state;
    badge.textContent = state === 'connected' ? '🟢 Connected'
        : state === 'error' ? '🔴 Error'
            : '⚪ Not connected';
}

// ── Navigation ───────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        item.classList.add('active');
        const panel = document.getElementById('panel-' + item.dataset.panel);
        if (panel) panel.classList.add('active');

        // Side effects on panel open
        if (item.dataset.panel === 'contacts') renderContactsTable();
    });
});

// ── Toggle password visibility ───────────────────────────────
document.querySelectorAll('.btn-toggle-vis').forEach(btn => {
    btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈 Hide'; }
        else { input.type = 'password'; btn.textContent = '👁 Show'; }
    });
});

// ═══════════════════════════════════════════════════════════
// PANEL: VPS Connection
// ═══════════════════════════════════════════════════════════
async function loadVpsFields() {
    const all = await BM.store.getAll();
    document.getElementById('vps-host').value = all['vps.host'] || '';
    document.getElementById('vps-port').value = all['vps.port'] || 22;
    document.getElementById('vps-user').value = all['vps.username'] || 'root';
    document.getElementById('vps-password').value = all['vps.password'] || '';
    document.getElementById('vps-botdir').value = all['vps.botDir'] || '/root/whatsapp-bot';
    document.getElementById('vps-service').value = all['vps.serviceName'] || 'whatsapp-bot';
}

document.getElementById('btn-save-vps')?.addEventListener('click', async () => {
    await BM.store.set('vps.host', document.getElementById('vps-host').value.trim());
    await BM.store.set('vps.port', parseInt(document.getElementById('vps-port').value) || 22);
    await BM.store.set('vps.username', document.getElementById('vps-user').value.trim() || 'root');
    await BM.store.set('vps.password', document.getElementById('vps-password').value);
    await BM.store.set('vps.botDir', document.getElementById('vps-botdir').value.trim() || '/root/whatsapp-bot');
    await BM.store.set('vps.serviceName', document.getElementById('vps-service').value.trim() || 'whatsapp-bot');
    toast('✅ Connection settings saved', 'success');
});

document.getElementById('btn-test-ssh')?.addEventListener('click', async () => {
    showLoading('btn-test-ssh', 'Testing...');
    setOutput('connection-output', 'Connecting to VPS...', '');
    const result = await BM.ssh.test();
    stopLoading('btn-test-ssh');
    if (result.ok) {
        setOutput('connection-output', '✅ Connected!\n' + result.output, 'success');
        setBadge('connected');
        toast('✅ SSH connection successful', 'success');
    } else {
        setOutput('connection-output', '❌ Connection failed:\n' + result.error, 'error');
        setBadge('error');
        toast('❌ Connection failed: ' + result.error, 'error');
    }
});

document.getElementById('btn-restart-bot')?.addEventListener('click', async () => {
    if (!confirm('Restart the bot service on the VPS?')) return;
    showLoading('btn-restart-bot', 'Restarting...');
    const result = await BM.vps.restart();
    stopLoading('btn-restart-bot');
    if (result.ok) {
        setOutput('connection-output', '✅ Bot service restarted successfully', 'success');
        toast('✅ Bot restarted', 'success');
    } else {
        setOutput('connection-output', '❌ Restart failed:\n' + result.error, 'error');
        toast('❌ Restart failed', 'error');
    }
});

// ═══════════════════════════════════════════════════════════
// PANEL: Bot Persona
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-load-persona')?.addEventListener('click', async () => {
    showLoading('btn-load-persona', 'Loading...');
    const result = await BM.bot.readConfig();
    stopLoading('btn-load-persona');
    if (result.ok) {
        const cfg = result.botConfig;
        document.getElementById('persona-prompt').value = cfg.characterPrompt || '';
        document.getElementById('persona-name').value = cfg.botName || '';
        document.getElementById('persona-timezone').value = cfg.timezone || 'Asia/Jakarta';
        setOutput('persona-output', '✅ Loaded from VPS', 'success');
        toast('✅ Persona loaded from VPS', 'success');
    } else {
        setOutput('persona-output', '❌ ' + result.error, 'error');
        toast('❌ Load failed: ' + result.error, 'error');
    }
});

document.getElementById('btn-save-persona')?.addEventListener('click', async () => {
    const prompt = document.getElementById('persona-prompt').value.trim();
    const name = document.getElementById('persona-name').value.trim();
    const tz = document.getElementById('persona-timezone').value.trim() || 'Asia/Jakarta';
    if (!prompt) { toast('⚠️ Character prompt cannot be empty', 'error'); return; }

    showLoading('btn-save-persona', 'Saving...');
    const result = await BM.bot.saveConfig({ characterPrompt: prompt, botName: name, timezone: tz });
    stopLoading('btn-save-persona');
    if (result.ok) {
        setOutput('persona-output', '✅ Persona saved to VPS\n' + (result.output || ''), 'success');
        toast('✅ Persona saved', 'success');
    } else {
        setOutput('persona-output', '❌ ' + result.error, 'error');
    }
});

// ═══════════════════════════════════════════════════════════
// PANEL: API Keys
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-load-apikeys')?.addEventListener('click', async () => {
    showLoading('btn-load-apikeys', 'Loading...');
    const result = await BM.bot.readConfig();
    stopLoading('btn-load-apikeys');
    if (result.ok) {
        const env = result.envVars;
        document.getElementById('key-gemini').value = env['GEMINI_API_KEY'] || '';
        document.getElementById('key-groq').value = env['GROQ_API_KEY'] || '';
        document.getElementById('key-pollinations').value = env['POLLINATIONS_API_KEY'] || '';
        setOutput('apikeys-output', '✅ Loaded from VPS service file', 'success');
        toast('✅ Keys loaded', 'success');
    } else {
        setOutput('apikeys-output', '❌ ' + result.error, 'error');
    }
});

document.getElementById('btn-save-apikeys')?.addEventListener('click', async () => {
    const gemini = document.getElementById('key-gemini').value.trim();
    const groq = document.getElementById('key-groq').value.trim();
    const poll = document.getElementById('key-pollinations').value.trim();
    if (!gemini) { toast('⚠️ Gemini API key is required', 'error'); return; }

    const envVars = { GEMINI_API_KEY: gemini };
    if (groq) envVars['GROQ_API_KEY'] = groq;
    if (poll) envVars['POLLINATIONS_API_KEY'] = poll;

    showLoading('btn-save-apikeys', 'Saving & Restarting...');
    const result = await BM.vps.setEnv(envVars);
    stopLoading('btn-save-apikeys');
    if (result.ok) {
        setOutput('apikeys-output', '✅ Keys written to systemd and bot restarted', 'success');
        toast('✅ API keys updated — bot restarted', 'success');
    } else {
        setOutput('apikeys-output', '❌ ' + result.error, 'error');
    }
});

// ─── Gemini Model Selector ────────────────────────────────────────────────────

async function loadCurrentModel() {
    const result = await BM.bot.getModel();
    const modelId = result?.model || 'gemini-2.5-flash';
    const radios = document.querySelectorAll('input[name="gemini-model"]');
    radios.forEach(r => { r.checked = (r.value === modelId); });
}

// Load selected model when API Keys panel is shown
document.addEventListener('DOMContentLoaded', () => {
    const observer = new MutationObserver(() => {
        if (document.getElementById('panel-apikeys')?.classList.contains('active')) {
            loadCurrentModel();
        }
    });
    const panels = document.getElementById('panel-apikeys');
    if (panels) observer.observe(panels, { attributes: true, attributeFilter: ['class'] });
});

document.getElementById('btn-save-model')?.addEventListener('click', async () => {
    const selected = document.querySelector('input[name="gemini-model"]:checked')?.value;
    if (!selected) { toast('⚠️ Select a model first', 'error'); return; }

    showLoading('btn-save-model', 'Saving…');
    const result = await BM.bot.setModel(selected);
    stopLoading('btn-save-model');

    if (result.ok) {
        const label = selected === 'gemini-2.5-pro' ? 'Gemini 2.5 Pro 🌟' : 'Gemini 2.5 Flash ⚡';
        setOutput('model-output', `✅ Model set to ${label} — takes effect on next message`, 'success');
        toast(`✅ Model: ${label}`, 'success');
    } else {
        setOutput('model-output', '❌ ' + result.error, 'error');
        toast('❌ ' + result.error, 'error');
    }
});

// ═══════════════════════════════════════════════════════════
// PANEL: Contacts
// ═══════════════════════════════════════════════════════════
function renderContactsTable() {
    const tbody = document.getElementById('contacts-body');
    if (!tbody) return;
    tbody.innerHTML = contacts.map((c, i) => `
        <tr>
          <td>${c.name}</td>
          <td><code>${c.shortcode}</code></td>
          <td>${c.phone}</td>
          <td><button class="btn-del" data-idx="${i}">✕ Delete</button></td>
        </tr>
    `).join('');
    tbody.querySelectorAll('.btn-del').forEach(btn => {
        btn.addEventListener('click', () => {
            contacts.splice(parseInt(btn.dataset.idx), 1);
            renderContactsTable();
        });
    });
}

document.getElementById('btn-add-contact')?.addEventListener('click', () => {
    const name = document.getElementById('contact-name').value.trim();
    const shortcode = document.getElementById('contact-shortcode').value.trim();
    const phone = document.getElementById('contact-phone').value.trim();
    if (!name || !phone) { toast('⚠️ Name and phone are required', 'error'); return; }
    contacts.push({ name, shortcode: shortcode || '+' + name.split(' ')[0], phone });
    document.getElementById('contact-name').value = '';
    document.getElementById('contact-shortcode').value = '';
    document.getElementById('contact-phone').value = '';
    renderContactsTable();
    toast('✅ Contact added (save to push to VPS)', 'info');
});

document.getElementById('btn-load-contacts')?.addEventListener('click', async () => {
    showLoading('btn-load-contacts', 'Loading...');
    const result = await BM.bot.readConfig();
    stopLoading('btn-load-contacts');
    if (result.ok) {
        contacts = result.botConfig.savedContacts || [];
        renderContactsTable();
        setOutput('contacts-output', `✅ Loaded ${contacts.length} contact(s)`, 'success');
        toast(`✅ ${contacts.length} contacts loaded`, 'success');
    } else {
        setOutput('contacts-output', '❌ ' + result.error, 'error');
    }
});

document.getElementById('btn-save-contacts')?.addEventListener('click', async () => {
    showLoading('btn-save-contacts', 'Saving...');
    const result = await BM.bot.saveConfig({ savedContacts: contacts });
    stopLoading('btn-save-contacts');
    if (result.ok) {
        setOutput('contacts-output', `✅ ${contacts.length} contact(s) saved to VPS`, 'success');
        toast('✅ Contacts saved', 'success');
    } else {
        setOutput('contacts-output', '❌ ' + result.error, 'error');
    }
});

// ═══════════════════════════════════════════════════════════
// PANEL: Keywords
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-load-keywords')?.addEventListener('click', async () => {
    showLoading('btn-load-keywords', 'Loading...');
    const result = await BM.bot.readConfig();
    stopLoading('btn-load-keywords');
    if (result.ok) {
        const cfg = result.botConfig;
        document.getElementById('kw-trigger').value = cfg.groupTriggerWord || '';
        document.getElementById('kw-autoreply').checked = cfg.autoReplyEnabled !== false;
        setOutput('keywords-output', '✅ Loaded from VPS', 'success');
    } else {
        setOutput('keywords-output', '❌ ' + result.error, 'error');
    }
});

document.getElementById('btn-save-keywords')?.addEventListener('click', async () => {
    showLoading('btn-save-keywords', 'Saving...');
    const result = await BM.bot.saveConfig({
        groupTriggerWord: document.getElementById('kw-trigger').value.trim(),
        autoReplyEnabled: document.getElementById('kw-autoreply').checked,
    });
    stopLoading('btn-save-keywords');
    if (result.ok) { setOutput('keywords-output', '✅ Saved to VPS', 'success'); toast('✅ Keywords saved', 'success'); }
    else { setOutput('keywords-output', '❌ ' + result.error, 'error'); }
});

// ═══════════════════════════════════════════════════════════
// PANEL: Human Behavior
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-load-behavior')?.addEventListener('click', async () => {
    showLoading('btn-load-behavior', 'Loading...');
    const result = await BM.bot.readConfig();
    stopLoading('btn-load-behavior');
    if (result.ok) {
        const b = result.botConfig.humanBehavior || {};
        document.getElementById('hb-wpm').value = b.typingWpm || 120;
        document.getElementById('hb-read-min').value = b.readDelayMin || 500;
        document.getElementById('hb-read-max').value = b.readDelayMax || 2000;
        document.getElementById('hb-burst-min').value = b.burstPauseMin || 2000;
        document.getElementById('hb-enabled').checked = b.enabled !== false;
        setOutput('behavior-output', '✅ Loaded from VPS', 'success');
    } else {
        setOutput('behavior-output', '❌ ' + result.error, 'error');
    }
});

document.getElementById('btn-save-behavior')?.addEventListener('click', async () => {
    showLoading('btn-save-behavior', 'Saving...');
    const result = await BM.bot.saveConfig({
        humanBehavior: {
            enabled: document.getElementById('hb-enabled').checked,
            typingWpm: parseInt(document.getElementById('hb-wpm').value) || 120,
            readDelayMin: parseInt(document.getElementById('hb-read-min').value) || 500,
            readDelayMax: parseInt(document.getElementById('hb-read-max').value) || 2000,
            burstPauseMin: parseInt(document.getElementById('hb-burst-min').value) || 2000,
        }
    });
    stopLoading('btn-save-behavior');
    if (result.ok) { setOutput('behavior-output', '✅ Human Behavior settings saved', 'success'); toast('✅ Saved', 'success'); }
    else { setOutput('behavior-output', '❌ ' + result.error, 'error'); }
});

// ═══════════════════════════════════════════════════════════
// PANEL: Group Behavior
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-load-groups')?.addEventListener('click', async () => {
    showLoading('btn-load-groups', 'Loading...');
    const result = await BM.bot.readConfig();
    stopLoading('btn-load-groups');
    if (result.ok) {
        const cfg = result.botConfig;
        document.getElementById('grp-mention-only').checked = !!cfg.groupMentionOnly;
        document.getElementById('grp-trigger-word').value = cfg.groupTriggerWord || '';
        document.getElementById('grp-allowed').value = (cfg.allowedGroups || []).join(', ');
        document.getElementById('grp-blocked').value = (cfg.blockedGroups || []).join(', ');
        setOutput('groups-output', '✅ Loaded from VPS', 'success');
    } else {
        setOutput('groups-output', '❌ ' + result.error, 'error');
    }
});

document.getElementById('btn-save-groups')?.addEventListener('click', async () => {
    const parse = (id) => document.getElementById(id).value.split(',').map(s => s.trim()).filter(Boolean);
    showLoading('btn-save-groups', 'Saving...');
    const result = await BM.bot.saveConfig({
        groupMentionOnly: document.getElementById('grp-mention-only').checked,
        groupTriggerWord: document.getElementById('grp-trigger-word').value.trim(),
        allowedGroups: parse('grp-allowed'),
        blockedGroups: parse('grp-blocked'),
    });
    stopLoading('btn-save-groups');
    if (result.ok) { setOutput('groups-output', '✅ Group settings saved', 'success'); toast('✅ Saved', 'success'); }
    else { setOutput('groups-output', '❌ ' + result.error, 'error'); }
});

// ═══════════════════════════════════════════════════════════
// PANEL: Backup
// ═══════════════════════════════════════════════════════════

// Restore saved backup dir
BM.store.get('backup.localDir').then(dir => {
    if (dir) document.getElementById('backup-local-dir').value = dir;
});

document.getElementById('btn-take-backup')?.addEventListener('click', async () => {
    showLoading('btn-take-backup', 'Creating backup...');
    const result = await BM.vps.backup();
    stopLoading('btn-take-backup');
    if (result.ok) {
        setOutput('backup-vps-output', `✅ Backup created: ${result.filename}\n📁 Location: /root/${result.filename}`, 'success');
        toast(`✅ Backup created: ${result.filename}`, 'success');
    } else {
        setOutput('backup-vps-output', '❌ Backup failed:\n' + result.error, 'error');
        toast('❌ Backup failed', 'error');
    }
});

document.getElementById('btn-browse-backup-dir')?.addEventListener('click', async () => {
    const dir = await BM.dialog.chooseDirectory();
    if (dir) {
        document.getElementById('backup-local-dir').value = dir;
        await BM.store.set('backup.localDir', dir);
        toast('✅ Save location updated', 'info');
    }
});

document.getElementById('btn-download-backup-local')?.addEventListener('click', async () => {
    const localDir = document.getElementById('backup-local-dir').value.trim() || undefined;
    showLoading('btn-download-backup-local', '⬇️ Downloading...');
    setOutput('backup-local-output', '📥 Connecting to VPS and downloading backup via SFTP…', '');
    const result = await BM.vps.downloadBackup({ localDir });
    stopLoading('btn-download-backup-local');
    if (result.ok) {
        // Remember the directory chosen in the dialog
        if (result.saveDir) {
            document.getElementById('backup-local-dir').value = result.saveDir;
            await BM.store.set('backup.localDir', result.saveDir);
        }
        setOutput('backup-local-output',
            `✅ Backup downloaded!\n📄 File: ${result.filename}\n📂 Saved to: ${result.localPath}`, 'success');
        toast(`✅ Backup saved to Mac: ${result.filename}`, 'success');
    } else if (result.cancelled) {
        setOutput('backup-local-output', 'Cancelled.', '');
    } else {
        setOutput('backup-local-output', '❌ Download failed: ' + result.error, 'error');
        toast('❌ Download failed: ' + result.error, 'error');
    }
});

// Google Drive — real OAuth2 flow
function setGDriveSignedIn(email) {
    document.getElementById('gdrive-creds-section').classList.add('hidden');
    document.getElementById('gdrive-signed-in-section').classList.remove('hidden');
    document.getElementById('gdrive-user-text').textContent = `✅ Signed in as ${email}`;
}
function setGDriveSignedOut() {
    document.getElementById('gdrive-creds-section').classList.remove('hidden');
    document.getElementById('gdrive-signed-in-section').classList.add('hidden');
}

// Restore stored credentials into fields on load
BM.gdrive.status().then(status => {
    if (status.creds) {
        document.getElementById('gdrive-client-id').value = status.creds.clientId || '';
        document.getElementById('gdrive-client-secret').value = status.creds.clientSecret || '';
    }
    if (status.loggedIn) setGDriveSignedIn(status.email);
    else setGDriveSignedOut();
});

document.getElementById('btn-gdrive-save-creds')?.addEventListener('click', async () => {
    const clientId = document.getElementById('gdrive-client-id').value.trim();
    const clientSecret = document.getElementById('gdrive-client-secret').value.trim();
    if (!clientId || !clientSecret) { toast('⚠️ Both Client ID and Secret are required', 'error'); return; }
    await BM.gdrive.saveCredentials({ clientId, clientSecret });
    toast('✅ Credentials saved — now click Sign in with Google', 'success');
});

document.getElementById('btn-gdrive-login')?.addEventListener('click', async () => {
    const clientId = document.getElementById('gdrive-client-id').value.trim();
    const clientSecret = document.getElementById('gdrive-client-secret').value.trim();
    if (clientId && clientSecret) await BM.gdrive.saveCredentials({ clientId, clientSecret });

    showLoading('btn-gdrive-login', '⏳ Opening browser...');
    setOutput('backup-drive-output', '🌐 Google sign-in opened in your browser. Complete it there, then return here.', '');
    const result = await BM.gdrive.login();
    stopLoading('btn-gdrive-login');
    if (result.ok) {
        setGDriveSignedIn(result.email);
        setOutput('backup-drive-output', `✅ Signed in as ${result.email}`, 'success');
        toast(`✅ Signed in as ${result.email}`, 'success');
    } else {
        setOutput('backup-drive-output', '❌ Login failed: ' + result.error, 'error');
        toast('❌ Login failed: ' + result.error, 'error');
    }
});

document.getElementById('btn-gdrive-logout')?.addEventListener('click', async () => {
    await BM.gdrive.logout();
    setGDriveSignedOut();
    setOutput('backup-drive-output', 'Signed out from Google Drive.', '');
    toast('✅ Signed out', 'info');
});

document.getElementById('btn-gdrive-upload')?.addEventListener('click', async () => {
    const folderId = document.getElementById('gdrive-folder-id').value.trim() || undefined;
    showLoading('btn-gdrive-upload', '⏳ Uploading...');
    const folderMsg = folderId
        ? `🔍 Resolving folder "${folderId}"…`
        : '📥 Downloading backup from VPS via SFTP…';
    setOutput('backup-drive-output', folderMsg, '');
    const result = await BM.gdrive.uploadBackup({ folderId });
    stopLoading('btn-gdrive-upload');
    if (result.ok) {
        const folderNote = result.folderResolved ? `\n📂 Folder ID resolved: ${result.folderResolved}` : '';
        setOutput('backup-drive-output', `✅ Uploaded to Google Drive!\n📄 File: ${result.driveFileName}\n🆔 Drive ID: ${result.driveFileId}${folderNote}`, 'success');
        toast(`✅ Backup uploaded to Google Drive`, 'success');
    } else {
        setOutput('backup-drive-output', '❌ Upload failed: ' + result.error, 'error');
        toast('❌ Upload failed: ' + result.error, 'error');
    }
});



// ═══════════════════════════════════════════════════════════
// PANEL: Live Logs
// ═══════════════════════════════════════════════════════════
async function loadLogs() {
    const lines = parseInt(document.getElementById('logs-lines').value) || 50;
    document.getElementById('logs-output').textContent = 'Loading...';
    const result = await BM.vps.logs(lines);
    document.getElementById('logs-output').textContent = result.ok ? result.logs : '❌ ' + result.error;
    // Scroll to bottom
    const el = document.getElementById('logs-output');
    el.scrollTop = el.scrollHeight;
}

document.getElementById('btn-refresh-logs')?.addEventListener('click', loadLogs);

document.getElementById('btn-auto-refresh')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (logsAutoRefreshTimer) {
        clearInterval(logsAutoRefreshTimer);
        logsAutoRefreshTimer = null;
        btn.textContent = '▶ Auto (5s)';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-ghost');
    } else {
        logsAutoRefreshTimer = setInterval(loadLogs, 5000);
        loadLogs();
        btn.textContent = '⏸ Stop Auto';
        btn.classList.remove('btn-ghost');
        btn.classList.add('btn-primary');
    }
});

// ─── Reconnect WhatsApp ────────────────────────────────────────────────────────

let _reconnectListenersRegistered = false;
let _countdownInterval = null;

function initReconnectListeners() {
    if (_reconnectListenersRegistered || !window.BotManager?.onReconnect) return;
    _reconnectListenersRegistered = true;
    const BM = window.BotManager;

    BM.onReconnect.start(() => {
        const out = document.getElementById('reconnect-output');
        if (out) { out.textContent = ''; out.classList.remove('hidden'); }
        const wrap = document.getElementById('reconnect-countdown-wrap');
        if (wrap) wrap.classList.add('hidden');
        const btn = document.getElementById('btn-reconnect');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Running…'; }
    });

    BM.onReconnect.update((line) => {
        const out = document.getElementById('reconnect-output');
        if (!out) return;
        out.textContent += line + '\n';
        out.scrollTop = out.scrollHeight;
    });

    BM.onReconnect.countdown((totalSecs) => {
        const wrap = document.getElementById('reconnect-countdown-wrap');
        const secsEl = document.getElementById('reconnect-countdown-secs');
        const fill = document.getElementById('reconnect-progress-fill');
        if (!wrap || !secsEl || !fill) return;

        wrap.classList.remove('hidden');
        let remaining = totalSecs;
        fill.style.width = '100%';

        if (_countdownInterval) clearInterval(_countdownInterval);
        _countdownInterval = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(_countdownInterval);
                secsEl.textContent = '0';
                fill.style.width = '0%';
                wrap.classList.add('hidden');
                return;
            }
            secsEl.textContent = remaining;
            fill.style.width = `${Math.round((remaining / totalSecs) * 100)}%`;
        }, 1000);
    });

    BM.onReconnect.done(() => {
        if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null; }
        const wrap = document.getElementById('reconnect-countdown-wrap');
        if (wrap) wrap.classList.add('hidden');
        const btn = document.getElementById('btn-reconnect');
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Reconnect'; }
        const out = document.getElementById('reconnect-output');
        if (out) out.textContent += '\n✅ Done.\n';
        toast('✅ Reconnect sequence complete — check QR panel if needed', 'success');
    });
}

document.getElementById('btn-reconnect')?.addEventListener('click', () => {
    if (!window.BotManager?.vps?.reconnect) {
        toast('❌ BotManager not ready', 'error'); return;
    }
    initReconnectListeners();
    window.BotManager.vps.reconnect();
});

// ═══════════════════════════════════════════════════════════
// PANEL: Bot Status — visual dashboard
// ═══════════════════════════════════════════════════════════
let statusAutoTimer = null;

function colorizeLogLine(line) {
    const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (/error|ERR|FATAL|fail/i.test(line)) return `<span class="log-err">${escaped}</span>`;
    if (/warn|WARNING/i.test(line)) return `<span class="log-warn">${escaped}</span>`;
    if (/INFO|started|loaded|initialized|✅|OK/i.test(line)) return `<span class="log-info">${escaped}</span>`;
    if (/Gemini|Groq|started|active/i.test(line)) return `<span class="log-ok">${escaped}</span>`;
    return escaped;
}

function renderStatusDashboard(s) {
    // Show dashboard, hide placeholder
    document.getElementById('status-dashboard').classList.remove('hidden');
    document.getElementById('status-placeholder').classList.add('hidden');

    // ── Hero card ──────────────────────────────────────────
    const dot = document.getElementById('status-dot');
    const label = document.getElementById('status-hero-label');
    const sub = document.getElementById('status-hero-sub');
    dot.className = `status-dot ${s.state}`;
    label.className = `status-hero-label ${s.state}`;
    label.textContent = s.state === 'active' ? '● Running'
        : s.state === 'failed' ? '● Failed'
            : '● Inactive';
    sub.textContent = s.sinceAgo
        ? `${s.description} — up ${s.sinceAgo}`
        : s.description;

    document.getElementById('chip-node').textContent = `Node ${s.nodeVersion}`;
    document.getElementById('chip-bot').textContent = `Bot v${s.botVersion}`;

    // ── Metric cards ──────────────────────────────────────
    document.getElementById('metric-uptime').textContent = s.uptime || '—';
    document.getElementById('metric-pid').textContent = s.pid || '—';
    document.getElementById('metric-tasks').textContent = s.tasks || '—';
    document.getElementById('metric-cpu').textContent = s.cpuTime || '—';
    document.getElementById('metric-procmem').textContent = s.processMemory || '—';
    document.getElementById('metric-since').textContent = s.sinceDate
        ? s.sinceDate.replace(/\s+WIB|UTC|GMT.*/i, '').trim()
        : '—';

    // ── Memory bar ────────────────────────────────────────
    const { used, total, pct } = s.mem;
    const free = total - used;
    document.getElementById('mem-bar-label').textContent = `${used.toLocaleString()} / ${total.toLocaleString()} MB`;
    document.getElementById('mem-bar-pct').textContent = `${pct}%`;
    document.getElementById('mem-bar-free').textContent = `${free.toLocaleString()} MB`;
    const fill = document.getElementById('mem-bar-fill');
    fill.style.width = `${Math.min(pct, 100)}%`;
    fill.className = `mem-bar-fill${pct >= 85 ? ' danger' : pct >= 65 ? ' warn' : ''}`;

    // ── Log tail ──────────────────────────────────────────
    const logEl = document.getElementById('status-log-tail');
    if (s.logs && s.logs.length) {
        logEl.innerHTML = s.logs.map(colorizeLogLine).join('\n');
        logEl.scrollTop = logEl.scrollHeight;
    } else {
        logEl.textContent = '(no recent log lines)';
    }
}

async function loadStatus() {
    showLoading('btn-refresh-status', '⏳ Loading...');
    const result = await BM.vps.status();
    stopLoading('btn-refresh-status');
    if (result.ok && result.status) {
        renderStatusDashboard(result.status);
    } else {
        document.getElementById('status-placeholder').classList.remove('hidden');
        document.getElementById('status-placeholder').innerHTML =
            `<span style="color:var(--red)">❌ ${result.error || 'Failed to fetch status'}</span>`;
        document.getElementById('status-dashboard').classList.add('hidden');
        toast('❌ Status fetch failed: ' + (result.error || 'unknown error'), 'error');
    }
}

document.getElementById('btn-refresh-status')?.addEventListener('click', loadStatus);

document.getElementById('btn-auto-status')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (statusAutoTimer) {
        clearInterval(statusAutoTimer);
        statusAutoTimer = null;
        btn.textContent = '▶ Auto (30s)';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-ghost');
    } else {
        statusAutoTimer = setInterval(loadStatus, 30000);
        loadStatus();
        btn.textContent = '⏸ Stop Auto';
        btn.classList.remove('btn-ghost');
        btn.classList.add('btn-primary');
    }
});


// ═══════════════════════════════════════════════════════════
// PANEL: Import Settings (from VPS or XML file)
// ═══════════════════════════════════════════════════════════

// ── Import tab switching ──────────────────────────────────
document.querySelectorAll('.import-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.import-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.import-tab-pane').forEach(p => p.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById(`import-tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
});

/**
 * Apply an importAll result to every panel's fields.
 * Called after a successful vps:importAll.
 */
function applyImportedConfig(result) {
    const { envVars = {}, botConfig = {}, meta = {} } = result;

    // --- API Keys panel ---
    if (envVars['GEMINI_API_KEY']) document.getElementById('key-gemini').value = envVars['GEMINI_API_KEY'];
    if (envVars['GROQ_API_KEY']) document.getElementById('key-groq').value = envVars['GROQ_API_KEY'];
    if (envVars['POLLINATIONS_API_KEY']) document.getElementById('key-pollinations').value = envVars['POLLINATIONS_API_KEY'];

    // --- Persona panel ---
    if (botConfig.characterPrompt) document.getElementById('persona-prompt').value = botConfig.characterPrompt;
    if (botConfig.botName) document.getElementById('persona-name').value = botConfig.botName;
    if (botConfig.timezone || envVars['TZ']) document.getElementById('persona-timezone').value = botConfig.timezone || envVars['TZ'] || 'Asia/Jakarta';

    // --- Keywords panel ---
    if (botConfig.groupTriggerWord !== undefined) document.getElementById('kw-trigger').value = botConfig.groupTriggerWord;
    if (botConfig.autoReplyEnabled !== undefined) document.getElementById('kw-autoreply').checked = botConfig.autoReplyEnabled !== false;

    // --- Human Behavior panel ---
    const hb = botConfig.humanBehavior || {};
    if (hb.typingWpm) document.getElementById('hb-wpm').value = hb.typingWpm;
    if (hb.readDelayMin !== undefined) document.getElementById('hb-read-min').value = hb.readDelayMin;
    if (hb.readDelayMax !== undefined) document.getElementById('hb-read-max').value = hb.readDelayMax;
    if (hb.burstPauseMin !== undefined) document.getElementById('hb-burst-min').value = hb.burstPauseMin;
    if (hb.enabled !== undefined) document.getElementById('hb-enabled').checked = hb.enabled !== false;

    // --- Group Behavior panel ---
    if (botConfig.groupMentionOnly !== undefined) document.getElementById('grp-mention-only').checked = !!botConfig.groupMentionOnly;
    if (botConfig.groupTriggerWord) document.getElementById('grp-trigger-word').value = botConfig.groupTriggerWord;
    if (botConfig.allowedGroups) document.getElementById('grp-allowed').value = (botConfig.allowedGroups || []).join(', ');
    if (botConfig.blockedGroups) document.getElementById('grp-blocked').value = (botConfig.blockedGroups || []).join(', ');

    // --- Contacts ---
    if (Array.isArray(botConfig.savedContacts)) {
        contacts = botConfig.savedContacts;
        renderContactsTable();
    }

    // --- Build summary cards ---
    const summaryEl = document.getElementById('import-summary');
    const items = [
        { label: 'Gemini API Keys', value: envVars['GEMINI_API_KEY'] ? `${envVars['GEMINI_API_KEY'].split(',').length} key(s)` : null },
        { label: 'Groq API Key', value: envVars['GROQ_API_KEY'] ? '✅ Configured' : null },
        { label: 'Pollinations Key', value: envVars['POLLINATIONS_API_KEY'] ? '✅ Configured' : null },
        { label: 'Bot Name', value: botConfig.botName || null },
        { label: 'Persona', value: botConfig.characterPrompt ? `${botConfig.characterPrompt.substring(0, 60)}…` : null },
        { label: 'Timezone', value: botConfig.timezone || envVars['TZ'] || null },
        { label: 'Contacts', value: (botConfig.savedContacts || []).length > 0 ? `${botConfig.savedContacts.length} saved` : null },
        { label: 'Human Behavior', value: botConfig.humanBehavior ? '✅ Configured' : null },
        { label: 'Group Mode', value: botConfig.groupMentionOnly ? 'Mention-only' : 'All messages' },
        { label: 'Health Check Whitelist', value: envVars['HEALTH_CHECK_WHITELIST'] ? `${envVars['HEALTH_CHECK_WHITELIST'].split(',').length} number(s)` : null },
        { label: 'Node.js (VPS)', value: meta.nodeVersion || null },
        { label: 'Memory (VPS)', value: meta.memory ? `${meta.memory} MB` : null },
    ];

    summaryEl.innerHTML = items.map(item => {
        const hasValue = item.value !== null && item.value !== undefined && item.value !== '';
        return `<div class="import-item ${hasValue ? 'ok' : 'empty'}">
            <div class="import-item-label">${item.label}</div>
            <div class="import-item-value">${hasValue ? item.value : 'Not configured'}</div>
        </div>`;
    }).join('');

    document.getElementById('import-summary-card').classList.remove('hidden');
}

document.getElementById('btn-import-vps')?.addEventListener('click', async () => {
    showLoading('btn-import-vps', '⏳ Importing...');
    setOutput('import-output', 'Connecting to VPS and reading all configuration…', '');
    const result = await BM.vps.importAll();
    stopLoading('btn-import-vps');
    if (result.ok) {
        setOutput('import-output', '✅ Import successful! All panels have been pre-filled.', 'success');
        applyImportedConfig(result);
        toast('✅ Settings imported from VPS — check each panel to review', 'success');
    } else {
        setOutput('import-output', '❌ Import failed:\n' + result.error, 'error');
        toast('❌ Import failed: ' + result.error, 'error');
    }
});

// ── Import from File (XML) ────────────────────────────────
document.getElementById('btn-import-file')?.addEventListener('click', async () => {
    showLoading('btn-import-file', '⏳ Loading...');
    const result = await BM.settings.importFromFile();
    stopLoading('btn-import-file');
    if (result.cancelled) {
        setOutput('import-file-output', 'Import cancelled.', ''); return;
    }
    if (result.ok) {
        setOutput('import-file-output',
            `✅ Settings loaded from file!\n📄 ${result.path}\n⚙️ Restored ${Object.keys(result.settings).length} settings.`, 'success');
        // Reload VPS fields from store and auto-fill panels from restored data
        await loadVpsFields();
        // Build an importAll-compatible result from the file settings to fill all panels
        const s = result.settings;
        try {
            const envVars = {
                GEMINI_API_KEY: s['gemini_key'] || s['GEMINI_API_KEY'] || '',
                GROQ_API_KEY: s['groq_key'] || s['GROQ_API_KEY'] || '',
                POLLINATIONS_API_KEY: s['pollinations_key'] || s['POLLINATIONS_API_KEY'] || '',
            };
            const botConfig = {};
            // Try reading restored config JSON key if present
            Object.entries(s).filter(([k]) => k.startsWith('bot.')).forEach(([k, v]) => {
                botConfig[k.replace('bot.', '')] = v;
            });
            applyImportedConfig({ envVars, botConfig, meta: {} });
        } catch { /* best-effort panel filling */ }
        toast(`✅ Settings restored from file (${Object.keys(result.settings).length} entries)`, 'success');
    } else {
        setOutput('import-file-output', '❌ Import failed: ' + result.error, 'error');
        toast('❌ Import failed: ' + result.error, 'error');
    }
});

// ── Export Settings (both buttons trigger same action) ────
async function doExportSettings(outputId) {
    const result = await BM.settings.export();
    if (result.cancelled) return;
    if (result.ok) {
        if (outputId) setOutput(outputId, `✅ Settings exported!\n📄 Saved to: ${result.path}`, 'success');
        toast('✅ Settings exported to XML', 'success');
    } else {
        if (outputId) setOutput(outputId, '❌ Export failed: ' + result.error, 'error');
        toast('❌ Export failed: ' + result.error, 'error');
    }
}
document.getElementById('btn-export-settings')?.addEventListener('click', () => doExportSettings(null));
document.getElementById('btn-export-settings-standalone')?.addEventListener('click', () => doExportSettings('export-settings-output'));

// ═══════════════════════════════════════════════════════════
// PANEL: Uninstall
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-uninstall')?.addEventListener('click', async () => {
    const result = await BM.app.uninstall();
    if (result.cancelled) return;
    if (!result.ok) {
        toast('❌ Uninstall failed: ' + result.error, 'error');
    }
    // App will quit automatically if uninstall succeeded
});

// ═══════════════════════════════════════════════════════════
// PANEL: WhatsApp Number — change account + QR scan
// ═══════════════════════════════════════════════════════════
let qrPollTimer = null;
let lastQrData = null;
let qrExpireTimer = null;

function showQRPlaceholder(msg) {
    document.getElementById('qr-placeholder').classList.remove('hidden');
    document.getElementById('qr-result').classList.add('hidden');
    if (msg) {
        document.getElementById('qr-placeholder').querySelector('.qr-placeholder-text').innerHTML =
            msg + '<br /><span style="font-size:11px;color:var(--text-muted);">Waiting for QR from VPS…</span>';
    }
}

function showQRCanvas(data, logLines) {
    const canvas = document.getElementById('qr-canvas');
    try {
        // Use global QRCode from qrcode.js CDN
        QRCode.toCanvas(canvas, data, {
            width: 260,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        });
        document.getElementById('qr-placeholder').classList.add('hidden');
        document.getElementById('qr-result').classList.remove('hidden');
        // 60-second QR expiry countdown
        clearTimeout(qrExpireTimer);
        let secs = 60;
        const expEl = document.getElementById('qr-expires-txt');
        expEl.innerHTML = `<span class="qr-scanning-pulse"></span> Expires in ${secs}s — scan now with WhatsApp`;
        qrExpireTimer = setInterval(() => {
            secs--;
            if (secs <= 0) {
                clearInterval(qrExpireTimer);
                expEl.textContent = '⏰ QR expired — refreshing…';
                doQRPoll(); // auto-refresh on expire
            } else {
                expEl.innerHTML = `<span class="qr-scanning-pulse"></span> Expires in ${secs}s — scan now with WhatsApp`;
            }
        }, 1000);
    } catch (e) {
        showQRPlaceholder('⚠️ Could not render QR: ' + e.message);
    }

    if (logLines) {
        const logEl = document.getElementById('qr-log-tail');
        logEl.textContent = logLines;
        logEl.scrollTop = logEl.scrollHeight;
    }
}

async function doQRPoll() {
    const result = await BM.vps.pollQR();
    if (result.rawLogs) {
        document.getElementById('qr-log-tail').textContent = result.rawLogs;
    }
    if (result.ok && result.qrData && result.qrData !== lastQrData) {
        lastQrData = result.qrData;
        showQRCanvas(result.qrData, result.rawLogs);
    } else if (!result.qrData) {
        // No QR yet — keep placeholder updated
        const logEl = document.getElementById('qr-log-tail');
        if (result.rawLogs) logEl.textContent = result.rawLogs;
    }
}

function startQRPolling() {
    if (qrPollTimer) clearInterval(qrPollTimer);
    lastQrData = null;
    document.getElementById('btn-stop-qr').classList.remove('hidden');
    document.getElementById('btn-poll-qr').classList.add('hidden');
    showQRPlaceholder('\uD83D\uDD04 Polling VPS for QR code…');
    doQRPoll(); // immediate first poll
    qrPollTimer = setInterval(doQRPoll, 5000);
    toast('🔍 Polling VPS for QR code every 5s…', 'info');
}

function stopQRPolling() {
    if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
    document.getElementById('btn-stop-qr').classList.add('hidden');
    document.getElementById('btn-poll-qr').classList.remove('hidden');
}

document.getElementById('btn-change-number')?.addEventListener('click', async () => {
    const confirmed = confirm(
        '⚠️ Change WhatsApp Account\n\n' +
        'This will:\n' +
        '  1. Stop the bot\n' +
        '  2. Delete the WhatsApp session on your VPS\n' +
        '  3. Restart the bot (new QR will be generated)\n\n' +
        'The currently linked number will be disconnected.\n\n' +
        'Continue?'
    );
    if (!confirmed) return;

    showLoading('btn-change-number', '⏳ Clearing session…');
    setOutput('change-number-output', '🔄 Stopping bot and clearing WhatsApp session on VPS…', '');
    const result = await BM.vps.changeNumber();
    stopLoading('btn-change-number');

    if (result.ok) {
        setOutput('change-number-output',
            '✅ Session cleared! Bot is restarting.\n📷 Scan the QR code below to link a new WhatsApp number.', 'success');
        toast('✅ Session cleared — starting QR poll', 'success');
        // Auto-start QR polling
        startQRPolling();
    } else {
        setOutput('change-number-output', '❌ Failed: ' + result.error, 'error');
        toast('❌ Failed: ' + result.error, 'error');
    }
});

document.getElementById('btn-poll-qr')?.addEventListener('click', startQRPolling);
document.getElementById('btn-stop-qr')?.addEventListener('click', () => {
    stopQRPolling();
    toast('⏹ QR polling stopped', 'info');
});
document.getElementById('btn-refresh-qr')?.addEventListener('click', doQRPoll);

// ═══════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════
(async function init() {
    await loadVpsFields();
    // Auto-test connection on start if we have a host configured
    const host = await BM.store.get('vps.host');
    if (host) {
        const result = await BM.ssh.test();
        setBadge(result.ok ? 'connected' : 'error');
    }
})();

