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
  const electron = resolveElectron()
  const port = Number(process.env.DCF_PORT || DEFAULT_PORT)
  const stateFile = join(dirname(here), '.dsh-credit-float-window.json')

  // Publish the endpoint so the browser half can find it without duplicating
  // the port in two places.
  try {
    ctx.provide?.('creditFloatDesktop', { port, available: electron !== undefined })
  } catch {
    /* older hosts: no service slot, the client falls back to the default port */
  }

  if (electron === undefined) {
    ctx.logger?.warn?.(
      'dsh-credit-float: 未找到 Electron（$DSH_HOME/electron），桌面积分胶囊不可用；页面内胶囊照常工作。',
    )
    return
  }

  let child
  let stopping = false
  let restarts = 0

  const launch = () => {
    if (stopping) return
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

    child = spawn(electron, [HELPER_MAIN], {
      cwd: HELPER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    child.stdout?.on?.('data', chunk => {
      const text = String(chunk).trim()
      if (text) ctx.logger?.debug?.(`[dcf-desktop] ${text}`)
    })
    child.stderr?.on?.('data', chunk => {
      const text = String(chunk).trim()
      if (text) ctx.logger?.warn?.(`[dcf-desktop] ${text}`)
    })
    child.on('error', error => {
      ctx.logger?.warn?.(`dsh-credit-float: 桌面胶囊启动失败：${error.message}`)
    })
    child.on('exit', code => {
      child = undefined
      if (stopping) return
      if (restarts >= 3) {
        ctx.logger?.warn?.('dsh-credit-float: 桌面胶囊连续退出，已停止重启')
        return
      }
      restarts += 1
      setTimeout(launch, 1500 * restarts).unref?.()
      ctx.logger?.debug?.(`dsh-credit-float: 桌面胶囊退出（code=${String(code)}），准备重启`)
    })

    ctx.logger?.info?.(`dsh-credit-float: 桌面胶囊已启动（127.0.0.1:${port}）`)
  }

  ctx.effect(() => {
    launch()
    return () => {
      stopping = true
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

