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
const { app, BrowserWindow, ipcMain, screen, session, Notification, shell } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const skillsUpdate = require('./skills-update.cjs')
const skillsApply = require('./skills-apply.cjs')

const PORT = Number(process.env.DCF_PORT || 18733)
const HOST_PID = Number(process.env.DCF_HOST_PID || 0)
const STATE_FILE = process.env.DCF_STATE_FILE || ''

// ── panel geometry ────────────────────────────────────────────────────────
/**
 * The transparent window is exactly `2 * GUTTER` larger than whatever is drawn:
 * `index.html` puts that padding on `body`, so the CSS `box-shadow` has room to
 * fade out instead of being sliced off by the window edge. The same constant is
 * used by the renderer's `report()`, by the panel's own `min-width/min-height`,
 * and by every clamp below — a window can never end up smaller than the panel,
 * which is what made credit values get cut off mid-digit.
 */
const GUTTER = 4
/** Panel floor: 272px is the width the rows were designed around. */
const PANEL_MIN = { width: 272, height: 200 }
/**
 * Panel ceiling. A generous absolute cap guarded against a flung drag, but the
 * real limit is the current display's work area — a panel taller than the screen
 * cannot be dragged back by its bottom edge, because that edge is never visible.
 */
const PANEL_MAX = { width: 960, height: 1400 }

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

// Windows routes toast notifications through this id; without it a notification
// is silently dropped and the reminder would look like it never fired.
app.setAppUserModelId('com.dsh.credit-float')

app.disableHardwareAcceleration()

let win = null
let lastState = { rows: [], headline: null, updatedAt: 0, expanded: false, fatal: null, consumedRefreshAt: 0, activeProvider: null, activeModel: null }
let collapsed = { width: 150, height: 34 }

/**
 * Size the user dragged the panel to, in outer-window pixels, or `null` for
 * "auto: let the renderer's content measurement decide". Held in the main
 * process rather than the renderer because it has to survive a reload *and* a
 * restart, and because `dcf:resize` (the automatic measurement) is the very
 * message that would otherwise undo it — see the manual-first rule there.
 */
let manualPanel = null

/** Everything we remember between runs; `panel` is null until the user drags. */
const savedState = { x: 0, y: 0, panel: null }

/** Outer-window clamp for a manually sized panel (gutter included). */
function panelBounds(size) {
  const max = panelMaxBounds()
  return {
    width: clamp(Math.round(size.width), PANEL_MIN.width + GUTTER * 2, max.width),
    height: clamp(Math.round(size.height), PANEL_MIN.height + GUTTER * 2, max.height),
  }
}

/**
 * The largest panel that still fits on screen. The absolute ceiling is cut down
 * to the current display's work area, because a window taller than the screen
 * loses its bottom edge off-screen and can then never be grabbed again — and on
 * a 150%-scaled laptop the 1400px ceiling is already off-screen by itself.
 */
function panelMaxBounds() {
  const area = workArea()
  return {
    width: Math.max(PANEL_MIN.width + GUTTER * 2, Math.min(PANEL_MAX.width, area.width - GUTTER * 2)),
    height: Math.max(PANEL_MIN.height + GUTTER * 2, Math.min(PANEL_MAX.height, area.height - GUTTER * 2)),
  }
}

/** Work area of the display the window is currently on (primary until it exists). */
function workArea() {
  if (win === null || win.isDestroyed()) return screen.getPrimaryDisplay().workArea
  return screen.getDisplayMatching(win.getBounds()).workArea
}

/**
 * The size limit that applies to *this* drag.
 *
 * Clamping only against the whole screen is not enough: dragging the south edge
 * downwards grows the window from a fixed top, so the usable height is the space
 * below the top, not the height of the screen — otherwise a panel started near the
 * bottom of the screen could be dragged to a size whose bottom edge is off-screen,
 * and an edge you cannot see is an edge you cannot grab back. The same in the other
 * direction: a north drag that runs out of screen above the top would hide the
 * header, which is the only thing that collapses the panel.
 */
function dragBounds(origin, edges) {
  const area = workArea()
  const max = panelMaxBounds()
  const min = { width: PANEL_MIN.width + GUTTER * 2, height: PANEL_MIN.height + GUTTER * 2 }
  // The edge the pointer is *not* on stays pinned, so that is the anchor to
  // measure the available room from.
  const rightAnchor = edges.w ? origin.x + origin.width : area.x + area.width - GUTTER
  const bottomAnchor = edges.n ? origin.y + origin.height : area.y + area.height - GUTTER
  const topAnchor = edges.n ? area.y + GUTTER : origin.y
  const leftAnchor = edges.w ? area.x + GUTTER : origin.x
  return {
    width: { min: min.width, max: Math.max(min.width, Math.min(max.width, rightAnchor - leftAnchor)) },
    height: { min: min.height, max: Math.max(min.height, Math.min(max.height, bottomAnchor - topAnchor)) },
  }
}

/**
 * The window rect the panel should occupy right now (outer, gutter included).
 *
 * Manual sizes get the full clamp, floors included. An automatic measurement only
 * gets the *width* floor: the window height is derived from the content, so it can
 * never clip anything by itself, and forcing a `PANEL_MIN.height` onto a short
 * panel would add dead transparent space below it — space whose south edge still
 * answers a resize hover, which would look like an invisible handle.
 */
function panelWindowBounds() {
  if (manualPanel !== null) return { ...panelBounds(manualPanel), capped: false }
  const size = autoPanel ?? { width: PANEL_MIN.width, height: PANEL_MIN.height }
  const max = panelMaxBounds()
  const wanted = Math.round(size.height)
  const height = clamp(wanted, GUTTER * 2, max.height)
  // `capped`: the content is taller than any window that fits the screen, so the
  // panel has to scroll. The renderer needs to hear it from us, because a panel with
  // no height of its own would be measured as the window, and the rows below the
  // fold would then be unreachable with no scrollbar to find.
  return {
    width: clamp(Math.round(size.width), PANEL_MIN.width + GUTTER * 2, max.width),
    height,
    capped: height < wanted,
  }
}

/**
 * Last panel size the renderer measured from content. Kept so that clearing a
 * manual size lands on the size the content actually wants, not on a stale one.
 */
let autoPanel = null

/**
 * Tell the renderer how the panel should be sized. `manual` is a size the user
 * dragged (and what the 自适应 button undoes); `capped` means the content does not
 * fit the screen at all. Both make the panel fill the window and scroll, but only
 * `manual` is worth a reset button — a reset cannot beat a screen that is too
 * short, and offering one that visibly does nothing is worse than offering none.
 *
 * Only sent when the answer actually changed: the renderer re-measures when this
 * flips to auto, which reports a size back here, which would otherwise report
 * again and spin a `requestAnimationFrame` loop forever.
 */
let lastSentSizeFlag = null
function sendManualSize() {
  if (win === null || win.isDestroyed()) return
  const bounds = panelWindowBounds()
  const flag = (manualPanel !== null ? 'm' : '-') + (bounds.capped ? 'c' : '-')
  if (flag === lastSentSizeFlag) return
  lastSentSizeFlag = flag
  win.webContents.send('dcf:manual-size', { manual: manualPanel !== null, capped: bounds.capped })
}

/**
 * Apply a drag on the given edges to the window rect.
 *
 * The renderer reports screen-space deltas exactly like the move gesture, so the
 * math is done against the rect captured at pointerdown rather than against the
 * live one: a `setBounds` inside a fast pointermove stream would otherwise be
 * compounded twice (once by us, once by the next delta's stale base).
 *
 * Anchoring: dragging `e`/`s` keeps the origin fixed and moves the far edge;
 * dragging `w`/`n` must move the origin *and* the size, so the opposite edge
 * stays where the pointer is not. When a clamp bites, the origin is corrected by
 * the amount that was lost, which is what keeps the far edge from sliding away
 * under the pointer at the size limits.
 */
function applyResize(origin, edges, dx, dy) {
  if (win === null || win.isDestroyed()) return null
  let width = origin.width
  let height = origin.height
  if (edges.e) width += dx
  if (edges.w) width -= dx
  if (edges.s) height += dy
  if (edges.n) height -= dy
  const limits = dragBounds(origin, edges)
  const clamped = {
    width: clamp(Math.round(width), limits.width.min, limits.width.max),
    height: clamp(Math.round(height), limits.height.min, limits.height.max),
  }
  // A dragged `w`/`n` edge moves the origin; the opposite edge is the anchor, so
  // it is expressed in terms of the *clamped* size and the far edge stays exactly
  // where the pointer never was. A clamp then pulls the origin back with it rather
  // than letting the window drift.
  const x = edges.w ? origin.x + origin.width - clamped.width : origin.x
  const y = edges.n ? origin.y + origin.height - clamped.height : origin.y
  applyWindowBounds({ x, y, width: clamped.width, height: clamped.height })
  return clamped
}

/** Parse the edge flags the renderer sends ('n','e','s','w' booleans). */
function readEdges(value) {
  return {
    n: value?.n === true,
    e: value?.e === true,
    s: value?.s === true,
    w: value?.w === true,
  }
}

function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - 190, y: area.y + 380 }
}

/**
 * Would the capsule actually be reachable at this point?
 *
 * The saved position survives monitor changes, so it can name a display that is
 * no longer attached — the window would then be drawn off-screen and the user
 * sees "no desktop capsule" while the process is perfectly healthy. Any overlap
 * with a display's work area counts: a half-off-screen drag is still usable,
 * while a strictly-inside test would reject it.
 */
function isOnSomeDisplay(x, y) {
  return screen.getAllDisplays().some(display => {
    const area = display.workArea
    return (
      x + collapsed.width > area.x &&
      x < area.x + area.width &&
      y + collapsed.height > area.y &&
      y < area.y + area.height
    )
  })
}

function readPosition() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    // A dragged panel size is restored with the position: the user set it on
    // purpose, and losing it on the next launch is the same as never having
    // been able to resize. Only clamped, never trusted raw — a state file from
    // a bigger monitor or a hand-edit must not produce a 10000px window.
    if (Number.isFinite(raw?.panel?.width) && Number.isFinite(raw?.panel?.height)) {
      savedState.panel = { width: Math.round(raw.panel.width), height: Math.round(raw.panel.height) }
      manualPanel = panelBounds(savedState.panel)
    }
    if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) {
      savedState.x = raw.x
      savedState.y = raw.y
      if (isOnSomeDisplay(raw.x, raw.y)) return { x: raw.x, y: raw.y }
      console.warn('[dcf-desktop] 已保存的窗口位置不在任何显示器的工作区内，回到默认位置')
    }
  } catch {
    /* first run */
  }
  return defaultPosition()
}

function savePosition(x, y) {
  if (!STATE_FILE) return
  savedState.x = Math.round(x)
  savedState.y = Math.round(y)
  saveStateFile()
}

function saveStateFile() {
  if (!STATE_FILE) return
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      x: savedState.x,
      y: savedState.y,
      panel: manualPanel === null ? null : { width: manualPanel.width, height: manualPanel.height },
    }), 'utf8')
  } catch (error) {
    console.warn('[dcf-desktop] 保存窗口状态失败:', error.message)
  }
}

function createWindow() {
  const position = readPosition()
  // Logged so "capsule missing" reports can be told apart from a stale
  // off-screen saved position without attaching a debugger.
  console.log(`[dcf-desktop] 窗口位置: (${position.x}, ${position.y})`)
  win = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: collapsed.width,
    height: collapsed.height,
    frame: false,
    transparent: true,
    // Explicit fully-transparent base colour. On Windows Electron only really
    // composites the window as transparent when the background carries an alpha
    // of 00; with `transparent: true` alone an unset background can still paint
    // the area outside the drawn box as an opaque light-grey band — which is
    // exactly what showed up to the right of the panel whenever the window was
    // a few pixels wider than the panel.
    backgroundColor: '#00000000',
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
  // The window is created at the collapsed size, so this is what we asked for until
  // the first measurement or gesture says otherwise.
  appliedBounds = {
    x: Math.round(position.x),
    y: Math.round(position.y),
    width: collapsed.width,
    height: collapsed.height,
  }
  win.setVisibleOnAllWorkspaces(true)
  win.loadFile(path.join(__dirname, 'index.html'))
  // A size restored from the state file must reach the renderer before its first
  // frame, otherwise the panel measures itself as content-sized for one round trip
  // and the window briefly snaps to the wrong size.
  win.webContents.once('did-finish-load', () => sendManualSize())
  win.once('ready-to-show', () => win.showInactive())
  win.on('moved', () => {
    if (win === null || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    savePosition(x, y)
  })
  win.on('closed', () => {
    win = null
    appliedBounds = null
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
const THEME_POLL_MS = 5_000

let themePreference = 'system'
let themePatchPath = ''
let lastAppliedTheme = null

/** The `preference:` of this file's `- id: ui-theme` entry, or null if absent. */
function readPreferenceFrom(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    // Only the ui-theme block matters; a matching `preference:` under another id
    // must not win, so the search is anchored on the entry id.
    const match = text.match(/- id:\s*ui-theme\b[\s\S]*?\n\s*preference:\s*(light|dark|system)\b/)
    if (match) return match[1]
  } catch {
    /* unreadable: no usable preference here */
  }
  return null
}

/**
 * Find the profile patch that really declares the appearance preference.
 *
 * The path used to be hard-coded to one machine's DSH home, which is wrong on
 * every other install (and quietly made the capsule ignore the DSH setting), so
 * resolve it instead: an explicit override wins, then the real profiles
 * directory is scanned and the first patch carrying a ui-theme preference wins.
 */
function findThemePatch() {
  const explicit = process.env.DCF_THEME_PATCH
  if (explicit) return explicit
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const profiles = path.join(home, 'profiles')
  let entries
  try {
    entries = fs.readdirSync(profiles, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(profiles, entry.name, 'cordis.patch.yml')
    if (readPreferenceFrom(candidate) !== null) return candidate
  }
  return ''
}

function readThemePreference() {
  if (!themePatchPath) themePatchPath = findThemePatch()
  if (!themePatchPath) return 'system'
  const preference = readPreferenceFrom(themePatchPath)
  if (preference === null) {
    // The patch vanished or was rewritten without ui-theme (profile switch,
    // upgrade, deploy in progress): forget the path so the next poll re-scans
    // instead of staying pinned to a file that may never come back.
    themePatchPath = ''
    return 'system'
  }
  return preference
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
  if (req.method === 'GET' && req.url === '/skills') {
    // Read-only view of the skill-update watcher for other local senders
    // (a terminal, a script). Already the path-free public shape.
    return json(res, 200, lastSkillsSnapshot)
  }
  if (req.method === 'POST' && req.url === '/skills-check') {
    void skillsWatcher.check()
    return json(res, 200, { ok: true, checking: true })
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

/**
 * Whether the window is currently showing the panel. Owned by the renderer (the
 * HTTP sender deliberately does not carry it on a data refresh), so it is tracked
 * separately from `lastState.expanded`: that field is only what the page pushed,
 * and a session whose sender never set it would otherwise keep the main process
 * permanently "collapsed" — which is how a panel size used to leak into
 * `collapsed` and stamp the capsule's resting geometry.
 */
let rendererExpanded = false

/**
 * The bounds this process last *asked* Electron for.
 *
 * Windows at a fractional display scale does not give back the size you set: on
 * this machine (150%) `setBounds({height: 536})` makes `getSize()` report 537 —
 * Windows 11 reserves a 1px invisible border on frameless windows. Trusting the
 * window's own report therefore feeds that pixel back in on every operation that
 * re-reads it, and it accumulates: dragging a window grew it ~1px per drag, which
 * is exactly the "拖窗口时窗口自己变大" report.
 *
 * Keeping our own record makes every decision ("is it already this size?", "what
 * size should a move keep?") independent of that rounding. Cleared on close.
 */
let appliedBounds = null

/** The one place `setBounds` is called: applies and records the intended rect. */
function applyWindowBounds(bounds) {
  if (win === null || win.isDestroyed()) return
  win.setBounds(bounds, false)
  appliedBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  }
}

/**
 * Set the outer window size, keeping the origin. Used for automatic measurement
 * only; the drag gesture goes through `applyResize`, which also moves the origin.
 */
function resize(width, height) {
  if (win === null || win.isDestroyed()) return
  const roundedWidth = Math.max(GUTTER * 2, Math.round(width))
  const roundedHeight = Math.max(GUTTER * 2, Math.round(height))
  // Compared against what we asked for, not against `getSize()`: at 150% the
  // latter is off by one pixel, so the renderer's next identical report would look
  // like a change and set the bounds again — a 1px oscillation on every frame.
  if (
    appliedBounds !== null &&
    appliedBounds.width === roundedWidth &&
    appliedBounds.height === roundedHeight
  ) {
    return
  }
  const [x, y] = win.getPosition()
  applyWindowBounds({ x, y, width: roundedWidth, height: roundedHeight })
}

/**
 * The renderer reports the natural size of whatever it currently draws — that is
 * how the capsule stays wrapped to its text as the headline changes.
 *
 * Manual-first rule: once the user has dragged the panel to a size, an automatic
 * measurement must not fight it, otherwise a plain data refresh silently snaps
 * the window back and the drag looks broken. So a report may only move the window
 * when the panel is collapsed (the capsule is always content-sized) or the panel
 * still has no manual size. Clearing it is explicit (`dcf:resize-reset`), never a
 * side effect of a refresh. In manual mode the panel fills the window and scrolls,
 * so its content height says nothing useful about the window size.
 */
ipcMain.on('dcf:resize', (_event, size) => {
  if (!size) return
  const width = Number(size.width)
  const height = Number(size.height)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return
  if (!rendererExpanded) {
    // Only the capsule may claim the resting size; the panel must not overwrite
    // it, or collapsing would shrink the capsule to the panel's dimensions.
    collapsed = { width: Math.max(80, Math.round(width)), height: Math.max(24, Math.round(height)) }
    resize(width, height)
    return
  }
  // Remember what the content wants, so an explicit reset re-fits to it. The
  // *height* is always trustworthy: the renderer reports `scrollHeight`, which does
  // not depend on the box. The width is not — while a manual size is in effect the
  // panel is `width: 100%`, so its box is the window, and storing that would make
  // "自适应" restore the width the user just dragged instead of the content's own
  // 272px. In auto mode the width is always 272 + gutter (the rows ellipsize, never
  // overflow), so keeping the last auto measurement is the honest answer.
  if (manualPanel !== null) {
    autoPanel = { width: autoPanel?.width ?? width, height }
    return
  }
  autoPanel = { width, height }
  const bounds = panelWindowBounds()
  resize(bounds.width, bounds.height)
  // The row list can outgrow the screen as providers are added, which flips
  // `capped` and asks the renderer for the fill-and-scroll state. Without this the
  // panel would keep its content height, the window would clamp it, and the rows
  // below the fold would be clipped with nothing to scroll them.
  sendManualSize()
})

/** Re-fit the panel to its content, dropping the size the user dragged. */
ipcMain.on('dcf:resize-reset', () => {
  manualPanel = null
  savedState.panel = null
  sendManualSize()
  saveStateFile()
  if (autoPanel !== null) {
    const bounds = panelWindowBounds()
    resize(bounds.width, bounds.height)
  }
})

// Resize: same screen-space-delta convention as the move gesture; the renderer
// says which edges are under the pointer and this process owns the geometry.
let resizeOrigin = null
ipcMain.on('dcf:resize-start', () => {
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  const [width, height] = win.getSize()
  resizeOrigin = { x, y, width, height }
  // Adopt the current rect as the manual size *before* the first move, so a data
  // push landing mid-drag cannot answer with an automatic measurement and snap the
  // window out from under the pointer. `dcf:resize` ignores reports while this is
  // set, and the renderer never sends one while it is dragging.
  manualPanel = panelBounds(resizeOrigin)
})
ipcMain.on('dcf:resize-move', (_event, delta) => {
  if (win === null || win.isDestroyed() || resizeOrigin === null) return
  const dx = Number(delta?.dx ?? 0)
  const dy = Number(delta?.dy ?? 0)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  const edges = readEdges(delta?.edges)
  if (!edges.n && !edges.e && !edges.s && !edges.w) return
  manualPanel = applyResize(resizeOrigin, edges, dx, dy)
})
ipcMain.on('dcf:resize-end', () => {
  resizeOrigin = null
  if (win === null || win.isDestroyed() || manualPanel === null) return
  // Persist the size, and the position it moved to: a w/n drag shifts the origin.
  const [x, y] = win.getPosition()
  savedState.x = Math.round(x)
  savedState.y = Math.round(y)
  savedState.panel = { ...manualPanel }
  saveStateFile()
  sendManualSize()
})

// The user may collapse the panel from inside the window.
ipcMain.on('dcf:expanded', (_event, value) => {
  const next = value === true
  if (next === rendererExpanded) return
  rendererExpanded = next
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  if (next) {
    // Re-opening a panel the user sized keeps that size, so nothing snaps on
    // expand; an auto panel is measured by the renderer in its next frame.
    if (manualPanel !== null) {
      const bounds = panelWindowBounds()
      applyWindowBounds({ x, y, width: bounds.width, height: bounds.height })
    }
  } else {
    applyWindowBounds({ x, y, width: collapsed.width, height: collapsed.height })
  }
  sendManualSize()
})

// Dragging: the renderer reports screen-space deltas, this process moves the window.
//
// The size is taken from `appliedBounds` — the rect we last asked for — never from
// `getSize()`. Two Windows behaviours make the window's own report unusable here:
// `setPosition` silently changes the size at a fractional display scale (measured:
// +1px height per move at 150%), and even `setBounds` reports back one pixel taller
// than requested. Re-reading either and re-applying it makes the window creep
// bigger with every drag. Pinning the asked-for size for the whole gesture keeps a
// move a pure translation.
let dragOrigin = null
ipcMain.on('dcf:drag-start', () => {
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  let size = appliedBounds
  if (size === null) {
    const [width, height] = win.getSize()
    size = { width, height }
  }
  dragOrigin = { x, y, width: size.width, height: size.height }
})
ipcMain.on('dcf:drag-move', (_event, delta) => {
  if (win === null || win.isDestroyed() || dragOrigin === null) return
  const dx = Number(delta?.dx ?? 0)
  const dy = Number(delta?.dy ?? 0)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
  applyWindowBounds({
    x: Math.round(dragOrigin.x + dx),
    y: Math.round(dragOrigin.y + dy),
    width: dragOrigin.width,
    height: dragOrigin.height,
  })
})
ipcMain.on('dcf:drag-end', () => {
  dragOrigin = null
  if (win === null || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  savePosition(x, y)
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

// ── skill repository updates ────────────────────────────────────────────────
/**
 * Reminder that the skills folders — git clones whose upstream moved — may be
 * out of date. Which folders those are is configured per machine (see
 * `resolveSkillsDirs` in skills-update.cjs): by default `$DSH_HOME/skills`, plus
 * anything in `DCF_SKILLS_DIRS` or `skills-dirs.json`.
 *
 * This lives in the helper rather than in the DSH page on purpose: the page half
 * only runs while a DSH window is open and its tab is alive, whereas the whole
 * point of the reminder is to be seen when the user is *not* looking at DSH.
 * Detection is read-only (see skills-update.cjs) — the update itself stays the
 * user's call, so this only ever announces.
 */
const SKILLS_POLL_MS = Number(process.env.DCF_SKILLS_POLL_MS) || undefined
/**
 * Where the multi-directory config file lives. Same folder as the window state
 * file when the host gave us one (`DCF_STATE_FILE`), otherwise the plugin folder
 * itself — the helper's own directory, never a hard-coded machine path.
 */
const SKILLS_STATE_DIR = STATE_FILE ? path.dirname(STATE_FILE) : ''
const SKILLS_CONFIG_DIR = STATE_FILE ? path.dirname(STATE_FILE) : path.resolve(__dirname, '..')
const skillsWatcher = skillsUpdate.createSkillsWatcher({
  log: console,
  intervalMs: SKILLS_POLL_MS,
  stateDir: SKILLS_STATE_DIR,
  configDir: SKILLS_CONFIG_DIR,
  emit: snapshot => {
    // The renderer gets the same path-free shape as HTTP: it never needs to know
    // where the skills live, and a devtools console should not leak the layout.
    const payload = publicSkills(snapshot)
    lastSkillsSnapshot = payload
    // The write path needs absolute paths, so the full snapshot is retained here
    // and never crosses a process boundary.
    fullSkillsSnapshot = snapshot
    if (win !== null && !win.isDestroyed()) win.webContents.send('dcf:skills', payload)
    for (const client of sseClients) sseSend(client, 'skills', payload)
  },
  onChange: snapshot => announceSkills(snapshot),
})

console.log(
  `[dcf-desktop] 技能目录 ${skillsWatcher.rootDirs.length} 个: ${skillsWatcher.rootDirs.join(' | ')}` +
    (skillsWatcher.configFile ? `（配置: ${skillsWatcher.configFile}）` : ''),
)

/** Drop absolute paths before anything crosses to the renderer or HTTP. */
function publicSkills(snapshot) {
  const items = snapshot.items ?? []
  const updates = snapshot.updates ?? []
  const attention = snapshot.attention ?? []
  const roots = snapshot.roots ?? []

  /**
   * One row of the panel.
   *
   * `local` is the working-tree half: what is uncommitted and whether the branch
   * is ahead of its remote-tracking ref. Booleans and counts only — no paths, and
   * no remote URLs.
   */
  const publicItem = item => ({
    name: item.name,
    display: item.display || item.name,
    root: item.root ?? null,
    rootIndex: Number.isFinite(item.rootIndex) ? item.rootIndex : null,
    branch: item.branch ?? null,
    state: item.state ?? null,
    reason: item.reason ?? null,
    behind: Number.isFinite(item.behind) ? item.behind : null,
    short: (item.remoteSha ?? '').slice(0, 7),
    local: item.flags
      ? {
          dirty: item.flags.dirty === true,
          modified: item.flags.modified ?? 0,
          untracked: item.flags.untracked ?? 0,
          conflicted: item.flags.conflicted ?? 0,
          ahead: Number.isFinite(item.flags.ahead) ? item.flags.ahead : null,
          unpushed: item.flags.unpushed === true,
          detached: item.flags.detached === true,
        }
      : null,
  })

  return {
    checking: snapshot.checking === true,
    checked: snapshot.checked === true,
    lastCheckedAt: snapshot.lastCheckedAt ?? 0,
    error: snapshot.error ?? null,
    // Configuration problems (a broken skills-dirs.json) are worth saying out
    // loud, but only as basename-level text — paths never cross this line.
    warnings: snapshot.warnings ?? [],
    // Root identity for the panel's grouping: index + display name only. Which
    // folders are watched is file configuration (skills-dirs.json /
    // DCF_SKILLS_DIRS, see README) — the panel only groups what it is told.
    roots: roots.map(root => ({ index: root.index, basename: root.basename })),
    // Remote updates: what 「全部更新」 acts on.
    updates: updates.map(publicItem),
    // Everything worth a row: updates plus repositories with uncommitted or
    // unpushed work. A superset of `updates`, in the order the panel shows.
    attention: attention.map(publicItem),
    counts: {
      total: items.length,
      roots: roots.length,
      updates: updates.length,
      attention: attention.length,
      unpushed: items.filter(i => i.flags?.unpushed === true).length,
      dirty: items.filter(i => i.flags?.dirty === true).length,
      upToDate: items.filter(i => i.state === 'up-to-date').length,
      unreachable: items.filter(i => i.state === 'unreachable').length,
      diverged: items.filter(i => i.state === 'diverged').length,
      unknown: items.filter(i => i.state === 'unknown' || i.state === 'skipped').length,
    },
  }
}

let lastSkillsSnapshot = publicSkills(skillsWatcher.getSnapshot())

/**
 * Tell the user about newly-appeared updatable skills, without nagging.
 *
 * Without persisted state a 6-hourly pass would re-toast the same pending
 * update forever, which is exactly how reminders get ignored — so the set of
 * skills is remembered and only genuinely new information pops a toast (see
 * shouldAnnounce). The in-capsule marker is always live, so nothing is lost
 * between announcements.
 *
 * The remembered set is keyed on the *display* name (`name (root)` when two
 * roots carry the same folder name) — otherwise a repo in one root would
 * silence the identical-named repo in another.
 */
function announceSkills(snapshot) {
  const updates = snapshot?.updates ?? []
  if (updates.length === 0) return

  const stored = skillsUpdate.readState(skillsWatcher)
  if (!skillsUpdate.shouldAnnounce({ stored, snapshot })) return

  skillsUpdate.writeState(skillsWatcher, {
    names: updates.map(skillsUpdate.skillKey).sort().join('|'),
    at: Date.now(),
    updates: updates.map(item => ({
      name: item.name,
      display: skillsUpdate.skillKey(item),
      root: item.root ?? null,
      behind: item.behind ?? null,
      remoteSha: (item.remoteSha ?? '').slice(0, 12),
    })),
  })

  const { title, body } = skillsUpdate.describeAnnouncement(snapshot)
  console.log(`[dcf-desktop] 技能远端更新提醒：${title} — ${body}`)
  showSkillsNotification(title, body, updates.length)
}

/**
 * A Windows toast plus the in-capsule marker.
 *
 * The toast is the part that reaches the user outside DSH; the marker is the
 * fallback for when toasts are suppressed (focus assist, a disabled notification
 * platform) so the reminder is never *only* a toast.
 */
function showSkillsNotification(title, body) {
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body, silent: true })
      // Clicking the toast opens the skills folder: the user updates them with
      // whatever tool they installed them with, so a folder is the honest target.
      // With several roots configured that means the one that actually has the
      // pending update, not whichever happens to be first in the config.
      notification.on('click', () => openSkillsDir(firstUpdateRootIndex()))
      notification.show()
    }
  } catch (error) {
    console.warn('[dcf-desktop] 系统通知不可用:', error?.message ?? error)
  }
}

/**
 * Index into the watcher's roots of the first root that actually has an
 * updatable repo, or null for "no preference" (single root, or nothing pending).
 */
function firstUpdateRootIndex() {
  const indices = (lastSkillsSnapshot?.updates ?? [])
    .map(item => item.rootIndex)
    .filter(index => Number.isFinite(index))
    .sort((a, b) => a - b)
  return indices.length > 0 ? indices[0] : null
}

/**
 * Open one skills root in Explorer.
 *
 * `index` selects the root by its snapshot index — what the renderer's per-group
 * buttons and the toast click know. Anything else (no index, a stale one) falls
 * back to the first root that has a pending update, else the first root: that is
 * the pre-multi-root behaviour, so a single-root install is unchanged. Absolute
 * paths are resolved here — the renderer only ever names a root by index.
 */
function openSkillsDir(index) {
  const dirs = skillsWatcher.rootDirs
  if (dirs.length === 0) {
    console.warn('[dcf-desktop] 未配置任何技能目录')
    return
  }
  const asked = Number(index)
  let pick = Number.isFinite(asked) && asked >= 0 && asked < dirs.length ? asked : 0
  if (!Number.isFinite(asked)) {
    const preferred = firstUpdateRootIndex()
    if (preferred !== null) pick = Math.min(Math.max(preferred, 0), dirs.length - 1)
  }
  const dir = dirs[pick]
  try {
    if (!fs.existsSync(dir)) {
      console.warn(`[dcf-desktop] 技能目录不存在: ${dir}`)
      return
    }
    void shell.openPath(dir)
  } catch (error) {
    console.warn('[dcf-desktop] 打开技能目录失败:', error?.message ?? error)
  }
}

ipcMain.on('dcf:skills-check', () => {
  void skillsWatcher.check()
})
ipcMain.on('dcf:skills-open', (_event, index) => {
  openSkillsDir(index)
})

// ── one-click update of the repositories that are behind ────────────────────
/**
 * The apply half.
 *
 * Detection is read-only and always safe to run unattended; *updating* is not, so
 * it only ever happens because the user clicked. The renderer cannot name a path:
 * it says either "all" or which detector row (by `name` + `rootIndex`), and the
 * absolute path is looked up here out of the watcher's own snapshot. That keeps the
 * "renderer never learns where the skills live" invariant intact even on the write
 * path — the one place where getting it wrong would rewrite the wrong folder.
 *
 * The full snapshot is kept (unlike `publicSkills`) because the updater needs
 * `path`; it never leaves this process.
 */
let fullSkillsSnapshot = skillsWatcher.getSnapshot()
/** Non-null while a batch runs: one update at a time, and the UI can say so. */
let applyingSkills = null

/** The detector rows that are genuinely behind, optionally narrowed. */
function pendingReposFor(request) {
  const items = (fullSkillsSnapshot.items ?? []).filter(item => item.state === 'update')
  if (!request || request.all === true) return items
  const name = typeof request.name === 'string' ? request.name : ''
  if (!name) return []
  const rootIndex = Number.isFinite(Number(request.rootIndex)) ? Number(request.rootIndex) : null
  return items.filter(item => item.name === name && (rootIndex === null || item.rootIndex === rootIndex))
}

function sendSkillsProgress(payload) {
  if (win !== null && !win.isDestroyed()) win.webContents.send('dcf:skills-progress', payload)
}

/**
 * Run the batch, then re-detect so the panel and the badge show the new truth.
 *
 * The re-detect is not cosmetic: after a successful fast-forward the repository is
 * no longer behind, and leaving the old snapshot on screen would invite the user to
 * click the same button again.
 */
async function applySkills(request) {
  if (applyingSkills !== null) {
    return { ok: false, busy: true, error: '正在更新，请稍候' }
  }
  const repos = pendingReposFor(request)
  if (repos.length === 0) {
    return { ok: false, error: '没有待更新的技能仓库（可能已是最新，先点「重查」确认）' }
  }

  applyingSkills = repos.map(item => ({ name: item.display || item.name, phase: 'queued' }))
  sendSkillsProgress({ applying: true, total: repos.length, results: [] })
  console.log(`[dcf-desktop] 开始更新 ${repos.length} 个技能仓库`)

  const results = []
  try {
    const report = await skillsApply.applySkillUpdates({
      repos,
      log: console,
      onProgress: (repo, phase, result) => {
        const slot = applyingSkills?.find(entry => entry.name === (repo?.display || repo?.name))
        if (slot !== undefined) slot.phase = phase
        sendSkillsProgress({
          applying: true,
          total: repos.length,
          inFlight: (repo?.display || repo?.name) ?? null,
          phase,
          result: result
            ? { name: repo?.display || repo?.name, ok: result.ok === true, skipped: result.skipped === true, reason: result.reason ?? null }
            : null,
          results: results.slice(),
        })
      },
    })
    results.push(...(Array.isArray(report) ? report : []))
  } catch (error) {
    // The module is written not to throw; if it somehow does, the UI must still
    // leave its "updating…" state instead of hanging forever.
    console.warn('[dcf-desktop] 技能更新异常:', error?.message ?? error)
    applyingSkills = null
    sendSkillsProgress({ applying: false, total: repos.length, error: String(error?.message ?? error), results })
    return { ok: false, error: String(error?.message ?? error) }
  }

  applyingSkills = null
  const updated = results.filter(item => item.ok === true).length
  const skipped = results.filter(item => item.ok !== true && item.skipped === true).length
  const failed = results.length - updated - skipped
  console.log(`[dcf-desktop] 技能更新完成：成功 ${updated}，跳过 ${skipped}，失败 ${failed}`)

  // Re-detect, then publish the batch outcome on top of the fresh snapshot.
  await skillsWatcher.check()
  sendSkillsProgress({
    applying: false,
    total: repos.length,
    summary: { updated, skipped, failed },
    results: results.map(item => ({
      name: item.display || item.name,
      ok: item.ok === true,
      skipped: item.skipped === true,
      reason: item.reason ?? null,
    })),
  })
  return { ok: true, updated, skipped, failed }
}

ipcMain.on('dcf:skills-apply', (_event, request) => {
  void applySkills(request)
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
  // Logged so a support session can tell "wrong patch file" from "wrong value".
  console.log(`[dcf-desktop] 外观偏好: ${themePreference}（补丁: ${themePatchPath || '未找到，跟随系统'}）`)
  if (win !== null && !win.isDestroyed()) {
    win.webContents.once('did-finish-load', () => applyTheme(true))
  }
  // The renderer mounts after the first pass may already be over, so hand it the
  // current snapshot as soon as it is ready — otherwise the marker stays hidden
  // until the next 6-hourly pass.
  ipcMain.on('dcf:skills-ready', () => {
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send('dcf:skills', lastSkillsSnapshot)
    }
  })
  skillsWatcher.start()
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