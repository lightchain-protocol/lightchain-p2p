const { contextBridge, ipcRenderer } = require('electron')

function toBuffer(data) {
  if (data === null || data === undefined || typeof data === 'number') return data
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

contextBridge.exposeInMainWorld('bridge', {
  pkg() {
    return ipcRenderer.sendSync('pkg')
  },
  // The renderer is sandboxed and cannot read process.platform, but it has to
  // know which platform's conventions to apply — where the traffic lights sit,
  // which system font to use.
  platform() {
    return process.platform
  },
  applyUpdate: () => ipcRenderer.invoke('pear:applyUpdate'),
  appAfterUpdate: () => ipcRenderer.invoke('app:afterUpdate'),
  /**
   * Opens a URL in the user's browser. Refused unless it is http or https —
   * the check is in the main process, because a renderer that can be persuaded
   * to open `file://` has been persuaded to run something.
   */
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),
  /** The module grid for a QR code: `{ size, data }`, or null if it would not fit. */
  qr: (text) => ipcRenderer.invoke('app:qr', text),
  /**
   * Opens a file picker and returns what was chosen, as bytes.
   *
   * The renderer is sandboxed and has no filesystem, which is the right way
   * round: it never learns a path, only the name and the contents, so nothing
   * it does can be steered at a location on disk.
   */
  chooseFiles: (opts) => ipcRenderer.invoke('app:chooseFiles', opts),
  /**
   * Saves bytes somewhere the person chooses.
   *
   * The suggested name is scrubbed in the main process before it reaches the
   * dialog, because it came from whoever sent the attachment.
   */
  saveFile: (request) => ipcRenderer.invoke('app:saveFile', request),
  /** The `lightchain://` link that started the app, if one did. Consumed once. */
  takeDeepLink: () => ipcRenderer.invoke('app:takeDeepLink'),
  onDeepLink: (listener) => {
    const wrap = (evt, url) => listener(url)
    ipcRenderer.on('app:deepLink', wrap)
    return () => ipcRenderer.removeListener('app:deepLink', wrap)
  },
  startWorker: (specifier) => ipcRenderer.invoke('pear:startWorker', specifier),
  onWorkerStdout: (specifier, listener) => {
    const wrap = (evt, data) => listener(toBuffer(data))
    ipcRenderer.on('pear:worker:stdout:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stdout:' + specifier, wrap)
  },
  onWorkerStderr: (specifier, listener) => {
    const wrap = (evt, data) => listener(toBuffer(data))
    ipcRenderer.on('pear:worker:stderr:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:stderr:' + specifier, wrap)
  },
  onWorkerIPC: (specifier, listener) => {
    const wrap = (evt, data) => listener(toBuffer(data))
    ipcRenderer.on('pear:worker:ipc:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:ipc:' + specifier, wrap)
  },
  onWorkerExit: (specifier, listener) => {
    const wrap = (evt, code) => listener(code)
    ipcRenderer.on('pear:worker:exit:' + specifier, wrap)
    return () => ipcRenderer.removeListener('pear:worker:exit:' + specifier, wrap)
  },
  writeWorkerIPC: (specifier, data) => {
    return ipcRenderer.invoke('pear:worker:writeIPC:' + specifier, data)
  }
})
