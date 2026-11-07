// Sandboxed preload (must be CommonJS). Exposes a minimal, typed API to the host UI.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('mdshare', {
  pick: () => ipcRenderer.invoke('share:pick', false),
  pickFolder: () => ipcRenderer.invoke('share:pick', true),
  // Electron 32+: File.path is gone; webUtils resolves the real path of a dropped file.
  shareDropped: files => ipcRenderer.invoke('share:paths', files.map(file => webUtils.getPathForFile(file))),
  stop: () => ipcRenderer.invoke('share:stop'),
  info: () => ipcRenderer.invoke('share:info'),
  copy: text => ipcRenderer.invoke('share:copy', text),
  onState: cb => {
    const listener = (_e, state) => cb(state)
    ipcRenderer.on('share:state', listener)
    return () => ipcRenderer.removeListener('share:state', listener)
  }
})
