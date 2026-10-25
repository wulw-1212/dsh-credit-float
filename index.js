/**
 * dsh-credit-float — host half.
 *
 * Responsibilities:
 *   1. spawn the tiny Electron helper that owns the always-on-top transparent
 *      window (the capsule lives on the desktop, not inside the DSH window);
 *   2. keep that helper's lifetime tied to this host process;
 *   3. publish the helper's port so the browser half knows where to push state.
 *
 * The credits themselves are still read through `dsh-our-free-model`'s
 * `channel-pack` RPC by the browser half — this file never touches credentials.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-credit-float'
export const inject = ['connection']

const HELPER_DIR = resolve(here, 'desktop')
const HELPER_MAIN = join(HELPER_DIR, 'main.cjs')
const DEFAULT_PORT = 18733
// Electron can appear *after* this host booted (first-run download, or the user
// installing it while DSH is open), so a missing binary is retried instead of
// ending the plugin for the lifetime of the process.
const DEFAULT_RESOLVE_RETRY_MS = 5000

/** Resolve the Electron binary the same way dsh-pet does: $DSH_HOME/electron. */
function resolveElectron() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const candidates = [
    process.env.DCF_ELECTRON_PATH,
    process.env.DSH_PET_ELECTRON_PATH,
    join(home, 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* unreadable candidate: try the next one */
    }
  }
  try {
    const resolved = require('electron')
    if (typeof resolved === 'string' && existsSync(resolved)) return resolved
  } catch {
    /* electron is not a regular dependency here */
  }
  return undefined
}

export function apply(ctx) {
  const port = Number(process.env.DCF_PORT || DEFAULT_PORT)
  // Kept inside this package folder so the saved position travels with the
  // project instead of landing in whatever directory happens to contain it.
  const stateFile = join(here, '.dsh-credit-float-window.json')
  const retrySetting = Number(process.env.DCF_RESOLVE_RETRY_MS)
  const resolveRetryMs = Number.isFinite(retrySetting) && retrySetting > 0 ? retrySetting : DEFAULT_RESOLVE_RETRY_MS

  let child
  let stopping = false
  let restarts = 0
  let resolveTimer
  let warnedMissingElectron = false

  // One stable object, published immediately so the browser half can find the
  // endpoint without duplicating the port in two places. `available` is mutated
  // as the helper comes and goes: a late Electron install must become visible
  // here too instead of being frozen at apply() time.
  const service = { port, available: false }
  try {
    ctx.provide?.('creditFloatDesktop', service)
  } catch {
    /* older hosts: no service slot, the client falls back to the default port */
  }

  const warnMissingElectron = () => {
    if (warnedMissingElectron) return
    warnedMissingElectron = true
    ctx.logger?.warn?.(
      `dsh-credit-float: 未找到 Electron（$DSH_HOME/electron），桌面积分胶囊暂不可用；每 ${resolveRetryMs} ms 重试，页面内胶囊照常工作。`,
    )
  }

  /** Re-arm the resolution attempt; never re-armed once the effect disposes. */
  const retryResolve = () => {
    if (stopping || resolveTimer !== undefined) return
    resolveTimer = setTimeout(() => {
      resolveTimer = undefined
      launch()
    }, resolveRetryMs)
    // Polling for a binary must never keep the host process alive on its own.
    resolveTimer.unref?.()
  }

  const scheduleRestart = reason => {
    if (stopping) return
    if (restarts >= 3) {
      ctx.logger?.warn?.('dsh-credit-float: 桌面胶囊连续退出，已停止重启')
      return
    }
    restarts += 1
    const delay = 1500 * restarts
    setTimeout(launch, delay).unref?.()
    ctx.logger?.debug?.(`dsh-credit-float: 桌面胶囊退出（${reason}），${delay} ms 后重启`)
  }

  const launch = () => {
    if (stopping) return
    // A resolve tick can race a pending restart timer: one helper at a time.
    if (child !== undefined) return

    const electron = resolveElectron()
    if (electron === undefined) {
      warnMissingElectron()
      retryResolve()
      return
    }

    try {
      mkdirSync(dirname(stateFile), { recursive: true })
    } catch {
      /* the state file is optional */
    }
    const env = {
      ...process.env,
      DCF_PORT: String(port),
      DCF_HOST_PID: String(process.pid),
      DCF_STATE_FILE: stateFile,
    }
    // The helper must run as a real Electron app, not as bare Node.
    delete env.ELECTRON_RUN_AS_NODE

    const proc = spawn(electron, [HELPER_MAIN], {
      cwd: HELPER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child = proc

    proc.stdout?.on?.('data', chunk => {
      const text = String(chunk).trim()
      if (text) ctx.logger?.debug?.(`[dcf-desktop] ${text}`)
    })
    proc.stderr?.on?.('data', chunk => {
      const text = String(chunk).trim()
      if (text) ctx.logger?.warn?.(`[dcf-desktop] ${text}`)
    })

    let settled = false
    const onGone = reason => {
      if (settled) return
      settled = true
      if (child === proc) child = undefined
      service.available = false
      scheduleRestart(reason)
    }

    proc.on('error', error => {
      ctx.logger?.warn?.(`dsh-credit-float: 桌面胶囊启动失败：${error.message}`)
      // A spawn failure (ENOENT) emits `error` and never `exit`; clear the slot
      // so the restart path re-resolves Electron from scratch.
      if (proc.pid === undefined) onGone(`error=${String(error.code ?? error.message)}`)
    })
    proc.on('exit', code => onGone(`code=${String(code)}`))

    proc.once('spawn', () => {
      service.available = true
      ctx.logger?.info?.(`dsh-credit-float: 桌面胶囊已启动（127.0.0.1:${port}）`)
    })
  }

  ctx.effect(() => {
    launch()
    return () => {
      stopping = true
      if (resolveTimer !== undefined) {
        clearTimeout(resolveTimer)
        resolveTimer = undefined
      }
      service.available = false
      if (child !== undefined) {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
    }
  }, 'dsh-credit-float: desktop capsule')
}

export default { name, inject, apply }

