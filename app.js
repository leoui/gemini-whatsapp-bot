// ===== App State =====
const state = {
    currentPage: 'dashboard',
    incomingCount: 0,
    outgoingCount: 0,
    logCount: 0,
    characterSaveTimeout: null,
};

// ===== Navigation =====
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        switchPage(page);
    });
});

function switchPage(page) {
    // Update nav
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`[data-page="${page}"]`)?.classList.add('active');

    // Update content
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`)?.classList.add('active');

    state.currentPage = page;

    // Load page-specific data
    if (page === 'settings') loadSettings();
    if (page === 'logs') loadLogs();
    if (page === 'dashboard') refreshDashboard();
}

// ===== Toast Notifications =====
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
}

// ===== WhatsApp Connection =====
const app = {};

app.connectWhatsApp = async () => {
    const btnConnect = document.getElementById('btn-connect');
    btnConnect.disabled = true;
    btnConnect.innerHTML = `<span class="spinner"></span> Connecting...`;

    const result = await window.api.whatsapp.connect();
    if (!result.success) {
        showToast(`Connection failed: ${result.error}`, 'error');
        btnConnect.disabled = false;
        btnConnect.innerHTML = `Connect`;
    }
};

app.disconnectWhatsApp = async () => {
    await window.api.whatsapp.disconnect();
    showToast('WhatsApp disconnected', 'info');
    updateConnectionUI('disconnected');
};

// WhatsApp status listener
window.api.whatsapp.onStatus((status) => {
    updateConnectionUI(status.state, status.message, status.user);
});

// WhatsApp QR Code listener
window.api.whatsapp.onQR((qrDataUrl) => {
    const qrImage = document.getElementById('qr-image');
    const qrPlaceholder = document.getElementById('qr-placeholder');
    const qrCard = document.querySelector('.qr-card');

    qrImage.src = qrDataUrl;
    qrImage.classList.remove('hidden');
    qrPlaceholder.classList.add('hidden');
    qrCard.classList.add('scanning');
});

function updateConnectionUI(connectionState, message = '', user = null) {
    const statusIndicator = document.querySelector('.status-indicator');
    const statusText = document.querySelector('.connection-status span');
    const statusDot = document.getElementById('sidebar-status-dot');
    const btnConnect = document.getElementById('btn-connect');
    const btnDisconnect = document.getElementById('btn-disconnect');
    const connectedPanel = document.getElementById('connected-panel');
    const qrSection = document.getElementById('qr-section');
    const qrCard = document.querySelector('.qr-card');

    // Reset
    statusIndicator.className = 'status-indicator';
    statusDot.className = 'status-dot';

    switch (connectionState) {
        case 'connecting':
        case 'reconnecting':
            statusIndicator.classList.add('connecting');
            statusText.textContent = message || 'Connecting...';
            btnConnect.disabled = true;
            break;

        case 'qr':
            statusIndicator.classList.add('connecting');
            statusText.textContent = 'Scan QR Code';
            break;

        case 'connected':
            statusIndicator.classList.add('connected');
            statusDot.classList.add('connected');
            statusText.textContent = message || 'Connected';
            btnConnect.classList.add('hidden');
            btnDisconnect.classList.remove('hidden');
            qrSection.classList.add('hidden');
            connectedPanel.classList.remove('hidden');
            qrCard.classList.remove('scanning');

            if (user) {
                document.getElementById('connected-user-info').textContent =
                    `Connected as ${user.name || user.id}`;
            }
            showToast('WhatsApp connected successfully!', 'success');
            break;

        case 'disconnected':
        default:
            statusIndicator.classList.add('disconnected');
            statusText.textContent = message || 'Disconnected';
            btnConnect.classList.remove('hidden');
            btnConnect.disabled = false;
            btnConnect.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg> Connect`;
            btnDisconnect.classList.add('hidden');
            qrSection.classList.remove('hidden');
            connectedPanel.classList.add('hidden');

            document.getElementById('qr-image').classList.add('hidden');
            document.getElementById('qr-placeholder').classList.remove('hidden');
            qrCard.classList.remove('scanning');
            break;
    }
}

// ===== Message Log Listener =====
window.api.logs.onNew((entry) => {
    if (entry.direction === 'incoming') state.incomingCount++;
    if (entry.direction === 'outgoing') state.outgoingCount++;
    state.logCount++;

    updateStats();
    addMessageToFeed(entry);
    addLogEntry(entry);

    document.getElementById('log-badge').textContent = state.logCount;
});

function addMessageToFeed(entry) {
    const feed = document.getElementById('message-feed');
    const emptyState = feed.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const row = document.createElement('div');
    row.className = 'msg-row';

    const isIncoming = entry.direction === 'incoming';
    const icon = isIncoming ? '📥' : '🤖';
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    row.innerHTML = `
    <div class="msg-direction ${entry.direction}">${icon}</div>
    <div class="msg-content">
      <div class="msg-sender">${entry.sender || 'Unknown'}</div>
      <div class="msg-text">${escapeHtml(entry.text || '[media]')}</div>
    </div>
    <div class="msg-meta">
      <div>${time}</div>
      ${entry.delays ? `<div class="msg-delay">⏱ ${(entry.delays.total / 1000).toFixed(1)}s</div>` : ''}
    </div>
  `;

    feed.insertBefore(row, feed.firstChild);

    // Keep only last 50 entries in feed
    while (feed.children.length > 50) {
        feed.removeChild(feed.lastChild);
    }
}

function addLogEntry(entry) {
    if (state.currentPage !== 'logs') return;

    const container = document.getElementById('logs-container');
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const row = document.createElement('div');
    row.className = 'log-entry';
    row.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-sender ${entry.direction}">${escapeHtml(entry.sender || 'Unknown')}</span>
    <span class="log-message">${escapeHtml(entry.text || '[media]')}</span>
    <span class="log-status ${entry.status}">${entry.status || ''}</span>
  `;
    row.addEventListener('click', () => app.showMessageModal(entry));

    container.insertBefore(row, container.firstChild);
}

// ===== Settings =====
async function loadSettings() {
    // Load API keys
    await refreshKeyList();

    // Load model
    const model = await window.api.config.get('geminiModel');
    document.getElementById('select-model').value = model || 'gemini-2.5-flash';

    // Load character
    const character = await window.api.config.get('characterPrompt');
    document.getElementById('input-character').value = character || '';

    // Load behavior
    const behavior = await window.api.config.getBehavior();
    document.getElementById('toggle-behavior').checked = behavior.enabled;
    document.getElementById('input-typing-speed').value = behavior.typingSpeedWPM;
    document.getElementById('input-min-read').value = behavior.minReadDelay;
    document.getElementById('input-max-read').value = behavior.maxReadDelay;
    document.getElementById('input-max-per-min').value = behavior.maxMessagesPerMinute;
    document.getElementById('input-max-per-hour').value = behavior.maxMessagesPerHour;
    document.getElementById('toggle-active-hours').checked = behavior.activeHoursEnabled;
    document.getElementById('input-hours-start').value = behavior.activeHoursStart;
    document.getElementById('input-hours-end').value = behavior.activeHoursEnd;

    // Show/hide active hours range
    document.getElementById('active-hours-range').classList.toggle('hidden', !behavior.activeHoursEnabled);

    // Load auto-reply
    document.getElementById('toggle-auto-reply').checked = await window.api.config.get('autoReplyEnabled');

    // Load group mention only
    const groupMentionOnly = await window.api.config.get('groupMentionOnly');
    document.getElementById('toggle-group-mention').checked = groupMentionOnly !== false; // default true
    document.getElementById('group-trigger-word').value = await window.api.config.get('groupTriggerWord') || 'bot';

    // Load saved contacts
    app.loadContacts();

    // Load calendar status
    const calConnected = await window.api.calendar.isConnected();
    const calBadge = document.getElementById('calendar-status-badge');
    if (calConnected) {
        calBadge.textContent = 'Connected';
        calBadge.classList.add('connected');
    }
}

async function refreshKeyList() {
    const keys = await window.api.gemini.getKeys();
    const keyList = document.getElementById('key-list');
    const keyCountBadge = document.getElementById('key-count-badge');

    keyCountBadge.textContent = `${keys.length}/3`;
    document.getElementById('stat-keys').textContent = `${keys.length}/3`;

    if (keys.length === 0) {
        keyList.innerHTML = '<div class="empty-state" style="padding: 16px;"><p>No API keys added yet</p></div>';
        return;
    }

    keyList.innerHTML = keys.map((k, i) => `
    <div class="key-item ${k.isActive ? 'active' : ''}">
      <span class="key-label">${k.masked}</span>
      <span class="key-usage">${k.usage.used || 0} calls today</span>
      ${k.isActive ? '<span class="key-active-badge">● Active</span>' : ''}
      <button class="key-remove" onclick="app.removeApiKey(${i})" title="Remove key">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

app.addApiKey = async () => {
    const input = document.getElementById('input-api-key');
    const key = input.value.trim();
    if (!key) {
        showToast('Please enter an API key', 'error');
        return;
    }

    // Test the key first
    showToast('Testing API key...', 'info');
    const test = await window.api.gemini.testKey(key);

    if (!test.valid) {
        showToast(`Invalid API key: ${test.error}`, 'error');
        return;
    }

    const result = await window.api.gemini.addKey(key);
    if (result.success) {
        showToast('API key added successfully!', 'success');
        input.value = '';
        await refreshKeyList();
    } else {
        showToast(`Error: ${result.error}`, 'error');
    }
};

app.removeApiKey = async (index) => {
    const result = await window.api.gemini.removeKey(index);
    if (result.success) {
        showToast('API key removed', 'info');
        await refreshKeyList();
    } else {
        showToast(`Error: ${result.error}`, 'error');
    }
};

app.saveModel = async () => {
    const model = document.getElementById('select-model').value;
    await window.api.config.set('geminiModel', model);
    showToast(`Model changed to ${model}`, 'success');
};

app.autoSaveCharacter = () => {
    clearTimeout(state.characterSaveTimeout);
    state.characterSaveTimeout = setTimeout(async () => {
        const value = document.getElementById('input-character').value;
        await window.api.config.set('characterPrompt', value);
    }, 1000);
};

app.resetCharacter = async () => {
    const defaultPrompt = `You are a helpful, friendly assistant responding via WhatsApp. 
Keep responses concise and natural — like texting a friend. 
Use casual language, emojis occasionally, and break long responses into short paragraphs.
Never mention that you are an AI unless directly asked.`;

    document.getElementById('input-character').value = defaultPrompt;
    await window.api.config.set('characterPrompt', defaultPrompt);
    showToast('Character reset to default', 'info');
};

app.saveBehavior = async () => {
    const updates = {
        enabled: document.getElementById('toggle-behavior').checked,
        typingSpeedWPM: parseInt(document.getElementById('input-typing-speed').value),
        minReadDelay: parseInt(document.getElementById('input-min-read').value),
        maxReadDelay: parseInt(document.getElementById('input-max-read').value),
        maxMessagesPerMinute: parseInt(document.getElementById('input-max-per-min').value),
        maxMessagesPerHour: parseInt(document.getElementById('input-max-per-hour').value),
        activeHoursEnabled: document.getElementById('toggle-active-hours').checked,
        activeHoursStart: parseInt(document.getElementById('input-hours-start').value),
        activeHoursEnd: parseInt(document.getElementById('input-hours-end').value),
    };

    // Show/hide active hours range
    document.getElementById('active-hours-range').classList.toggle('hidden', !updates.activeHoursEnabled);

    await window.api.config.updateBehavior(updates);
};

app.saveAutoReply = async () => {
    const enabled = document.getElementById('toggle-auto-reply').checked;
    await window.api.config.set('autoReplyEnabled', enabled);
    showToast(`Auto-reply ${enabled ? 'enabled' : 'disabled'}`, 'info');
};

app.saveGroupMention = async () => {
    const enabled = document.getElementById('toggle-group-mention').checked;
    await window.api.config.set('groupMentionOnly', enabled);
    showToast(`Group mention-only ${enabled ? 'enabled' : 'disabled'}`, 'info');
};

app.saveGroupTriggerWord = async () => {
    const word = document.getElementById('group-trigger-word').value.trim().toLowerCase();
    if (word) {
        await window.api.config.set('groupTriggerWord', word);
        showToast(`Group trigger word set to "${word}"`, 'success');
    }
};

// ===== Contact Book =====
app.addContact = async () => {
    const name = document.getElementById('contact-name').value.trim();
    const shortcode = document.getElementById('contact-shortcode').value.trim();
    const phone = document.getElementById('contact-phone').value.trim();

    if (!name || !phone) {
        showToast('Name and phone number are required', 'error');
        return;
    }

    // Ensure shortcode starts with +
    const finalShortcode = shortcode ? (shortcode.startsWith('+') ? shortcode : `+${shortcode}`) : `+${name.split(' ')[0]}`;

    const contacts = (await window.api.config.get('savedContacts')) || [];

    // Check for duplicate shortcode
    if (contacts.some(c => c.shortcode.toLowerCase() === finalShortcode.toLowerCase())) {
        showToast(`Shortcode "${finalShortcode}" already exists`, 'error');
        return;
    }

    contacts.push({ name, shortcode: finalShortcode, phone });
    await window.api.config.set('savedContacts', contacts);

    // Clear inputs
    document.getElementById('contact-name').value = '';
    document.getElementById('contact-shortcode').value = '';
    document.getElementById('contact-phone').value = '';

    showToast(`Contact "${name}" saved as ${finalShortcode}`, 'success');
    app.loadContacts();
};

app.deleteContact = async (index) => {
    const contacts = (await window.api.config.get('savedContacts')) || [];
    const removed = contacts.splice(index, 1);
    await window.api.config.set('savedContacts', contacts);
    showToast(`Removed ${removed[0]?.name || 'contact'}`, 'info');
    app.loadContacts();
};

app.loadContacts = async () => {
    const contacts = (await window.api.config.get('savedContacts')) || [];
    const list = document.getElementById('contacts-list');
    const badge = document.getElementById('contacts-count-badge');

    badge.textContent = `${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`;

    if (contacts.length === 0) {
        list.innerHTML = '<p class="settings-desc" style="text-align:center; opacity:0.5; margin:8px 0;">No saved contacts yet</p>';
        return;
    }

    list.innerHTML = contacts.map((c, i) => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; border-bottom:1px solid var(--border-color, #333); gap:8px;">
            <div style="flex:1; min-width:0;">
                <strong style="color:var(--text-primary, #fff);">${c.name}</strong>
                <span style="color:var(--accent-color, #6c5ce7); margin-left:6px; font-size:0.85em;">${c.shortcode}</span>
                <span style="color:var(--text-secondary, #999); margin-left:6px; font-size:0.85em;">${c.phone}</span>
            </div>
            <button class="btn btn-sm" style="padding:2px 8px; font-size:0.75em; background:var(--danger-color, #e74c3c); border:none; color:#fff; border-radius:4px; cursor:pointer;" onclick="app.deleteContact(${i})">✕</button>
        </div>
    `).join('');
};

// ===== Config Export / Import =====
app.exportConfig = async () => {
    const result = await window.api.app.exportConfig();
    if (result.success) {
        showToast(`Config exported to ${result.path}`, 'success');
    } else if (result.error) {
        showToast(`Export failed: ${result.error}`, 'error');
    }
};

app.importConfig = async () => {
    const result = await window.api.app.importConfig();
    if (result.success) {
        showToast('Config imported! Reloading settings...', 'success');
        await loadSettings();
    } else if (result.error) {
        showToast(`Import failed: ${result.error}`, 'error');
    }
};

// ===== Uninstall =====
app.uninstallApp = () => {
    const saveConfig = document.getElementById('check-save-config').checked;

    // Show confirmation dialog
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <h3>🗑️ Uninstall Gemini WhatsApp Bot?</h3>
        <p>
          This will remove the app, WhatsApp session, downloaded files, and all settings.
          ${saveConfig ? '<br><strong>Your API keys and settings will be saved to the Desktop.</strong>' : '<br><strong style="color: var(--danger);">Your API keys and settings will be permanently deleted.</strong>'}
        </p>
        <div class="confirm-actions">
          <button class="btn btn-secondary" id="btn-cancel-uninstall">Cancel</button>
          <button class="btn btn-danger" id="btn-confirm-uninstall">Uninstall</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('btn-cancel-uninstall').onclick = () => overlay.remove();
    document.getElementById('btn-confirm-uninstall').onclick = async () => {
        overlay.querySelector('.confirm-dialog p').textContent = 'Uninstalling...';
        overlay.querySelector('.confirm-actions').innerHTML = '';

        const result = await window.api.app.uninstall({ saveConfig });
        if (result.success) {
            if (result.exportPath) {
                overlay.querySelector('.confirm-dialog p').textContent =
                    `Config saved to Desktop. Goodbye! 👋`;
            } else {
                overlay.querySelector('.confirm-dialog p').textContent = 'Goodbye! 👋';
            }
        } else {
            showToast(`Uninstall failed: ${result.error}`, 'error');
            overlay.remove();
        }
    };
};

// ===== Calendar =====
app.uploadCalendarCredentials = async () => {
    const result = await window.api.dialog.openFile({
        title: 'Select Google Calendar credentials.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
    });

    if (result.canceled || !result.filePaths.length) return;

    // Read file contents - use IPC since we can't access fs directly
    showToast('Processing credentials...', 'info');

    // The main process will read the file
    const filePath = result.filePaths[0];
    const setResult = await window.api.calendar.setCredentials(filePath);

    if (setResult.success) {
        showToast('Credentials loaded!', 'success');
        const authUrlResult = await window.api.calendar.getAuthUrl();
        if (authUrlResult.url) {
            document.getElementById('calendar-auth').classList.remove('hidden');
            document.getElementById('calendar-auth-link').href = authUrlResult.url;
        }
    } else {
        showToast('Invalid credentials file', 'error');
    }
};

app.openCalendarAuth = async () => {
    const result = await window.api.calendar.getAuthUrl();
    if (result.url) {
        window.api.shell.openExternal(result.url);
    }
};

app.submitCalendarCode = async () => {
    const code = document.getElementById('input-calendar-code').value.trim();
    if (!code) {
        showToast('Please paste the authorization code', 'error');
        return;
    }

    const result = await window.api.calendar.exchangeCode(code);
    if (result.success) {
        showToast('Google Calendar connected!', 'success');
        const badge = document.getElementById('calendar-status-badge');
        badge.textContent = 'Connected';
        badge.classList.add('connected');
    } else {
        showToast(`Calendar auth failed: ${result.error}`, 'error');
    }
};

// ===== Logs =====
async function loadLogs() {
    const logs = await window.api.logs.get();
    const container = document.getElementById('logs-container');

    if (!logs || logs.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No logs yet.</p></div>';
        return;
    }

    container.innerHTML = '';
    logs.forEach(entry => {
        const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const row = document.createElement('div');
        row.className = 'log-entry';
        row.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-sender ${entry.direction}">${escapeHtml(entry.sender || 'Unknown')}</span>
      <span class="log-message">${escapeHtml(entry.text || '[media]')}</span>
      <span class="log-status ${entry.status}">${entry.status || ''}</span>
    `;
        row.addEventListener('click', () => app.showMessageModal(entry));
        container.appendChild(row);
    });
}

app.clearLogs = async () => {
    await window.api.logs.clear();
    state.logCount = 0;
    document.getElementById('log-badge').textContent = '0';
    document.getElementById('logs-container').innerHTML = '<div class="empty-state"><p>No logs yet.</p></div>';
    showToast('Logs cleared', 'info');
};

app.clearAllHistory = async () => {
    const result = await window.api.gemini.clearAllHistories();
    if (result.success) {
        showToast('All chat memory cleared! Bot will start fresh conversations.', 'success');
    } else {
        showToast('Failed to clear history', 'error');
    }
};

// ===== Dashboard =====
async function refreshDashboard() {
    updateStats();
    const keys = await window.api.gemini.getKeys();
    document.getElementById('stat-keys').textContent = `${keys.length}/3`;

    let totalUsage = 0;
    keys.forEach(k => { totalUsage += k.usage?.used || 0; });
    document.getElementById('stat-quota').textContent = totalUsage;
}

function updateStats() {
    document.getElementById('stat-incoming').textContent = state.incomingCount;
    document.getElementById('stat-outgoing').textContent = state.outgoingCount;
}

// ===== Utilities =====
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== Message Detail Modal =====
app.showMessageModal = (entry) => {
    const modal = document.getElementById('message-modal');
    const title = document.getElementById('modal-title');
    const meta = document.getElementById('modal-meta');
    const message = document.getElementById('modal-message');

    const dirIcon = entry.direction === 'incoming' ? '📥' : '📤';
    const dirLabel = entry.direction === 'incoming' ? 'Incoming' : 'Outgoing';
    const time = new Date(entry.timestamp).toLocaleString([], {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    title.textContent = `${dirIcon} ${entry.sender || 'Unknown'}`;
    meta.innerHTML = `
        <div class="modal-meta-item">
            <span class="label">Time:</span>
            <span class="value">${time}</span>
        </div>
        <div class="modal-meta-item">
            <span class="label">Direction:</span>
            <span class="value ${entry.direction}">${dirLabel}</span>
        </div>
        <div class="modal-meta-item">
            <span class="label">Status:</span>
            <span class="value">${entry.status || '—'}</span>
        </div>
        ${entry.remoteJid ? `<div class="modal-meta-item">
            <span class="label">JID:</span>
            <span class="value" style="font-size:0.85em; opacity:0.7;">${escapeHtml(entry.remoteJid)}</span>
        </div>` : ''}
    `;
    message.textContent = entry.text || '[No text content]';
    modal.classList.add('active');
};

app.closeMessageModal = (event) => {
    if (event && event.target && event.target !== document.getElementById('message-modal')) return;
    document.getElementById('message-modal').classList.remove('active');
};

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('message-modal');
        if (modal?.classList.contains('active')) {
            modal.classList.remove('active');
        }
    }
});

// ===== Initialize =====
window.addEventListener('DOMContentLoaded', async () => {
    await refreshDashboard();

    // Check initial WhatsApp status
    const waStatus = await window.api.whatsapp.getStatus();
    if (waStatus.state === 'connected') {
        updateConnectionUI('connected');
    }
});

// Expose app to window for inline onclick handlers
window.app = app;
