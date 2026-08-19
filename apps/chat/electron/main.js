const { app, BrowserWindow, Notification, dialog, ipcMain, shell } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')
const QRCode = require('qrcode')

const { isMac, isLinux, isWindows } = require('which-runtime')
const { command, flag, sloppy } = require('paparam')
const windowState = require('./window-state')
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

/**
 * Everything this installation remembers, in one directory.
 *
 * The worker is handed this same path and lays `chat/` and `pear-runtime/` out
 * inside it, so anything the main process keeps belongs under here too.
 * Electron's own `userData` is not the same place: `--storage` points it here,
 * but left alone it names a directory nothing else in the application writes
 * to, and two instances started on separate storage would then share it.
 */
function storageDir() {
  if (pearStore) return pearStore
  if (!app.isPackaged) return path.join(os.tmpdir(), 'pear', appName)
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', appName)

  if (isLinux) {
    const isSnap = !!process.env.SNAP_USER_COMMON
    const linuxConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')

    return isSnap
      ? path.join(process.env.SNAP_USER_COMMON, appName)
      : path.join(linuxConfigHome, appName)
  }

  return path.join(os.homedir(), 'AppData', 'Local', appName)
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const appPath = getAppPath()
  const dir = storageDir()

  if (pearStore) console.log('pear store: ' + pearStore)

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

/**
 * How tall the title bar is, in both the platform's opinion and ours.
 *
 * Windows reserves this strip for the caption buttons and the renderer draws
 * its own bar to the same height. The two have to agree: too short and the
 * buttons overhang our content, too tall and there is a band of window nobody
 * owns. 38px is what comparable Electron applications settled on and what
 * `.titlebar` already uses.
 */
const TITLEBAR_HEIGHT = 38

// Brand identity is the same on every platform; window chrome is not. macOS
// keeps its traffic lights and insets our content behind them, while Windows
// and Linux get native controls overlaid on a title bar we draw.
function windowChrome() {
  if (isMac) return { titleBarStyle: 'hiddenInset' }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      // The dark palette's --lc-bg-elevated, because dark is the theme the
      // first paint uses. A stored light theme arrives with the settings a
      // moment later and repaints these through app:setTitleBarColours; until
      // then the wrong colour here would be a black block in the corner of a
      // light window.
      color: '#0f0f1d',
      symbolColor: '#b1b3d0',
      height: TITLEBAR_HEIGHT
    }
  }
}

/**
 * Repaints the native caption buttons when the theme changes.
 *
 * The buttons are drawn by Windows, not by us, so they do not inherit anything.
 * Their colour was fixed at the dark palette's elevated background, which meant
 * switching to the light theme left a black rectangle in the top-right corner
 * of an otherwise light window.
 *
 * The renderer sends the resolved token values rather than the main process
 * keeping its own copy of the palette, so there is one source of truth and the
 * buttons cannot drift from the bar they sit on.
 */
ipcMain.handle('app:setTitleBarColours', (evt, colours) => {
  if (isMac) return false

  const win = BrowserWindow.fromWebContents(evt.sender)
  if (!win || win.isDestroyed()) return false

  // Validated rather than trusted. This is reached from a window that spends
  // its life rendering text written by strangers, and the values go straight
  // into a platform API.
  const hex = /^#[0-9a-f]{6}$/i
  const color = String(colours?.color ?? '')
  const symbolColor = String(colours?.symbolColor ?? '')
  if (!hex.test(color) || !hex.test(symbolColor)) return false

  win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT })
  return true
})

/**
 * The window to open at when nothing has been remembered yet.
 *
 * Three columns share the width — a 236px sidebar, the conversation, and a
 * 260px member list — so this leaves the conversation comfortably wider than
 * the 68ch a message is allowed to run to with both of them open, and stays
 * above the 1080px point where the dashboard folds into a single column. It is
 * near the 1280x860 viewport `scripts/shoot.mjs` reviews every section at,
 * which is the size the interface is actually designed against.
 *
 * Larger than a 1366x768 laptop can show, deliberately: `windowState.restore`
 * clamps to the work area of the display the window opens on, and a default
 * small enough for the worst screen would be the wrong window everywhere else.
 *
 * Onboarding does not get a window of its own and the window is not resized
 * when it finishes. It is a centred overlay that is correct at any size, and a
 * window that changes shape while somebody is looking at it moves whatever they
 * were about to click out from under the pointer.
 */
const DEFAULT_BOUNDS = { width: 1320, height: 880 }

async function createWindow() {
  // Beside the worker's own `chat/settings.json` and `chat/vault.json`, in the
  // directory `--storage` moves. Two instances run against separate storage —
  // which is how a conversation is tested with oneself — each have to get their
  // own window back rather than fighting over one shared record of it.
  const stateFile = path.join(storageDir(), 'chat', 'window.json')
  const placement = windowState.restore(stateFile, DEFAULT_BOUNDS)
  const { maximised, ...bounds } = placement

  const win = new BrowserWindow({
    ...bounds,
    // Not a floor picked to stop the layout breaking: `scripts/shoot.mjs`
    // reviews every section at exactly 720px wide, so half a screen is a
    // supported size rather than one the app merely survives.
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

  windowState.track(win, stateFile, placement)

  win.once('ready-to-show', () => {
    // Maximised here rather than at construction, because `maximize()` shows
    // the window as a side effect — doing it earlier would put an unpainted
    // window on screen, which is the flash `show: false` exists to prevent.
    if (maximised) win.maximize()
    win.show()
  })

  // Denied by default, and the default is the point. Electron grants most
  // permissions to a renderer that asks, and this one displays text written by
  // strangers — so geolocation, notifications requested from the page, MIDI,
  // pointer lock and the rest are refused outright rather than left to whatever
  // Chromium decides. The camera is the single exception, because scanning an
  // invite from a QR code needs it, and even that is only allowed for the
  // application's own page rather than for anything that manages to navigate.
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    if (permission !== 'media') return callback(false)
    const url = contents.getURL()
    callback(url.startsWith('file://') || url === process.env.PEAR_DEV_SERVER_URL)
  })

  // Asked before a device is opened rather than when the page requests access,
  // and not covered by the handler above.
  win.webContents.session.setPermissionCheckHandler((_contents, permission) => {
    return permission === 'media'
  })

  // Nothing in this application should ever navigate away or open a second
  // window. A link goes through `app:openExternal`, which allows only http and
  // https, and anything else reaching here is a bug or an attempt.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (evt, url) => {
    if (url !== win.webContents.getURL()) evt.preventDefault()
  })

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
    // This listener sees everything the worker writes, including chat replies
    // on their way to the window, and a chunk holds whole messages only by
    // luck. Splitting on the delimiter is what stops the confirmation being
    // missed because it shared a chunk with the reply to something else.
    function onData(data) {
      if (data.toString().split('\n').includes('pear:updateApplied')) {
        pipe.removeListener('data', onData)
        resolve()
      }
    }

    pipe.on('data', onData)
    pipe.write('pear:applyUpdate\n')
  })
})
/**
 * Starts the worker. The one worker, by name.
 *
 * `getWorker` resolves whatever it is given against this package and spawns it
 * with the trust of the main process, and the renderer — which spends its life
 * displaying text written by strangers — could ask for anything. The allowlist
 * is the whole guard: there is exactly one worker, its path is known here, and
 * a request for anything else is a bug or an attempt.
 */
ipcMain.handle('pear:startWorker', (evt, filename) => {
  if (filename !== mainWorkerSpecifier) return false
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

/**
 * Strips a filename down to something that cannot escape the folder it is
 * saved into.
 *
 * The name on an attachment was chosen by whoever sent it, and a save dialog
 * pre-filled with `..\..\Windows\System32\evil.exe` is a way to put a file
 * somewhere it was not meant to go. Windows also reserves a handful of device
 * names that behave very strangely when written to, and refuses names ending
 * in a dot or a space.
 */
function safeFileName(name) {
  const stripped = String(name ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/^[a-zA-Z]:/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 255)

  if (stripped === '') return 'attachment'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stripped)) return `_${stripped}`
  return stripped
}

/** Picks files to attach. Returns their bytes, because the renderer cannot read disk. */
ipcMain.handle('app:chooseFiles', async (evt, opts) => {
  const win = BrowserWindow.fromWebContents(evt.sender)
  if (!win) return []

  const picked = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach files'
  })
  if (picked.canceled) return []

  const limit = Number(opts?.maxBytes) || 25 * 1024 * 1024
  const files = []

  for (const filePath of picked.filePaths) {
    const stat = await fs.promises.stat(filePath).catch(() => null)
    // Refused here rather than after reading it, because reading a very large
    // file to then reject it is the same denial of service with extra steps.
    if (!stat || !stat.isFile() || stat.size > limit) {
      files.push({ name: path.basename(filePath), size: stat ? stat.size : 0, tooLarge: true })
      continue
    }
    const bytes = await fs.promises.readFile(filePath)
    files.push({ name: path.basename(filePath), size: stat.size, bytes: [...bytes] })
  }

  return files
})

/** Saves an attachment somewhere the person chooses, under a name that cannot wander. */
ipcMain.handle('app:saveFile', async (evt, request) => {
  const win = BrowserWindow.fromWebContents(evt.sender)
  if (!win || !Array.isArray(request?.bytes)) return false

  const chosen = await dialog.showSaveDialog(win, {
    title: 'Save attachment',
    defaultPath: safeFileName(request.name)
  })
  if (chosen.canceled || !chosen.filePath) return false

  await fs.promises.writeFile(chosen.filePath, Buffer.from(request.bytes))
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
