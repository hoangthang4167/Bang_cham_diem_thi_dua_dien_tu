'use strict';

const { contextBridge, ipcRenderer } = require('electron');

if (window.location.protocol === 'file:') {
    contextBridge.exposeInMainWorld('desktopStatus', {
        getState: () => ipcRenderer.invoke('status:get-state'),
        retryStartup: () => ipcRenderer.invoke('status:retry'),
        openConfigDir: () => ipcRenderer.invoke('status:open-config-dir'),
        quitApp: () => ipcRenderer.invoke('status:quit'),
        onStateChange: callback => {
            if (typeof callback !== 'function') return () => {};
            const listener = (_event, state) => callback(state);
            ipcRenderer.on('status:update', listener);
            return () => ipcRenderer.removeListener('status:update', listener);
        }
    });
}
