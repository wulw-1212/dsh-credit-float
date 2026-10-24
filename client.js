/**
 * dsh-credit-float — browser half (desktop only).
 *
 * There is no in-page UI: the numbers are read from the `channel-pack` RPC that
 * `dsh-our-free-model` registers (method `usage.badge`) and pushed to the
 * Electron helper that `index.js` spawns. That helper draws the capsule in an
 * always-on-top transparent window *outside* the DSH window.
 *
 * This half therefore renders nothing; it only keeps the push loop alive for as
 * long as the shell keeps the plugin loaded.
 *
 * No build step: hand-written ModuleLoader bundle, React comes from the shell.
 */
;(() => {
  const NS = 'dsh-credit-float'

  /**
   * The free channels `dsh-our-free-model` serves, one row per channel.
   *
   * This mirrors that plugin's own channel roster (`CHANNEL_PROVIDERS` in its
   * `client.js`). It is only a starting point: the roster drifts when Our Free
   * Model drops or adds a channel, and a stale id here used to leave a dead row
   * reading "不支持此渠道" in the capsule. `collect()` therefore demotes any
   * provider the pack reports as unsupported (`state: 'unsupported'`), and
   * `buildPayload()` drops such rows entirely — the capsule shows exactly the
   * channels the pack actually serves, and the active-model badge disappears
   * with a channel that is not one of them.
   */
  const PROVIDERS = [
    { id: 'lobsterai', label: 'LobsterAI', unit: 'credit' },
    { id: 'qoder', label: 'Qoder', unit: 'credit' },
    { id: 'qodercn', label: 'Qoder CN', unit: 'credit' },
    { id: 'trae', label: 'Trae', unit: 'credit' },
    { id: 'cline', label: 'Cline', unit: 'usd' },
    { id: 'loomy', label: 'Loomy', unit: 'credit' },
    { id: 'raccoon', label: 'Raccoon', unit: 'credit' },
    { id: 'minimax', label: 'MiniMax', unit: 'credit' },
    { id: 'zcode', label: 'ZCode', unit: 'token' },
    { id: 'gemini', label: 'Gemini', unit: 'quota' },
  ]

  const UNIT_OF = Object.fromEntries(PROVIDERS.map(p => [p.id, p.unit]))

  const REFRESH_MS = 60_000
  const RPC_TIMEOUT_MS = 20_000
  const DEFAULT_DESKTOP_PORT = 18733
  /** Retry cadence while the helper has not answered yet (host still booting). */
  const RETRY_MS = 5_000

  function formatNumber(value) {
    const abs = Math.abs(value)
    if (abs >= 10000) return Math.round(value).toLocaleString('zh-CN')
    if (Number.isInteger(value)) return String(value)
    return value.toFixed(2).replace(/\.?0+$/, '')
  }

  function formatBalance(sum, unit) {
    if (sum === null || sum === undefined) return '—'
    if (unit === 'usd') return '$' + sum.toFixed(2)
    if (unit === 'token') return formatNumber(sum) + ' tok'
    return formatNumber(sum)
  }

  function makeFactory() {
    return function factory(require) {
      const module = { exports: {} }
      const exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      const name = NS
      // `slots` is intentionally not injected: this half contributes no UI.
      const inject = ['connection', 'modelDirectories', 'sessions']

      function apply(ctx) {
        let disposed = false
        let timer

        const readTransport = () => {
          let connection
          try {
            connection = ctx?.connection
          } catch {
            connection = undefined
          }
          if (connection === undefined || connection === null) {
            try {
              connection = ctx?.get?.('connection')
            } catch {
              connection = undefined
            }
          }
          try {
            const call = connection?.rpc?.call
            return typeof call === 'function' ? { connection, call } : null
          } catch {
            return null
          }
        }

        /**
         * The session the main view is showing.
         *
         * There is no "current session" getter, so it is located the way the shell
         * itself does it: the entry retained by `mainView` in the session list.
         */
        const currentSessionId = () => {
          const sessions = ctx?.sessions
          if (!sessions) return null
          try {
            if (typeof sessions.currentSessionId === 'function') {
              const direct = sessions.currentSessionId()
              if (typeof direct === 'string' && direct.length > 0) return direct
            }
            const list = sessions.list?.getSnapshot?.()
            if (!list) return null
            if (typeof list.current === 'string' && list.current.length > 0) return list.current
            const byId = list.byId
            if (!byId || typeof byId !== 'object') return null
            // The main view retains exactly one session; take the strongest claim
            // so a mostly-closed session does not win over the one on screen.
            let best = null
            let bestScore = 0
            for (const [id, entry] of Object.entries(byId)) {
              const score = Number(entry?.retainedBy?.mainView ?? 0)
              if (Number.isFinite(score) && score > bestScore) {
                best = id
                bestScore = score
              }
            }
            return best
          } catch {
            return null
          }
        }

        /**
         * The provider/model currently selected in the composer.
         *
         * `modelDirectories.directoryFor(sessionId).store` is the same snapshot the
         * model picker renders from, so this needs no extra RPC. Sessions may be
         * blank or addressed to a subagent, in which case there is nothing to show.
         */
        const currentSelection = () => {
          const models = ctx?.modelDirectories
          const sessions = ctx?.sessions
          if (!models || !sessions) return null
          try {
            const id = currentSessionId()
            if (typeof id !== 'string' || id.length === 0) return null
            if (typeof sessions.subagentAddress === 'function' && sessions.subagentAddress(id) !== undefined) return null
            const snapshot = models.directoryFor(id)?.store?.getSnapshot?.()
            const current = snapshot?.current
            if (!current || typeof current.provider !== 'string') return null
            return { provider: current.provider, model: String(current.model ?? '') }
          } catch {
            // A session without a binding (brand-new composer, teardown race) is
            // not an error worth surfacing.
            return null
          }
        }

        const resolvePort = () => {
          try {
            const service = ctx?.creditFloatDesktop
            const port = Number(service?.port)
            if (Number.isFinite(port) && port > 0) return port
          } catch {
            /* service not published: fall back to the well-known port */
          }
          return DEFAULT_DESKTOP_PORT
        }

        const rpc = async (method, payload) => {
          const transport = readTransport()
          if (transport === null) throw new Error('no-connection')
          const controller = new AbortController()
          const abort = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
          try {
            const result = await transport.call.call(
              transport.connection.rpc,
              '/api',
              'channel-pack',
              { method, payload },
              controller.signal,
            )
            if (result?.ok === true) return result.value
            if (result?.ok === false) {
              throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
            }
            return result
          } finally {
            clearTimeout(abort)
          }
        }

        const push = async payload => {
          const port = resolvePort()
          const response = await fetch(`http://127.0.0.1:${port}/state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            cache: 'no-store',
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
        }

        /** Read the helper's snapshot; also reports a pending manual refresh. */
        const readDesktopState = async () => {
          const port = resolvePort()
          const response = await fetch(`http://127.0.0.1:${port}/state`, {
            cache: 'no-store',
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        }

        /**
         * Providers the pack answered "不支持此渠道" for, remembered between
         * rounds so the selection watcher also knows to hide their badge.
         */
        const unsupported = new Set()

        const collect = async () => {
          const next = {}
          let reachable = false
          // The model can change without a single balance moving, and the periodic
          // watcher is throttled while the page is in the background. A refresh
          // therefore re-reads the composer's selection up front and publishes it
          // before the slow RPC round, so the marker follows the refresh instead
          // of waiting for the next watcher tick.
          await syncSelection()

          // Sequential: channel-pack queries upstream once per account, and firing
          // 13 providers at the same time is exactly what trips rate limits.
          for (const provider of PROVIDERS) {
            if (disposed) return
            try {
              const value = await rpc('usage.badge', { provider: provider.id })
              reachable = true
              unsupported.delete(provider.id)
              const accounts = Array.isArray(value?.accounts) ? value.accounts : []
              if (accounts.length === 0) {
                next[provider.id] = { state: 'empty' }
                continue
              }
              let sum = 0
              let counted = 0
              let failure = null
              for (const row of accounts) {
                // channel-pack reports `balance` as `{ total, packages, expiredTotal }`
                // for most providers, but a few hand back a bare number.
                const raw = row?.balance
                const balance = typeof raw === 'number' ? raw : Number(raw?.total)
                if (!Number.isFinite(balance)) {
                  if (row?.error) failure = row.error
                  continue
                }
                sum += balance
                counted += 1
              }
              next[provider.id] = counted === 0
                ? { state: 'error', error: failure ?? '未返回余额' }
                : { state: 'ok', sum, counted, total: accounts.length, error: failure }
            } catch (error) {
              const message = String(error?.message ?? error)
              // The pack answers "不支持此渠道。" / "unsupported provider: x" for
              // an id it no longer serves. That is not an error row — it means the
              // channel is gone, so remember it as unsupported and hide the row
              // instead of showing a dead "—" forever (and hiding its badge too).
              if (/不支持此渠道|unsupported provider/i.test(message)) {
                unsupported.add(provider.id)
                next[provider.id] = { state: 'unsupported' }
                continue
              }
              unsupported.delete(provider.id)
              next[provider.id] = { state: 'error', error: message === 'no-connection' ? '未连接' : message }
            }
          }
          if (disposed) return

          const fatal = reachable ? null : 'channel-pack 不可达：dsh-our-free-model 未加载，或连接通道未就绪'
          const selection = currentSelection()
          lastSelectionKey = selectionKeyOf(selection)
          lastPushed = next
          lastUpdatedAt = Date.now()
          await push(buildPayload(next, selection, fatal, lastUpdatedAt))
        }

        let lastRefreshAsked = 0
        let refreshing = false
        let stream = null
        let pollTimer = null
        /** Last collected numbers, reused by the selection watcher. */
        let lastPushed = null
        /** When those numbers were collected, reused by marker-only pushes. */
        let lastUpdatedAt = 0
        let lastSelectionKey = ''

        const selectionKeyOf = selection => (selection ? `${selection.provider}/${selection.model}` : '')

        /**
         * Publish a changed model marker right away, without touching the numbers.
         *
         * Only the active row and the badge change, so the previous balances are
         * reused and the panel does not flash empty while credits are re-read.
         */
        const syncSelection = async () => {
          if (disposed) return
          const selection = currentSelection()
          const key = selectionKeyOf(selection)
          if (key === lastSelectionKey) return
          lastSelectionKey = key
          if (lastPushed === null) return
          try {
            await push(buildPayload(lastPushed, selection, undefined, lastUpdatedAt))
          } catch {
            /* helper not up yet: the collection round will retry on its own */
          }
        }

        /** Shape the wire payload the desktop window consumes. */
        const buildPayload = (next, selection, fatal, at) => {
          // Channels the pack no longer serves are not dead rows to display — they
          // leave the capsule entirely, so the headline, the list, and the active
          // badge all agree with what Our Free Model actually offers.
          const visible = PROVIDERS.filter(provider => next[provider.id]?.state !== 'unsupported')
          
          // Calculate total for fallback when no active provider
          const creditSumAll = visible.reduce((sum, provider) => {
            const row = next[provider.id]
            return provider.unit === 'credit' && row?.state === 'ok' ? sum + row.sum : sum
          }, 0)
          
          // Show only the currently active provider's balance in the headline
          const activeProviderId = selection?.provider
          let headlineCredit = null
          if (activeProviderId && next[activeProviderId]?.state === 'ok') {
            const activeUnit = UNIT_OF[activeProviderId]
            if (activeUnit === 'credit') {
              headlineCredit = next[activeProviderId].sum
            } else if (activeUnit === 'usd') {
              headlineCredit = '$' + next[activeProviderId].sum.toFixed(2)
            } else if (activeUnit === 'token') {
              headlineCredit = formatNumber(next[activeProviderId].sum) + ' tok'
            } else if (activeUnit === 'quota') {
              headlineCredit = next[activeProviderId].sum
            }
          }
          
          const okCount = visible.map(p => next[p.id]).filter(row => row?.state === 'ok').length
          return {
            headline: headlineCredit === null 
              ? (okCount === 0 ? '积分' : formatNumber(creditSumAll) + ' 积分')
              : String(headlineCredit),
            // The desktop window owns its own expanded state; omitting the field
            // keeps an open panel open across refreshes.
            fatal,
            updatedAt: Number.isFinite(at) ? at : Date.now(),
            // Which provider the composer currently uses, so the window can mark
            // it. A provider the pack dropped has no row to mark: publish a null
            // marker so the capsule badge disappears with it.
            activeProvider: selection && visible.some(p => p.id === selection.provider) ? selection.provider : null,
            activeModel: selection && visible.some(p => p.id === selection.provider) ? selection.model : null,
            rows: visible.map(provider => {
              const row = next[provider.id]
              const unit = UNIT_OF[provider.id] ?? 'credit'
              const active = selection?.provider === provider.id
              if (row?.state === 'ok') {
                return {
                  id: provider.id,
                  label: provider.label,
                  value: formatBalance(row.sum, unit),
                  ok: true,
                  active,
                  note: row.total > row.counted ? `${row.counted}/${row.total} 个账号` : null,
                }
              }
              return {
                id: provider.id,
                label: provider.label,
                value: '—',
                ok: false,
                active,
                note: row?.state === 'error' ? row.error : row?.state === 'empty' ? '未登录' : null,
              }
            }),
          }
        }

        const tick = async () => {
          if (disposed) return
          try {
            await collect()
            clearTimeout(timer)
            if (!disposed) timer = setTimeout(tick, REFRESH_MS)
          } catch {
            // The helper is not there yet (host still booting, or it crashed and
            // is being restarted) — keep trying without spamming credentials.
            clearTimeout(timer)
            if (!disposed) timer = setTimeout(tick, RETRY_MS)
          }
        }

        const runRefresh = async at => {
          const stamp = Number(at)
          if (Number.isFinite(stamp) && stamp > 0) {
            if (stamp <= lastRefreshAsked) return
            lastRefreshAsked = stamp
          }
          // A click must move the model marker even when a periodic round is
          // already in flight and the numbers are therefore skipped.
          await syncSelection()
          if (refreshing || disposed) return
          refreshing = true
          clearTimeout(timer)
          try {
            await tick()
          } finally {
            refreshing = false
          }
        }

        /**
         * Refresh clicks arrive over a server-sent event stream: browsers keep
         * that open even when the tab is in the background, unlike the timers a
         * poll would rely on. If the stream cannot connect, fall back to polling.
         */
        const openStream = () => {
          if (disposed) return
          const port = resolvePort()
          let source
          try {
            source = new EventSource(`http://127.0.0.1:${port}/events`)
          } catch {
            startPolling()
            return
          }
          stream = source
          source.addEventListener('refresh', event => {
            let at = 0
            try {
              at = JSON.parse(event.data)?.at
            } catch {
              at = 0
            }
            void runRefresh(at)
          })
          source.addEventListener('error', () => {
            // EventSource reconnects on its own; only fall back if it gave up.
            if (source.readyState === 2 /* CLOSED */ && !disposed && pollTimer === null) {
              startPolling()
            }
          })
        }

        const startPolling = () => {
          if (disposed || pollTimer !== null) return
          pollTimer = setInterval(async () => {
            if (disposed || refreshing) return
            try {
              const state = await readDesktopState()
              const askedAt = Number(state?.refreshRequestedAt)
              if (Number.isFinite(askedAt) && askedAt > lastRefreshAsked) {
                lastRefreshAsked = askedAt
                await runRefresh(askedAt)
              }
            } catch {
              /* helper not up yet */
            }
          }, 1500)
        }

        const start = () => {
          if (disposed) return
          void tick()
          openStream()
        }

        /**
         * The active model can change without any credit moving (the user just
         * picks another model), and a page reload restarts this half from scratch.
         * A light watcher keeps the marker honest in both cases without touching
         * the network — the same path a refresh takes, so both agree on when the
         * marker moved.
         */
        const watchSelection = () => {
          if (disposed) return
          void syncSelection()
        }

        // Give the helper a moment to bind its port before the first push.
        timer = setTimeout(start, 3000)
        const selectionTimer = setInterval(watchSelection, 2000)
        ctx.effect?.(() => () => {
          disposed = true
          clearTimeout(timer)
          clearInterval(selectionTimer)
          try {
            stream?.close()
          } catch {
            /* already closed */
          }
          if (pollTimer !== null) clearInterval(pollTimer)
        }, 'dsh-credit-float: push loop')
      }

      exports.apply = apply
      exports.inject = inject
      exports.name = name
      return module.exports
    }
  }

  window.__ModuleLoader__.load({
    id: NS,
    factory: makeFactory(),
  })
})()
