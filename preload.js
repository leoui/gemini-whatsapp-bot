const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // --- WhatsApp ---
    whatsapp: {
        connect: () => ipcRenderer.invoke('whatsapp:connect'),
        disconnect: () => ipcRenderer.invoke('whatsapp:disconnect'),
        getStatus: () => ipcRenderer.invoke('whatsapp:status'),
        sendMessage: (jid, text) => ipcRenderer.invoke('whatsapp:sendMessage', jid, text),
        onQR: (callback) => ipcRenderer.on('whatsapp:qr', (_, data) => callback(data)),
        onStatus: (callback) => ipcRenderer.on('whatsapp:status', (_, data) => callback(data)),
    },

    // --- Gemini ---
    gemini: {
        testKey: (key) => ipcRenderer.invoke('gemini:testKey', key),
        addKey: (key) => ipcRenderer.invoke('gemini:addKey', key),
        removeKey: (index) => ipcRenderer.invoke('gemini:removeKey', index),
        getKeys: () => ipcRenderer.invoke('gemini:getKeys'),
        chat: (chatId, message) => ipcRenderer.invoke('gemini:chat', chatId, message),
        clearHistory: (chatId) => ipcRenderer.invoke('gemini:clearHistory', chatId),
        clearAllHistories: () => ipcRenderer.invoke('gemini:clearAllHistories'),
    },

    // --- Calendar ---
    calendar: {
        setCredentials: (creds) => ipcRenderer.invoke('calendar:setCredentials', creds),
        getAuthUrl: () => ipcRenderer.invoke('calendar:getAuthUrl'),
        exchangeCode: (code) => ipcRenderer.invoke('calendar:exchangeCode', code),
        isConnected: () => ipcRenderer.invoke('calendar:isConnected'),
        listEvents: () => ipcRenderer.invoke('calendar:listEvents'),
    },

    // --- Config ---
    config: {
        get: (key) => ipcRenderer.invoke('config:get', key),
        set: (key, value) => ipcRenderer.invoke('config:set', key, value),
        getAll: () => ipcRenderer.invoke('config:getAll'),
        getBehavior: () => ipcRenderer.invoke('config:getBehavior'),
        updateBehavior: (updates) => ipcRenderer.invoke('config:updateBehavior', updates),
    },

    // --- Logs ---
    logs: {
        get: () => ipcRenderer.invoke('logs:get'),
        clear: () => ipcRenderer.invoke('logs:clear'),
        onNew: (callback) => ipcRenderer.on('log:new', (_, data) => callback(data)),
        onUpdate: (callback) => ipcRenderer.on('log:update', (_, data) => callback(data)),
    },

    // --- Files ---
    files: {
        list: (type) => ipcRenderer.invoke('files:list', type),
        cleanup: () => ipcRenderer.invoke('files:cleanup'),
        onReceived: (callback) => ipcRenderer.on('file:received', (_, data) => callback(data)),
    },

    // --- Utilities ---
    shell: {
        openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    },
    dialog: {
        openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
        saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
    },

    // --- App Management ---
    app: {
        exportConfig: () => ipcRenderer.invoke('app:exportConfig'),
        importConfig: () => ipcRenderer.invoke('app:importConfig'),
        uninstall: (options) => ipcRenderer.invoke('app:uninstall', options),
    },
});
