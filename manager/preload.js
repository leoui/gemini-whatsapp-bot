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
        logs: (lines) => ipcRenderer.invoke('vps:logs', lines),
        setEnv: (vars) => ipcRenderer.invoke('vps:setEnv', vars),
        importAll: () => ipcRenderer.invoke('vps:importAll'),
    },
    // Bot config
    bot: {
        readConfig: () => ipcRenderer.invoke('bot:readConfig'),
        saveConfig: (patch) => ipcRenderer.invoke('bot:saveConfig', patch),
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

