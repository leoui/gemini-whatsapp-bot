'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('BotManager', {
    // Local config store
    store: {
        get: (key) => ipcRenderer.invoke('store:get', key),
        set: (key, value) => ipcRenderer.invoke('store:set', key, value),
        getAll: () => ipcRenderer.invoke('store:getAll'),
    },
    // SSH operations
    ssh: {
        test: () => ipcRenderer.invoke('ssh:test'),
    },
    // VPS operations
    vps: {
        status: () => ipcRenderer.invoke('vps:status'),
        restart: () => ipcRenderer.invoke('vps:restart'),
        backup: () => ipcRenderer.invoke('vps:backup'),
        downloadBackup: (opts) => ipcRenderer.invoke('vps:downloadBackup', opts),
        logs: (lines) => ipcRenderer.invoke('vps:logs', lines),
        setEnv: (vars) => ipcRenderer.invoke('vps:setEnv', vars),
        importAll: () => ipcRenderer.invoke('vps:importAll'),
        changeNumber: () => ipcRenderer.invoke('vps:changeNumber'),
        pollQR: () => ipcRenderer.invoke('vps:pollQR'),
        reconnect: () => ipcRenderer.send('vps:reconnect'),
    },
    // Reconnect streaming event listeners
    onReconnect: {
        start: (cb) => ipcRenderer.on('reconnect:start', (_e) => cb()),
        update: (cb) => ipcRenderer.on('reconnect:update', (_e, line) => cb(line)),
        countdown: (cb) => ipcRenderer.on('reconnect:countdown', (_e, secs) => cb(secs)),
        done: (cb) => ipcRenderer.on('reconnect:done', (_e) => cb()),
    },
    // Bot config
    bot: {
        readConfig: () => ipcRenderer.invoke('bot:readConfig'),
        saveConfig: (patch) => ipcRenderer.invoke('bot:saveConfig', patch),
        getModel: () => ipcRenderer.invoke('bot:getModel'),
        setModel: (modelId) => ipcRenderer.invoke('bot:setModel', modelId),
    },
    // Native dialogs
    dialog: {
        chooseDirectory: () => ipcRenderer.invoke('dialog:chooseDirectory'),
        openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
        saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
    },
    // Settings export / import
    settings: {
        export: () => ipcRenderer.invoke('settings:export'),
        importFromFile: () => ipcRenderer.invoke('settings:importFromFile'),
    },
    // App-level actions
    app: {
        uninstall: () => ipcRenderer.invoke('app:uninstall'),
    },
    // Google Drive
    gdrive: {
        saveCredentials: (creds) => ipcRenderer.invoke('gdrive:saveCredentials', creds),
        login: () => ipcRenderer.invoke('gdrive:login'),
        logout: () => ipcRenderer.invoke('gdrive:logout'),
        status: () => ipcRenderer.invoke('gdrive:status'),
        uploadBackup: (opts) => ipcRenderer.invoke('gdrive:uploadBackup', opts),
    },
});



