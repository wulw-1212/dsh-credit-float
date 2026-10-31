/**
 * Preload bridge for the credit capsule window.
 *
 * The renderer gets a tiny, explicit API — no Node, no remote module.
 */
const { contextBridge, ipcRenderer } = require('electron')

let initialState = null
const listeners = new Set()

ipcRenderer.on('dcf:state', (_event, state) => {
  initialState = state
  for (const listener of listeners) {
    try {
      listener(state)
    } catch (error) {
      console.error('[dcf-desktop] 渲染状态失败:', error)
    }
  }
})

// The DSH Appearance setting (or the OS, when it is `system`) decides the palette.
let initialTheme = null
const themeListeners = new Set()

ipcRenderer.on('dcf:theme', (_event, payload) => {
  initialTheme = payload
  for (const listener of themeListeners) {
    try {
      listener(payload)
    } catch (error) {
      console.error('[dcf-desktop] 应用主题失败:', error)
    }
  }
})

// Skill repository updates: the main process owns the git checks; the renderer
// only displays what it is told and asks for a re-check.
let initialSkills = null
const skillsListeners = new Set()

ipcRenderer.on('dcf:skills', (_event, payload) => {
  initialSkills = payload
  for (const listener of skillsListeners) {
    try {
      listener(payload)
    } catch (error) {
      console.error('[dcf-desktop] 渲染技能更新状态失败:', error)
    }
  }
})

// Whether the panel is showing a size the user dragged, or its natural size.
// The main process owns that answer (it also survives a reload), the renderer
// only asks so its CSS can follow.
let initialManualSize = null
const manualSizeListeners = new Set()

ipcRenderer.on('dcf:manual-size', (_event, payload) => {
  initialManualSize = payload
  for (const listener of manualSizeListeners) {
    try {
      listener(payload)
    } catch (error) {
      console.error('[dcf-desktop] 应用面板尺寸状态失败:', error)
    }
  }
})

// Progress of a running update batch (queued → fetch → merge → done/skipped/failed).
let initialSkillsProgress = null
const skillsProgressListeners = new Set()

ipcRenderer.on('dcf:skills-progress', (_event, payload) => {
  initialSkillsProgress = payload
  for (const listener of skillsProgressListeners) {
    try {
      listener(payload)
    } catch (error) {
      console.error('[dcf-desktop] 渲染技能更新进度失败:', error)
    }
  }
})

contextBridge.exposeInMainWorld('dcfDesktop', {
  get initial() {
    return initialState
  },
  get initialTheme() {
    return initialTheme
  },
  get initialSkills() {
    return initialSkills
  },
  get initialSkillsProgress() {
    return initialSkillsProgress
  },
  onSkillsProgress(listener) {
    if (typeof listener !== 'function') return () => {}
    skillsProgressListeners.add(listener)
    if (initialSkillsProgress !== null) listener(initialSkillsProgress)
    return () => skillsProgressListeners.delete(listener)
  },
  // Apply the pending updates. Deliberately IPC-only: the loopback HTTP server
  // answers any origin, and a page that can rewrite the user's skill folders by
  // sending a POST is not a trade worth making. The renderer may say "all" or name
  // one detector row (name + rootIndex); it never names a path.
  applySkills(request) {
    const safe = request && request.all === true
      ? { all: true }
      : {
          all: false,
          name: typeof request?.name === 'string' ? request.name : '',
          rootIndex: Number.isFinite(Number(request?.rootIndex)) ? Number(request.rootIndex) : null,
        }
    ipcRenderer.send('dcf:skills-apply', safe)
  },
  get initialManualSize() {
    return initialManualSize
  },
  onManualSize(listener) {
    if (typeof listener !== 'function') return () => {}
    manualSizeListeners.add(listener)
    if (initialManualSize !== null) listener(initialManualSize)
    return () => manualSizeListeners.delete(listener)
  },
  onSkills(listener) {
    if (typeof listener !== 'function') return () => {}
    skillsListeners.add(listener)
    if (initialSkills !== null) listener(initialSkills)
    return () => skillsListeners.delete(listener)
  },
  skillsReady() {
    ipcRenderer.send('dcf:skills-ready')
  },
  checkSkills() {
    ipcRenderer.send('dcf:skills-check')
  },
  // Open one skills root in the file manager. `index` is the root's index from
  // the snapshot the renderer was given; omit it to let the main process choose
  // (first root with a pending update).
  openSkillsDir(index) {
    ipcRenderer.send('dcf:skills-open', Number.isFinite(Number(index)) ? Number(index) : undefined)
  },
  // Adding or removing a watched folder is deliberately *not* part of this API:
  // which folders are watched is file configuration (`skills-dirs.json`,
  // `DCF_SKILLS_DIRS`), documented in the README.
  onTheme(listener) {
    if (typeof listener !== 'function') return () => {}
    themeListeners.add(listener)
    if (initialTheme !== null) listener(initialTheme)
    return () => themeListeners.delete(listener)
  },
  onState(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    if (initialState !== null) listener(initialState)
    return () => listeners.delete(listener)
  },
  resize(size) {
    ipcRenderer.send('dcf:resize', size)
  },
  reportExpanded(value) {
    ipcRenderer.send('dcf:expanded', value === true)
  },
  dragStart() {
    ipcRenderer.send('dcf:drag-start')
  },
  dragMove(delta) {
    ipcRenderer.send('dcf:drag-move', delta)
  },
  dragEnd() {
    ipcRenderer.send('dcf:drag-end')
  },
  // Dragging an edge/corner of the expanded panel. Same screen-space convention
  // as the move gesture; `edges` says which of n/e/s/w are under the pointer.
  resizeStart() {
    ipcRenderer.send('dcf:resize-start')
  },
  resizeMove(delta) {
    ipcRenderer.send('dcf:resize-move', delta)
  },
  resizeEnd() {
    ipcRenderer.send('dcf:resize-end')
  },
  // Give up the dragged size and let the panel fit its content again.
  resetPanelSize() {
    ipcRenderer.send('dcf:resize-reset')
  },
  requestRefresh() {
    ipcRenderer.send('dcf:refresh')
  },
  close() {
    ipcRenderer.send('dcf:close')
  },
})
