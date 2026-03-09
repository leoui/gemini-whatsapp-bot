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

// Google Drive (OAuth via browser window — placeholder flow)
document.getElementById('btn-gdrive-login')?.addEventListener('click', () => {
    // In a full implementation this would use a BrowserWindow to handle the OAuth flow.
    // The Google Drive OAuth client ID would be configured via .env or app config.
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=https://www.googleapis.com/auth/drive.file&access_type=offline';
    toast('ℹ️ Opening Google sign-in... (configure OAuth client ID in app settings)', 'info');
    // Placeholder — actual impl needs Google OAuth client ID registration
    setTimeout(() => {
        document.getElementById('gdrive-user-text').textContent = '⚠️ OAuth Client ID required — see INSTALL.md';
        document.getElementById('gdrive-folder-field').style.display = 'block';
    }, 500);
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

// ═══════════════════════════════════════════════════════════
// PANEL: Bot Status
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-refresh-status')?.addEventListener('click', async () => {
    showLoading('btn-refresh-status', 'Fetching...');
    const result = await BM.vps.status();
    stopLoading('btn-refresh-status');
    const el = document.getElementById('status-output');
    el.textContent = result.ok ? result.output : '❌ ' + result.error;
});

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
