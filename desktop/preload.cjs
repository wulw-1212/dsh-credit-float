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

contextBridge.exposeInMainWorld('dcfDesktop', {
  get initial() {
    return initialState
  },
  get initialTheme() {
    return initialTheme
  },
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
  requestRefresh() {
    ipcRenderer.send('dcf:refresh')
  },
  close() {
    ipcRenderer.send('dcf:close')
  },
})
