'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Tiến trình chính còn kiểm tra lại nguồn gọi; preload không chạy trong iframe chat.
const isStatusPage = window.location.protocol === 'file:';
const isMainApp = window.location.protocol === 'http:' && window.location.hostname === '127.0.0.1';

if (isStatusPage || isMainApp) {
    const bridge = {
        getState: () => ipcRenderer.invoke('status:get-state'),
        retryStartup: () => ipcRenderer.invoke('status:retry'),
        openConfigDir: () => ipcRenderer.invoke('status:open-config-dir'),
        closeChatWindow: () => ipcRenderer.invoke('status:close-chat-window'),
        quitApp: () => ipcRenderer.invoke('status:quit'),
        onStateChange: callback => {
            if (typeof callback !== 'function') return () => {};
            const listener = (_event, state) => callback(state);
            ipcRenderer.on('status:update', listener);
            return () => ipcRenderer.removeListener('status:update', listener);
        }
    };
    contextBridge.exposeInMainWorld(isStatusPage ? 'desktopStatus' : 'desktopChat', bridge);
}
