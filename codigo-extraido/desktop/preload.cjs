const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('stadium', Object.freeze({
  getInfo: () => ipcRenderer.invoke('stadium:info'),
  copyText: text => ipcRenderer.invoke('stadium:copy', text),
  setFullscreen: value => ipcRenderer.invoke('stadium:fullscreen', value),
}));
