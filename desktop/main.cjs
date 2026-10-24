/**
 * dsh-credit-float desktop helper — Electron main process.
 *
 * Owns ONE always-on-top transparent frameless window that shows the credit
 * capsule outside the DSH window. The browser half of the plugin POSTs the
 * aggregated numbers here; this process only renders them.
 *
 * Loopback only: the HTTP listener binds 127.0.0.1 and accepts JSON from the
 * DSH page. No credentials ever travel through it — just provider names,
 * totals and the display state that the page already computed.
 */
const { app, BrowserWindow, ipcMain, screen, session } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const PORT = Number(process.env.DCF_PORT || 18733)
const HOST_PID = Number(process.env.DCF_HOST_PID || 0)
const STATE_FILE = process.env.DCF_STATE_FILE || ''

app.disableHardwareAcceleration()

let win = null
let lastState = { rows: [], headline: null, updatedAt: 0, expanded: false, fatal: null, consumedRefreshAt: 0, activeProvider: null, activeModel: null }
let collapsed = { width: 150, height: 34 }

function readPosition() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) return { x: raw.x, y: raw.y }
  } catch {
    /* first run */
  }
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - 190, y: area.y + 380 }
}

function savePosition(x, y) {
  if (!STATE_FILE) return
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ x: Math.round(x), y: Math.round(y) }), 'utf8')
  } catch (error) {
    console.warn('[dcf-desktop] 保存位置失败:', error.message)
  }
}

function resize(width, height) {
  if (win === null || win.isDestroyed()) return
  const [currentWidth, currentHeight] = win.getSize()
  const roundedWidth = Math.max(80, Math.round(width))
  const roundedHeight = Math.max(24, Math.round(height))
  if (currentWidth === roundedWidth && currentHeight === roundedHeight) return
  const [x, y] = win.getPosition()
  win.setBounds({ x, y, width: roundedWidth, height: roundedHeight }, false)
}

function createWindow() {
  const position = readPosition()
  win = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: collapsed.width,
    height: collapsed.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true)
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => win.showInactive())
  win.on('moved', () => {
    if (win === null || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    savePosition(x, y)
  })
  win.on('closed', () => {
    win = null
  })
}

// ── tiny loopback API ───────────────────────────────────────────────────────
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  })
  res.end(payload)
}

/**
 * Server-sent events: the page keeps one of these open so a refresh click
 * arrives instantly instead of waiting for a poll. Browsers do not throttle a
 * stream the way they throttle timers on a background tab, which is why the
 * button used to look dead when the DSH window lost focus.
 */
const sseClients = new Set()

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch {
    sseClients.delete(res)
  }
}

function onRefreshRequested(at) {
  for (const client of sseClients) sseSend(client, 'refresh', { at })
}

// ── appearance ──────────────────────────────────────────────────────────────
/**
 * Which appearance the window should use: `light`, `dark` or `system`.
 *
 * The DSH Appearance setting is the authority. Its preference lives in the
 * profile patch (`ui-theme` config `preference`), which the host can change at
 * runtime, so the value is re-read from the patch file instead of cached once.
 */
const THEME_PATCH = process.env.DCF_THEME_PATCH || 'D:\\Programs Data\\Dsh\\Dsh-home\\profiles\\desktop\\cordis.patch.yml'
const THEME_POLL_MS = 5_000

let themePreference = 'system'
let lastAppliedTheme = null

function readThemePreference() {
  try {
    const text = fs.readFileSync(THEME_PATCH, 'utf8')
    // Only the ui-theme block matters; a matching `preference:` under another id
    // must not win, so the search is anchored on the entry id.
    const match = text.match(/- id:\s*ui-theme\b[\s\S]*?\n\s*preference:\s*(light|dark|system)\b/)
    if (match) return match[1]
  } catch {
    /* patch unreadable: fall back to the OS preference */
  }
  return 'system'
}

function nativeTheme() {
  try {
    return require('electron').nativeTheme
  } catch {
    return undefined
  }
}

function resolvedTheme() {
  const theme = nativeTheme()
  if (themePreference === 'light') return 'light'
  if (themePreference === 'dark') return 'dark'
  // `system`: the OS drives light/dark, which is exactly what nativeTheme reports.
  return theme?.shouldUseDarkColors ? 'dark' : 'light'
}

function applyTheme(force) {
  const next = resolvedTheme()
  if (!force && next === lastAppliedTheme) return
  lastAppliedTheme = next
  if (win === null || win.isDestroyed()) return
  win.webContents.send('dcf:theme', { theme: next, preference: themePreference })
}


const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    })
    res.write(': connected\n\n')
    sseClients.add(res)
    // Heartbeat keeps proxies and idle timeouts from dropping the stream.
    const beat = setInterval(() => sseSend(res, 'ping', { at: Date.now() }), 25_000)
    const drop = () => {
      clearInterval(beat)
      sseClients.delete(res)
    }
    req.on('close', drop)
    req.on('error', drop)
    res.on('error', drop)
    return
  }
  if (req.method === 'GET' && req.url === '/state') {
    // Polling fallback for hosts where the event stream is unavailable: report a
    // pending refresh once, then consume it so one click cannot loop.
    const pending = refreshRequestedAt > 0 && refreshRequestedAt > lastState.consumedRefreshAt
    const askedAt = pending ? refreshRequestedAt : 0
    if (pending) lastState = { ...lastState, consumedRefreshAt: refreshRequestedAt }
    return json(res, 200, { ...lastState, refreshRequestedAt: askedAt })
  }
  if (req.method === 'POST' && req.url === '/refresh') {
    // Same path as the window's button; useful for other local senders too.
    refreshRequestedAt = Date.now()
    onRefreshRequested(refreshRequestedAt)
    return json(res, 200, { ok: true, at: refreshRequestedAt })
  }
  if (req.method === 'POST' && req.url === '/state') {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 256 * 1024) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        // Partial updates are allowed: a toggle may carry only `expanded`.
        const next = { ...lastState }
        if (Array.isArray(body?.rows)) {
          next.rows = body.rows.slice(0, 32).map(row => ({
            id: String(row?.id ?? ''),
            label: String(row?.label ?? ''),
            value: String(row?.value ?? row?.val ?? '—'),
            note: row?.note === null || row?.note === undefined ? null : String(row.note),
            ok: row?.ok === true,
            active: row?.active === true,
          }))
        }
        // Which provider/model the composer is currently using (null when idle).
        if (body?.activeProvider !== undefined) {
          next.activeProvider = body.activeProvider === null ? null : String(body.activeProvider)
        }
        if (body?.activeModel !== undefined) {
          next.activeModel = body.activeModel === null ? null : String(body.activeModel)
        }
        if (body?.headline !== undefined) {
          next.headline = body.headline === null ? null : String(body.headline)
        }
        if (body?.expanded !== undefined) next.expanded = body.expanded === true
        if (body?.fatal !== undefined) {
          next.fatal = body.fatal === null ? null : String(body.fatal)
        }
        if (body?.updatedAt !== undefined) {
          const stamp = Number(body.updatedAt)
          if (Number.isFinite(stamp)) next.updatedAt = stamp
        }
        // A push answers every refresh request raised before it.
        next.consumedRefreshAt = Math.max(next.consumedRefreshAt ?? 0, refreshRequestedAt)
        lastState = next
        // `expanded` is owned by the window, not by the sender: echoing it back
        // would collapse an open panel on every refresh. Only forward it when the
        // sender actually set it.
        const outgoing = { ...lastState }
        if (body?.expanded === undefined) delete outgoing.expanded
        if (win !== null && !win.isDestroyed()) win.webContents.send('dcf:state', outgoing)
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    })
    req.on('error', () => {
      try {
        json(res, 400, { ok: false })
      } catch {
        /* socket already gone */
      }
    })
    return
  }
  json(res, 404, { ok: false })
})

// The renderer reports the natural size of whatever it currently draws.
ipcMain.on('dcf:resize', (_event, size) => {
  if (!size) return
  const width = Number(size.width)
  const height = Number(size.height)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return
  if (!lastState.expanded) {
    collapsed = { width, height }
  }
  resize(width, height)
})

// Dragging: the renderer reports screen-space deltas, this process moves the window.
let dragOrigin = null
ipcMain.on('dcf:drag-start', () => {
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  dragOrigin = { x, y }
})
ipcMain.on('dcf:drag-move', (_event, delta) => {
  if (win === null || win.isDestroyed() || dragOrigin === null) return
  const dx = Number(delta?.dx ?? 0)
  const dy = Number(delta?.dy ?? 0)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  win.setPosition(Math.round(dragOrigin.x + dx), Math.round(dragOrigin.y + dy), false)
})
ipcMain.on('dcf:drag-end', () => {
  dragOrigin = null
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  savePosition(x, y)
})

// The user may collapse the panel from inside the window.
ipcMain.on('dcf:expanded', (_event, value) => {
  lastState = { ...lastState, expanded: value === true }
})

/**
 * The refresh button lives in this window, but the numbers are collected by the
 * DSH page (only it has the channel-pack RPC). So announce the request and let
 * the page push a fresh state — the same channel a periodic refresh uses.
 *
 * `GET /refresh` is the fallback for when nobody is listening: it just answers
 * with the current snapshot so the button still visibly does something.
 */
let refreshRequestedAt = 0
ipcMain.on('dcf:refresh', () => {
  refreshRequestedAt = Date.now()
  onRefreshRequested(refreshRequestedAt)
})

ipcMain.on('dcf:close', () => {
  if (win !== null && !win.isDestroyed()) win.close()
})

// ── lifetime ───────────────────────────────────────────────────────────────
function hostAlive() {
  if (HOST_PID <= 0) return true
  try {
    process.kill(HOST_PID, 0)
    return true
  } catch {
    return false
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(() => false)
  server.on('error', error => {
    if (error?.code === 'EADDRINUSE') {
      // Another helper already owns the port and draws the capsule; a second
      // window here would leave two capsules on the desktop. Quit instead.
      console.warn('[dcf-desktop] 端口已被占用，已有胶囊在显示，本实例退出')
      app.quit()
      return
    }
    console.error('[dcf-desktop] 监听失败:', error.message)
  })
  server.listen(PORT, '127.0.0.1')
  createWindow()

  // Appearance: follow the DSH setting, which itself defaults to `system`.
  themePreference = readThemePreference()
  if (win !== null && !win.isDestroyed()) {
    win.webContents.once('did-finish-load', () => applyTheme(true))
  }
  // The OS theme can change while we run; `nativeTheme` reports it for us.
  nativeTheme()?.on?.('updated', () => applyTheme(false))
  const themeTimer = setInterval(() => {
    const next = readThemePreference()
    if (next !== themePreference) {
      themePreference = next
      applyTheme(true)
    }
  }, THEME_POLL_MS)
  themeTimer.unref?.()

  const timer = setInterval(() => {
    if (!hostAlive()) {
      clearInterval(timer)
      app.quit()
    }
  }, 3000)
  timer.unref?.()
})

app.on('window-all-closed', () => app.quit())
