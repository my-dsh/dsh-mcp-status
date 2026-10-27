window.__ModuleLoader__.load({
  id: '@my-dsh/dsh-mcp-status',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    /** Locale namespace owned by this plugin; the slot registration supplies `t`. */
    const NS = 'mcpStatus'

    /** Document-relative authenticated routes registered by the Host half. */
    const LIST_ROUTE = 'api/mcp-status.list'
    const SET_ROUTE = 'api/mcp-status.set'

    /** Chinese copy; keys are the one vocabulary the component reads. */
    const zh = {
      'trigger.loading': 'MCP',
      'trigger.none': 'MCP 未配置',
      'trigger.summary': 'MCP {on}/{total} 已连接',
      'trigger.aria': 'MCP 连接：{on}/{total} 已连接，点击查看',
      'panel.title': 'MCP 连接',
      'panel.subtitle': '按工作区记录，重启后恢复',
      'panel.close': '关闭',
      'panel.refresh': '刷新',
      'panel.refreshing': '刷新中…',
      'panel.empty': '本机还没有配置任何 MCP 服务器。',
      'panel.loading': '读取中…',
      'panel.error': '读取失败，请重试。',
      'state.on': '已连接',
      'state.off': '未连接',
      'group.on': '已连接',
      'group.off': '未连接',
      'state.pending': '连接中',
      'state.loading': '启动中',
      'state.failed': '连接失败',
      'state.unloading': '断开中',
      'toggle.on': '断开 {name}',
      'toggle.off': '连接 {name}',
      'tools.count': '{count} 个工具',
      'tools.none': '无工具',
      'failure.failed': '切换失败：{reason}',
      'failure.connectFailed': '连接失败：{reason}',
      'failure.restartRequired': '改动已保存，重启 DSH 后生效。',
      'reason.management-required': '该条目属于插件管理自身，不能切换。',
      'reason.unaddressable': '配置无法唯一定位该条目。',
      'reason.unknown-plugin': '没有这个插件条目。',
      'reason.operation-error': 'Host 报告了错误。',
      'reason.connect-failed': '服务器没有连上。',
      'reason.invalid-body': '请求无效。',
      'reason.invalid-json': '请求无效。',
      'reason.invalid-entry': '条目无效。',
      'state.restoring': '恢复中',
    }

    /** English copy, key-for-key with {@link zh}. */
    const en = {
      'trigger.loading': 'MCP',
      'trigger.none': 'MCP not configured',
      'trigger.summary': 'MCP {on}/{total} connected',
      'trigger.aria': 'MCP connections: {on}/{total} connected. Open the panel',
      'panel.title': 'MCP connections',
      'panel.subtitle': 'Recorded per workspace, restored on restart',
      'panel.close': 'Close',
      'panel.refresh': 'Refresh',
      'panel.refreshing': 'Refreshing…',
      'panel.empty': 'No MCP server is configured on this machine yet.',
      'panel.loading': 'Reading…',
      'panel.error': 'Could not read the connections. Try again.',
      'state.on': 'Connected',
      'state.off': 'Disconnected',
      'group.on': 'Connected',
      'group.off': 'Not connected',
      'state.pending': 'Connecting',
      'state.loading': 'Starting',
      'state.failed': 'Failed',
      'state.unloading': 'Disconnecting',
      'toggle.on': 'Disconnect {name}',
      'toggle.off': 'Connect {name}',
      'tools.count': '{count} tools',
      'tools.none': 'No tools',
      'failure.failed': 'Could not switch: {reason}',
      'failure.connectFailed': 'Could not connect: {reason}',
      'failure.restartRequired': 'Saved; restart DSH to apply it.',
      'reason.management-required': 'This row belongs to plugin management itself.',
      'reason.unaddressable': 'The profile configuration cannot address this row.',
      'reason.unknown-plugin': 'No such plugin row.',
      'reason.operation-error': 'The Host reported an error.',
      'reason.connect-failed': 'The server did not connect.',
      'reason.invalid-body': 'The request was invalid.',
      'reason.invalid-json': 'The request was invalid.',
      'reason.invalid-entry': 'The row is invalid.',
      'state.restoring': 'Restoring',
    }

    /** Panel styles, rendered as an element so unmounting removes them. */
    const CSS = `
.dshmcp-root { display: inline-flex; flex: none; }
/* Sits in the same .tools flex row as the "+" button and the permission chip,
   so it copies that chip's height, radius, and text metrics exactly: the three
   then read as one group of controls rather than three unrelated widgets. */
.dshmcp-trigger {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  height: 28px; padding: 0 8px; border: none;
  border-radius: var(--dsw-radius-sm);
  outline: none; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 13px; line-height: 20px; font-weight: 500;
  font-variant-numeric: tabular-nums;
  white-space: nowrap; cursor: pointer;
}
@media (hover: hover) {
  .dshmcp-trigger:hover, .dshmcp-trigger[aria-expanded='true'] {
    background: var(--dsw-alias-interactive-bg-hover);
  }
}
.dshmcp-trigger:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dshmcp-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-dimmed); }
.dshmcp-dot[data-live='true'] { background: var(--dsw-alias-state-success-primary); }
.dshmcp-dot[data-bad='true'] { background: var(--dsw-alias-state-error-primary); }

/* ---- the popover ---- */
.dshmcp-panel {
  position: fixed; z-index: 1100; box-sizing: border-box;
  width: min(320px, calc(100vw - 24px));
  padding: 13px 0 6px;
  border: 0; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 13px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}

/* ---- head ---- */
.dshmcp-head { display: flex; align-items: center; gap: 8px; padding: 0 14px 11px; }
.dshmcp-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); letter-spacing: -.005em; }
.dshmcp-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.dshmcp-ghost {
  border: none; background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 11px; padding: 3px 7px;
  border-radius: var(--dsw-radius-sm); cursor: pointer;
}
.dshmcp-ghost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }

/* ---- a group: 10px caps label, hairline running out to the right ---- */
.dshmcp-group { padding: 0 6px; }
.dshmcp-group + .dshmcp-group { margin-top: 4px; }
.dshmcp-glabel {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 8px 5px;
  font-size: 10px; font-weight: 600; letter-spacing: .08em;
  text-transform: uppercase; color: var(--dsw-alias-label-secondary);
}
.dshmcp-glabel > span { flex: none; }
.dshmcp-glabel > em {
  flex: none; font-style: normal;
  font-variant-numeric: tabular-nums; letter-spacing: .02em;
  color: var(--dsw-alias-label-secondary);
}
.dshmcp-glabel::after {
  content: ''; flex: 1; height: 1px; min-width: 8px;
  background: var(--dsw-alias-border-l1);
}

/* ---- row: 44px minimum, one right-hand control axis ---- */
.dshmcp-row {
  display: flex; align-items: center; gap: 10px;
  min-height: 44px; padding: 4px 8px;
  border-radius: var(--dsw-radius-md);
  transition: background 90ms linear;
}
.dshmcp-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshmcp-led {
  width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-border-l2);
  transition: background 120ms ease, box-shadow 120ms ease;
}
.dshmcp-row[data-live='true'] .dshmcp-led {
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);
}
.dshmcp-row[data-bad='true'] .dshmcp-led {
  background: var(--dsw-alias-state-error-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);
}
.dshmcp-row[data-busy='true'] .dshmcp-led { animation: dshmcp-pulse 1.3s ease-in-out infinite; }
@keyframes dshmcp-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }

.dshmcp-names { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dshmcp-name {
  font-size: 13px; font-weight: 500; line-height: 17px;
  color: var(--dsw-alias-label-primary); letter-spacing: -.005em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dshmcp-meta {
  font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Tool count is the evidence the connection did something, so it holds a fixed
   slot on the control axis instead of being appended to the truncated meta. */
.dshmcp-tools {
  margin-left: auto; flex: none;
  font-size: 11.5px; line-height: 15px;
  font-variant-numeric: tabular-nums; letter-spacing: .01em;
  color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.dshmcp-tools[data-off='true'] { color: var(--dsw-alias-label-tertiary); }

.dshmcp-switch {
  flex: none; position: relative; width: 30px; height: 18px; padding: 0;
  border: none; border-radius: 9px; cursor: pointer;
  background: var(--dsw-alias-border-l2); transition: background 120ms ease;
}
.dshmcp-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dshmcp-switch:disabled { cursor: progress; opacity: .55; }
.dshmcp-switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.dshmcp-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; transition: transform 120ms cubic-bezier(.3,.7,.4,1);
}
.dshmcp-switch[aria-checked='true'] .dshmcp-knob { transform: translateX(12px); }

/* ---- one-line messages: loading, empty, error, operation note ---- */
.dshmcp-message {
  padding: 2px 14px 10px;
  font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary);
}
.dshmcp-message[data-bad='true'] { color: var(--dsw-alias-state-error-primary); }

/* ---- footer: only speaks when it has something to say ---- */
.dshmcp-foot {
  display: flex; align-items: center; gap: 6px;
  margin: 6px 6px 0; padding: 9px 8px 7px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-secondary);
}
.dshmcp-foot svg { flex: none; opacity: .75; }
.dshmcp-foot[data-bad='true'] { color: var(--dsw-alias-state-error-primary); }
`


    /** Keep a fixed-position panel anchored above its trigger. */
    function useAnchoredPosition(open, anchorRef, panelRef) {
      const [position, setPosition] = React.useState(null)
      React.useLayoutEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const place = () => {
          const rect = anchorRef.current && anchorRef.current.getBoundingClientRect()
          if (!rect) return
          const panel = panelRef.current
          const width = panel ? panel.offsetWidth : 0
          const height = panel ? panel.offsetHeight : 0
          const margin = 12
          let left = rect.right - width
          let top = rect.top - 8 - height
          if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
          if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin)
          setPosition({ left, top })
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        let observer = null
        if (typeof ResizeObserver !== 'undefined' && panelRef.current) {
          observer = new ResizeObserver(place)
          observer.observe(panelRef.current)
        }
        return () => {
          if (observer) observer.disconnect()
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
        }
      }, [open, anchorRef, panelRef])
      return position
    }

    /** Close the panel when a pointer lands outside both the trigger and the portal. */
    function useDismiss(rootRef, panelRef, open, setOpen) {
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (!(event.target instanceof Node)) return
          const inRoot = rootRef.current && rootRef.current.contains(event.target)
          const inPanel = panelRef.current && panelRef.current.contains(event.target)
          if (!inRoot && !inPanel) setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => document.removeEventListener('pointerdown', onPointerDown)
      }, [open, rootRef, panelRef, setOpen])
    }

    /** Read the connection list for one Session's workspace. */
    async function readList(sessionId, signal) {
      const response = await fetch(
        LIST_ROUTE + '?sessionId=' + encodeURIComponent(sessionId),
        { signal, headers: { accept: 'application/json' } },
      )
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return await response.json()
    }

    /** Switch one row for one Session's workspace; resolves to the Host's result. */
    async function writeRow(sessionId, entryId, enabled) {
      const response = await fetch(SET_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, entryId, enabled }),
      })
      try {
        return await response.json()
      } catch {
        return { ok: false, reason: 'operation-error' }
      }
    }

    /**
     * The full target, for the tooltip.
     *
     * The stored target is the complete command line or URL. It is routinely
     * longer than the 320px row, so it is never shown as-is; it is what the
     * reader gets on hover when the short form is not enough.
     */
    function describe(row) {
      return [row.transport, row.target].filter(Boolean).join(' · ')
    }

    /**
     * The short form of {@link describe}, for the visible meta line.
     *
     * The row's identity is already its server name, so this line's job is to
     * say HOW it connects and what it points at — not to repeat a package name
     * two rows can share. Only the token that distinguishes this row from its
     * siblings is kept: the URL's host, or the entry file's basename.
     */
    function summarize(row) {
      const target = typeof row.target === 'string' ? row.target.trim() : ''
      const transport = typeof row.transport === 'string' ? row.transport : ''
      let detail = ''
      if (transport === 'http' || transport === 'sse') {
        try {
          const url = new URL(target)
          detail = url.host
        } catch {
          detail = target
        }
      } else if (target !== '') {
        // For a command, the meaningful discriminator is what it runs: an
        // explicit script path or flag value, else the executable itself.
        const flag = target.match(/--[\w-]+[= ]([^\s]+)/)
        if (flag !== null) {
          detail = flag[1].replace(/^https?:\/\//, '')
        } else {
          const parts = target.split(/\s+/).filter(Boolean)
          // `index.js` names nothing a reader can act on, so only a script with
          // a distinctive basename counts as a discriminator.
          const script = parts.find(part => /\.(?:js|mjs|cjs|ts)$/.test(part))
          const base = script === undefined ? '' : script.split('/').pop() ?? ''
          detail = base === 'index.js' || base === 'index.mjs' ? '' : base
        }
      }
      if (detail === '') {
        // Nothing shorter than the full command identifies this row, so say the
        // one thing the title cannot once the tooltip is open anyway: how it
        // connects. An empty line would look like a rendering bug.
        return transport === '' ? '' : transport === 'stdio' ? 'stdio' : transport
      }
      // `stdio` is the overwhelmingly common case and says nothing the row shape
      // does not; pair it only with a real discriminator.
      const label = transport === '' || transport === 'stdio' ? '' : transport
      return [label, detail].filter(Boolean).join(' · ')
    }

    /** One row's connection state, in this plugin's own words. */
    function phaseOf(row, t) {
      if (row.phase === 'active') return { text: t('state.on'), live: true }
      if (row.phase === 'failed') return { text: t('state.failed'), bad: true }
      if (row.phase === 'loading') return { text: t('state.loading'), busy: true }
      if (row.phase === 'pending') return { text: t('state.pending'), busy: true }
      if (row.phase === 'unloading') return { text: t('state.unloading'), busy: true }
      // Recorded as on but nothing is mounted yet: the startup restore is
      // still running, or its attempt failed and the next start will retry.
      // Reporting "disconnected" here would contradict the switch.
      if (row.enabled === true) return { text: t('state.restoring'), busy: true }
      return { text: t('state.off') }
    }

    /** The composer-toolbar trigger and its connection panel. */
    function McpStatus(props) {
      const t = props.t
      // The Session in view decides the workspace, and each workspace keeps its
      // own switches: switching Sessions must reload rather than reuse the list.
      const sessionId = props.sessionId
      const [open, setOpen] = React.useState(false)
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const position = useAnchoredPosition(open, rootRef, panelRef)
      useDismiss(rootRef, panelRef, open, setOpen)

      const reload = React.useCallback(async (signal) => {
        if (sessionId === undefined) return
        try {
          const next = await readList(sessionId, signal)
          if (signal && signal.aborted) return
          setSnapshot(next)
          setError(false)
        } catch (cause) {
          if (cause && cause.name === 'AbortError') return
          setError(true)
        }
      }, [sessionId])

      // One read on mount so the closed trigger can show a summary. A different
      // Session clears the previous workspace's rows first, so the panel never
      // shows one workspace's switches while another is in view.
      React.useEffect(() => {
        setSnapshot(null)
        const controller = new AbortController()
        void reload(controller.signal)
        return () => controller.abort()
      }, [reload])

      // Refresh only while the panel is open; a closed panel costs nothing.
      React.useEffect(() => {
        if (!open) return undefined
        const controller = new AbortController()
        void reload(controller.signal)
        const timer = setInterval(() => { void reload(controller.signal) }, 4000)
        return () => {
          clearInterval(timer)
          controller.abort()
        }
      }, [open, reload])

      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open])

      const servers = snapshot && Array.isArray(snapshot.servers) ? snapshot.servers : []
      const connected = servers.filter(row => row.connected === true).length
      // Before the first answer the trigger must not claim "not configured":
      // an unread list is not an empty one.
      const summary = snapshot === null && !error
        ? t('trigger.loading')
        : servers.length === 0
          ? t('trigger.none')
          : t('trigger.summary', { on: connected, total: servers.length })

      const toggle = async (row) => {
        setBusy(true)
        setNote(null)
        try {
          const result = await writeRow(sessionId, row.entryId, row.enabled !== true)
          if (!result.ok) {
            if (result.application === 'restart-required') {
              setNote({ text: t('failure.restartRequired'), bad: true })
            } else if (result.reason === 'connect-failed') {
              setNote({ text: t('failure.connectFailed', { reason: result.diagnostic || t('reason.connect-failed') }), bad: true })
            } else if (result.reason !== undefined) {
              setNote({ text: t('failure.failed', { reason: t('reason.' + result.reason) }), bad: true })
            } else {
              setNote({ text: t('failure.failed', { reason: String(result.application || 'unknown') }), bad: true })
            }
          }
        } catch (cause) {
          const message = cause && cause.message ? cause.message : String(cause)
          setNote({ text: t('failure.failed', { reason: message }), bad: true })
        } finally {
          setBusy(false)
          await reload()
        }
      }

      /**
       * One server row: LED, name, meta, tool count, switch.
       *
       * The LED's state is read from the phase rather than the switch, because
       * "the switch says on" and "the process is actually running" diverge while
       * a mount settles or after a failure.
       */
      const renderRow = (row) => {
        const phase = phaseOf(row, t)
        const editable = row.editable === true
        const live = phase.live === true
        const bad = phase.bad === true
        const tools = row.tools === null || row.tools === undefined || row.tools === 0
          ? '—'
          : t('tools.count', { count: row.tools })
        return h('div', {
          key: row.entryId,
          className: 'dshmcp-row',
          'data-live': live,
          'data-bad': bad,
          'data-busy': phase.busy === true && !live,
        }, [
          h('span', { key: 'led', className: 'dshmcp-led', 'aria-hidden': 'true' }),
          h('span', { key: 'names', className: 'dshmcp-names' }, [
            h('span', { key: 'name', className: 'dshmcp-name' }, row.serverName),
            // Transport and target, not the tool count: the count now has its
            // own column, so repeating it here would waste the one line that
            // has to stay short enough not to truncate.
            h('span', { key: 'meta', className: 'dshmcp-meta', title: describe(row) },
              summarize(row)),
          ]),
          h('span', {
            key: 'tools',
            className: 'dshmcp-tools',
            'data-off': row.tools === null || row.tools === undefined || row.tools === 0,
          }, tools),
          h('button', {
            key: 'switch',
            type: 'button',
            className: 'dshmcp-switch',
            role: 'switch',
            'aria-checked': row.enabled === true,
            'aria-label': t(row.enabled ? 'toggle.on' : 'toggle.off', { name: row.serverName }),
            disabled: !editable || busy,
            onClick: () => { void toggle(row) },
          }, h('span', { key: 'knob', className: 'dshmcp-knob' })),
        ])
      }

      /**
       * The list, grouped by the one question the panel answers.
       *
       * Alphabetical order would make the reader check every row to find the
       * live ones; grouping by state answers "what is connected" before the
       * first row is read. A group with no members drops out entirely rather
       * than showing an empty heading.
       */
      const renderGroups = () => {
        const on = servers.filter(row => row.enabled === true)
        const off = servers.filter(row => row.enabled !== true)
        const group = (key, label, members) => (members.length === 0 ? null : h('div', {
          key,
          className: 'dshmcp-group',
        }, [
          h('div', { key: 'label', className: 'dshmcp-glabel' }, [
            h('span', { key: 'text' }, label),
            h('em', { key: 'count' }, String(members.length)),
          ]),
          ...members.map(renderRow),
        ]))
        return [
          group('on', t('group.on'), on),
          group('off', t('group.off'), off),
        ]
      }

      const body = snapshot === null && !error
        ? h('div', { key: 'loading', className: 'dshmcp-message' }, t('panel.loading'))
        : error
          ? h('div', { key: 'error', className: 'dshmcp-message', 'data-bad': true }, t('panel.error'))
          : servers.length === 0
            ? h('div', { key: 'empty', className: 'dshmcp-message' }, t('panel.empty'))
            : renderGroups()

      return h('span', { ref: rootRef, className: 'dshmcp-root' }, [
        h('style', { key: 'css' }, CSS),
        h('button', {
          key: 'trigger',
          type: 'button',
          className: 'dshmcp-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('trigger.aria', { on: connected, total: servers.length }),
          onClick: () => { setOpen(!open) },
        }, [
          h('span', {
            key: 'dot',
            className: 'dshmcp-dot',
            'data-live': connected > 0,
            'data-bad': error,
          }),
          h('span', { key: 'label' }, summary),
        ]),
        open ? createPortal(h('div', {
          key: 'panel',
          ref: panelRef,
          className: 'dshmcp-panel',
          style: position || { visibility: 'hidden', left: 0, top: 0 },
          role: 'dialog',
          'aria-label': t('panel.title'),
        }, [
          h('div', { key: 'head', className: 'dshmcp-head' }, [
            h('span', { key: 'title', className: 'dshmcp-title' }, t('panel.title')),
            h('div', { key: 'actions', className: 'dshmcp-actions' }, [
              h('button', {
                key: 'refresh',
                type: 'button',
                className: 'dshmcp-ghost',
                onClick: () => { void reload() },
              }, busy ? t('panel.refreshing') : t('panel.refresh')),
              h('button', {
                key: 'close',
                type: 'button',
                className: 'dshmcp-ghost',
                onClick: () => { setOpen(false) },
              }, t('panel.close')),
            ]),
          ]),
          body,
          // An operation note replaces the footer rather than stacking above it:
          // two grey lines of small print would fight, and the note is the one
          // the reader needs.
          note
            ? h('div', { key: 'note', className: 'dshmcp-foot', 'data-bad': note.bad === true }, [
                h('span', { key: 'text' }, note.text),
              ])
            : h('div', { key: 'foot', className: 'dshmcp-foot' }, [
                h('svg', {
                  key: 'icon',
                  width: 11,
                  height: 11,
                  viewBox: '0 0 12 12',
                  fill: 'none',
                  stroke: 'currentColor',
                  'stroke-width': 1.3,
                  'aria-hidden': 'true',
                }, [
                  h('rect', { key: 'r', x: 1.4, y: 1.4, width: 9.2, height: 9.2, rx: 2 }),
                  h('path', { key: 'p', d: 'M3.6 6l1.7 1.7L8.6 4.4' }),
                ]),
                h('span', { key: 'text' }, t('panel.subtitle')),
              ]),
        ]), document.body) : null,
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-status: dictionaries')
        // `conversation.input.left` is the list seat inside the composer's
        // `.tools` flex row, which already holds the "+" button and the
        // permission chip ("工作区内修改"). Rendering after that chip is what
        // puts this trigger immediately to its right, in the same row; order 0
        // keeps it ahead of the other occupant of this seat.
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'mcp-status-toolbar',
          order: 0,
          locale: NS,
        }, McpStatus))
      },
    }
  },
})
