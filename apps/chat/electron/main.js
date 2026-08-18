const { app, BrowserWindow, Notification, ipcMain, shell } = require('electron')
const os = require('os')
const path = require('path')
const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')
const QRCode = require('qrcode')

const { isMac, isLinux, isWindows } = require('which-runtime')
const { command, flag, sloppy } = require('paparam')
const pkg = require('../package.json')
const { name, productName, version, upgrade } = pkg

// Deep link scheme, e.g. lightchain://room/<key>. Declared explicitly rather
// than derived from the package name: a scoped name like @lcai-p2p/chat is not
// a legal scheme, and this is also the string users will see and type.
const protocol = 'lightchain'
// ESM, because the worker imports workspace packages that are ESM and this app
// is declared commonjs. Bare resolves the extension, matching apps/seeder.
const mainWorkerSpecifier = '/workers/main.mjs'

const workers = new Map()

const appName = productName ?? name

const cmd = command(
  appName,
  // Chromium owns flags this app does not declare — --disable-gpu, the sandbox
  // switches, --remote-debugging-port. Bailing on an unknown flag means the app
  // refuses to start over an argument that was never addressed to it, and the
  // user sees a stack trace for passing a documented Electron option.
  sloppy({ flags: true }),
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
  flag('--no-sandbox', 'start without Chromium sandbox').hide()
)

cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2))

const pearStore = cmd.flags.storage
const updates = cmd.flags.updates

if (pearStore) app.setPath('userData', pearStore)

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function sendToAll(name, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(name, data)
  }
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const appPath = getAppPath()
  let dir = null
  if (pearStore) {
    console.log('pear store: ' + pearStore)
    dir = pearStore
  } else if (appPath === null) {
    dir = path.join(os.tmpdir(), 'pear', appName)
  } else {
    const isSnap = !!process.env.SNAP_USER_COMMON
    const linuxConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    dir = isMac
      ? path.join(os.homedir(), 'Library', 'Application Support', appName)
      : isLinux
        ? isSnap
          ? path.join(process.env.SNAP_USER_COMMON, appName)
          : path.join(linuxConfigHome, appName)
        : path.join(os.homedir(), 'AppData', 'Local', appName)
  }

  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix'

  const worker = PearRuntime.run(require.resolve('..' + specifier), [
    updates,
    version,
    upgrade,
    productName + extension,
    dir,
    appPath
  ])
  const pipe = new FramedStream(worker)

  // Also echoed to this process. The worker is where the peer-to-peer work
  // happens and so where the interesting failures are, and forwarding its
  // output only to the renderer makes those invisible unless devtools is open.
  function sendWorkerStdout(data) {
    process.stdout.write(data)
    sendToAll('pear:worker:stdout:' + specifier, data)
  }
  function sendWorkerStderr(data) {
    process.stderr.write(data)
    sendToAll('pear:worker:stderr:' + specifier, data)
  }
  function sendWorkerIPC(data) {
    sendToAll('pear:worker:ipc:' + specifier, data)
  }
  function onBeforeQuit() {
    pipe.destroy()
  }
  ipcMain.handle('pear:worker:writeIPC:' + specifier, (evt, data) => {
    return pipe.write(data)
  })
  workers.set(specifier, pipe)
  pipe.on('data', sendWorkerIPC)
  worker.stdout.on('data', sendWorkerStdout)
  worker.stderr.on('data', sendWorkerStderr)
  worker.once('exit', (code) => {
    app.removeListener('before-quit', onBeforeQuit)
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier)
    pipe.removeListener('data', sendWorkerIPC)
    worker.stdout.removeListener('data', sendWorkerStdout)
    worker.stderr.removeListener('data', sendWorkerStderr)
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })
  app.on('before-quit', onBeforeQuit)
  return pipe
}

// Brand identity is the same on every platform; window chrome is not. macOS
// keeps its traffic lights and insets our content behind them, while Windows
// and Linux get native controls overlaid on a title bar we draw.
function windowChrome() {
  if (isMac) return { titleBarStyle: 'hiddenInset' }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      // Matches --lc-bg-elevated so the controls sit on our title bar rather
      // than a strip of a different colour.
      color: '#0f0f1d',
      symbolColor: '#b1b3d0',
      height: 38
    }
  }
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    // Painted before the renderer loads. Without it the window flashes white,
    // which is jarring against a dark interface.
    backgroundColor: '#06060e',
    show: false,
    ...windowChrome(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  win.once('ready-to-show', () => win.show())

  const devServerUrl = process.env.PEAR_DEV_SERVER_URL

  if (devServerUrl) {
    await win.loadURL(devServerUrl)
    win.webContents.openDevTools()
    return
  }

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

ipcMain.handle('pear:applyUpdate', () => {
  const pipe = getWorker(mainWorkerSpecifier)

  return new Promise((resolve, reject) => {
    function onData(data) {
      const message = data.toString()

      if (message === 'pear:updateApplied') {
        pipe.removeListener('data', onData)
        resolve()
      }
    }

    pipe.on('data', onData)
    pipe.write('pear:applyUpdate')
  })
})
ipcMain.handle('pear:startWorker', (evt, filename) => {
  getWorker(filename)
  return true
})
/**
 * The module grid for a QR code, for the renderer to draw.
 *
 * Encoded here rather than in the renderer because the encoder is a CommonJS
 * package with Node dependencies and the renderer is a sandboxed `file://` page
 * with no bundler. Only the grid crosses: the renderer builds the SVG from
 * `<rect>` elements, so nothing has to be injected as markup.
 */
ipcMain.handle('app:qr', (evt, text) => {
  try {
    // Medium correction. An invite is long, so the grid is already dense, and
    // the higher levels buy redundancy nobody needs on a screen at arm's length.
    const { modules } = QRCode.create(String(text ?? ''), { errorCorrectionLevel: 'M' })
    return { size: modules.size, data: Array.from(modules.data) }
  } catch (err) {
    console.error('could not encode a QR code:', err.message)
    return null
  }
})

/**
 * A desktop notification, raised only when the window cannot already show it.
 *
 * Focus is decided here rather than in the renderer: `document.hasFocus()` is
 * true for a window sitting behind another one, so a renderer that trusts it
 * stays silent exactly when a notification was the point.
 */
ipcMain.handle('app:notify', (evt, { title, body } = {}) => {
  if (!Notification.isSupported()) return false

  const [win] = BrowserWindow.getAllWindows()
  if (win && !win.isDestroyed() && win.isFocused()) return false

  const notification = new Notification({
    title: String(title ?? 'Lightchain'),
    body: String(body ?? ''),
    silent: false
  })
  notification.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  notification.show()
  return true
})

ipcMain.handle('app:afterUpdate', () => {
  if (isLinux && process.env.APPIMAGE) {
    app.relaunch({
      execPath: process.env.APPIMAGE,
      args: [
        '--appimage-extract-and-run',
        ...process.argv.slice(1).filter((arg) => arg !== '--appimage-extract-and-run')
      ]
    })
  } else if (!isWindows) {
    app.relaunch()
  }
  app.quit()
})

/**
 * Hands a `lightchain://` link to the window, raising it first.
 *
 * Held until a window exists: on Windows and Linux a link is what *starts* the
 * app, so it arrives before there is anything to send it to. Dropping it then
 * would mean the first click of an invite silently does nothing and the second
 * works, which is the kind of bug people blame themselves for.
 */
let pendingLink = null

function handleDeepLink(url) {
  if (typeof url !== 'string' || !url.toLowerCase().startsWith(protocol + '://')) return

  const [win] = BrowserWindow.getAllWindows()
  if (!win || win.isDestroyed() || win.webContents.isLoading()) {
    pendingLink = url
    return
  }

  if (win.isMinimized()) win.restore()
  win.focus()
  win.webContents.send('app:deepLink', url)
}

function flushDeepLink() {
  if (pendingLink === null) return
  const url = pendingLink
  pendingLink = null
  handleDeepLink(url)
}

// The renderer asks once it is listening, rather than the main process guessing
// when that happened. A link sent before the handler is attached is lost.
ipcMain.handle('app:takeDeepLink', () => {
  const url = pendingLink
  pendingLink = null
  return url
})

/**
 * Opens a link in the user's browser, and refuses anything that is not a page.
 *
 * The allowlist is the whole point. `shell.openExternal` will hand the system
 * anything it is given, and a `file://` or a Windows shortcut from a stranger
 * in a chat room is a way to run a program on this machine.
 */
ipcMain.handle('app:openExternal', (evt, url) => {
  if (typeof url !== 'string') return false
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  void shell.openExternal(parsed.href)
  return true
})

// In development the executable is Electron itself, so the scheme has to be
// registered against it with this project as the argument, or the OS launches a
// bare Electron with no app when a link is clicked.
if (app.isPackaged) {
  app.setAsDefaultProtocolClient(protocol)
} else {
  app.setAsDefaultProtocolClient(protocol, process.execPath, [path.resolve(process.argv[1] ?? '.')])
}

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

const lock = app.requestSingleInstanceLock()

if (!lock) {
  app.quit()
} else {
  // Clicking a link while the app is already running starts a second process,
  // which hands its arguments here and exits. Without the single-instance lock
  // it would instead open a second window onto the same Corestore, which
  // deadlocks rather than failing.
  app.on('second-instance', (evt, args) => {
    handleDeepLink(args.find((arg) => arg.toLowerCase().startsWith(protocol + '://')))
  })

  // The link that started the app, on Windows and Linux, is just an argument.
  pendingLink =
    process.argv.find((arg) => arg.toLowerCase().startsWith(protocol + '://')) ?? pendingLink

  app.whenReady().then(() => {
    createWindow()
      .then(flushDeepLink)
      .catch((err) => {
        console.error('Failed to create window:', err)
        app.quit()
      })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => {
          console.error('Failed to create window:', err)
        })
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
