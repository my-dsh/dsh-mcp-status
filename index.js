/**
 * Host half of the MCP status bundle: it owns MCP connections, and remembers
 * each switch in SQLite so a restart restores the servers you left on.
 *
 * **Rows are inert configuration.** Every `@deepseek-ai/dsh-mcp-client` row in
 * the profile describes one server. With those rows switched off
 * (`disabled: true` in the profile patch) the Loader mounts none of them, so no
 * row opens a connection or runs a reconnect timer behind the panel's back. The
 * rows remain the single source of truth for a server's transport, command,
 * arguments, environment and URL.
 *
 * **The database is the switch.** One `node:sqlite` database holds an
 * `mcp_state(server, enabled)` table keyed by `serverName`. A server with no row
 * is off, which keeps a fresh install connecting to nothing at startup.
 *
 * **The panel owns connections.** Switching a server on writes the database and
 * mounts the shipped `dsh-mcp-client` plugin in this plugin's context with that
 * row's own config, so its tools and resources register exactly as before;
 * switching it off writes the database and disposes that mount, which closes the
 * transport and unregisters the tools. On activation the servers recorded as on
 * are mounted again, so reopening DSH restores the set you left connected.
 *
 * **Two authenticated routes** answer the composer-toolbar component: the row
 * inventory with live phase and tool counts, and one switch operation.
 *
 * Only Node builtins are imported. The MCP plugin is loaded through the Loader
 * (`ctx.loader.import`), so the bundle declares no dependencies.
 *
 * @module @my-dsh/dsh-mcp-status
 */

import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Module name of the plugin each managed row runs. */
const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** Exact Fetch routes on the authenticated shared API channel. */
const LIST_PATH = '/api/mcp-status.list'
const SET_PATH = '/api/mcp-status.set'

/** Defaults for the row's `config`. */
const DEFAULTS = Object.freeze({
  connectTimeoutMs: 8000,
  restoreDelayMs: 1200,
})

/** Fiber state numbers, mirrored from Cordis. */
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/**
 * Default database file under the DSH home directory.
 * @returns the absolute database path.
 */
function defaultDatabasePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'mcp-status', 'mcp-status.db')
}

/**
 * Validate the row's raw config.
 * @param config - raw `config` from the profile patch.
 * @returns the resolved options.
 * @throws {TypeError} when a field has an unsupported value.
 */
function resolveOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const bounded = (name, value, max) => {
    if (!Number.isFinite(value) || value < 0 || value > max) {
      throw new TypeError(`mcp-status: ${name} must be a number between 0 and ${max}`)
    }
    return value
  }
  const databasePath = raw.databasePath ?? defaultDatabasePath()
  if (typeof databasePath !== 'string' || databasePath === '') {
    throw new TypeError('mcp-status: databasePath must be a non-empty string')
  }
  return {
    databasePath,
    connectTimeoutMs: bounded('connectTimeoutMs', raw.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs, 120000),
    restoreDelayMs: bounded('restoreDelayMs', raw.restoreDelayMs ?? DEFAULTS.restoreDelayMs, 60000),
  }
}

/**
 * Resolve one row's `!!js` config nodes exactly as the Loader does for an
 * active row, so a disabled row's config is still usable.
 * @param entry - the Loader entry owning the config.
 * @param value - raw config value, possibly holding `{ __jsExpr }` nodes.
 * @returns the resolved value.
 */
function resolveJs(entry, value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => resolveJs(entry, item))
  if (typeof value.__jsExpr === 'string') return entry.evaluate(value.__jsExpr)
  const result = {}
  for (const [key, item] of Object.entries(value)) result[key] = resolveJs(entry, item)
  return result
}

/**
 * Describe where one row connects, for the panel's second line.
 * @param config - the row's resolved `dsh-mcp-client` config.
 * @returns a short destination such as a URL, a command, or the transport name.
 */
function describeTarget(config) {
  if (config.transport === 'stdio') {
    const command = typeof config.command === 'string' ? config.command : ''
    const args = Array.isArray(config.args) ? config.args.filter(item => typeof item === 'string') : []
    return [command, ...args].filter(Boolean).join(' ') || 'stdio'
  }
  if (typeof config.url === 'string') return config.url
  return typeof config.transport === 'string' ? config.transport : 'unknown transport'
}

/**
 * Count the tools one server currently contributes to the global registry.
 * @param ctx - context carrying the optional `tools` service.
 * @param serverName - configured MCP namespace.
 * @returns the tool count, or null when the registry is unavailable.
 */
function toolCount(ctx, serverName) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.definitions !== 'function') return null
  const prefix = `mcp__${serverName}__`
  try {
    return tools.definitions().filter(definition => definition.name.startsWith(prefix)).length
  } catch {
    return null
  }
}

/**
 * Build one JSON response with no caching.
 * @param status - HTTP status code.
 * @param body - lossless JSON payload.
 * @returns the Fetch response.
 */
function json(status, body) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Open the switch database, creating its parent owner-only.
 *
 * A server with no row is off, so a fresh install starts connected to nothing
 * and the table stays empty until the user turns something on.
 * @param path - absolute database path.
 * @returns the store with its queries and the close operation.
 */
function openStore(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  // The switches are local preferences, not secrets, but they name the servers
  // this machine connects to: keep the file owner-only regardless of umask.
  try {
    chmodSync(path, 0o600)
  } catch {
    // A read-only or exotic filesystem keeps the umask default; the 0700
    // parent directory still keeps the file out of other users' reach.
  }
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_state (
    server TEXT NOT NULL PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  const selectAll = db.prepare('SELECT server, enabled FROM mcp_state')
  const selectOne = db.prepare('SELECT enabled FROM mcp_state WHERE server = ?')
  const upsert = db.prepare(`INSERT INTO mcp_state (server, enabled, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(server) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = excluded.updated_at`)
  let closed = false
  return {
    /**
     * Every recorded switch.
     * @returns the `serverName → enabled` map.
     */
    read() {
      const result = new Map()
      for (const row of selectAll.all()) result.set(String(row.server), row.enabled !== 0)
      return result
    },
    /**
     * One recorded switch.
     * @param server - configured namespace.
     * @returns the recorded state, or undefined when the server was never switched.
     */
    one(server) {
      const row = selectOne.get(server)
      return row === undefined ? undefined : row.enabled !== 0
    },
    /**
     * Record one switch.
     * @param server - configured namespace.
     * @param enabled - whether the server should stay connected.
     */
    write(server, enabled) {
      upsert.run(server, enabled ? 1 : 0, new Date().toISOString())
    },
    /** Close the connection once. */
    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

/**
 * Create the panel's Host state: the row inventory, the connections this plugin
 * opened, and the switches recorded in SQLite.
 * @param ctx - plugin context.
 * @param options - resolved plugin options.
 * @returns the state object with its operations.
 */
function createState(ctx, options) {
  /** Connections this plugin opened, keyed by `serverName`. */
  const mounted = new Map()
  /** Loaded MCP plugin shape, resolved through the Loader once. */
  let mcpPlugin
  /** Lazily opened switch database; a failure here must not break the panel. */
  let store

  /** The switch database, or undefined when it could not be opened. */
  const getStore = () => {
    if (store !== undefined) return store
    try {
      store = openStore(options.databasePath)
    } catch (error) {
      ctx.logger.warn('mcp-status: could not open %s: %s', options.databasePath, String(error))
      store = null
    }
    return store ?? undefined
  }

  /** Read one row's config, with `!!js` nodes resolved. */
  const configOf = entry => {
    const raw = entry.options.config !== null && typeof entry.options.config === 'object' ? entry.options.config : {}
    try {
      return resolveJs(entry, raw)
    } catch (error) {
      ctx.logger.warn('mcp-status: could not resolve the config of %s: %s', entry.id, String(error))
      return raw
    }
  }

  /** Every configured MCP row in the live Loader tree. */
  const rows = () => {
    const result = []
    for (const entry of ctx.loader.entries()) {
      if (entry.options.group === true) continue
      if (entry.options.name !== MCP_CLIENT_PLUGIN) continue
      const config = configOf(entry)
      const serverName = typeof config.serverName === 'string' && config.serverName !== ''
        ? config.serverName
        : String(entry.options.id ?? '')
      result.push({ entry, config, serverName })
    }
    result.sort((left, right) => left.serverName.localeCompare(right.serverName))
    return result
  }

  /** Resolve the MCP plugin through the Loader, so no dependency is declared here. */
  const loadMcpPlugin = async () => {
    if (mcpPlugin !== undefined) return mcpPlugin
    const namespace = await ctx.loader.import(MCP_CLIENT_PLUGIN)
    const plugin = ctx.loader.unwrapExports(namespace)
    if (plugin === undefined || plugin === null || typeof plugin.apply !== 'function') {
      throw new Error(`mcp-status: ${MCP_CLIENT_PLUGIN} does not export an apply function`)
    }
    mcpPlugin = { name: plugin.name, inject: plugin.inject, apply: plugin.apply, Config: plugin.Config }
    return mcpPlugin
  }

  /**
   * Connect one server by mounting the MCP plugin in this plugin's context.
   * The mount is awaited only up to `connectTimeoutMs`, so a slow server keeps
   * connecting while the panel already shows it as connecting.
   * @param serverName - configured namespace.
   * @param config - that row's resolved config.
   * @returns the settled outcome, or `pending` when the bound expired.
   */
  const mount = async (serverName, config) => {
    if (mounted.has(serverName)) return { status: 'already-connected' }
    const plugin = await loadMcpPlugin()
    let fiber
    try {
      fiber = ctx.plugin({
        name: `mcp-status:${serverName}`,
        inject: plugin.inject,
        apply: plugin.apply,
        Config: plugin.Config,
      }, config)
    } catch (error) {
      // `ctx.plugin` throws synchronously for a duplicate `serverName` or an
      // invalid config. Nothing was registered, so there is nothing to dispose
      // and nothing to track — reporting the failure is the whole job.
      return { status: 'failed', diagnostic: String(error?.message ?? error) }
    }
    mounted.set(serverName, fiber)
    const settled = fiber.then(
      () => ({ status: 'connected' }),
      (error) => {
        mounted.delete(serverName)
        void fiber.dispose().catch(() => {})
        return { status: 'failed', diagnostic: String(error?.message ?? error) }
      },
    )
    const bound = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'pending' }), options.connectTimeoutMs)
      timer.unref?.()
    })
    return await Promise.race([settled, bound])
  }

  /** Disconnect one server by disposing the mount this plugin opened. */
  const unmount = async (serverName) => {
    const fiber = mounted.get(serverName)
    if (fiber === undefined) return { status: 'already-disconnected' }
    mounted.delete(serverName)
    await fiber.dispose()
    return { status: 'disconnected' }
  }

  /**
   * Disable one profile row through the shipped Plugin Manager, which persists
   * `disabled: true` into the profile patch and lets HMR dispose the row.
   * @param entryId - Loader entry id.
   * @param enabled - desired row state.
   * @returns a compact result.
   */
  const setRowEnabled = async (entryId, enabled) => {
    const manager = ctx.get('pluginManager')
    if (manager === undefined) return { ok: false, reason: 'management-unavailable' }
    try {
      const result = await manager.setPluginEnabled(entryId, enabled)
      const applied = result !== null && typeof result === 'object' && result.application === 'applied'
      return {
        ok: applied,
        application: result?.application ?? 'unknown',
        ...result?.restartReason === undefined ? {} : { restartReason: result.restartReason },
        ...result?.error === undefined ? {} : { reason: result.error.code ?? 'operation-error', diagnostic: result.error.diagnostic },
      }
    } catch (error) {
      return { ok: false, reason: 'operation-error', diagnostic: String(error?.message ?? error) }
    }
  }

  /**
   * Yield any connection whose profile row was enabled behind the panel's back.
   *
   * The panel and a row would otherwise both register the same `serverName`,
   * and `mcp-client` refuses the second one: a user who re-enables the row in
   * the plugin list while the panel holds that server would get a confusing
   * "serverName already in use" failure and a row that never activates. The row
   * is the stronger owner (it is what the profile asks for), so the panel drops
   * its own mount and lets the Loader's instance stand.
   * @returns whether anything was released.
   */
  const reconcile = () => {
    let released = false
    for (const { entry, serverName } of rows()) {
      if (entry.disabled) continue
      if (!mounted.has(serverName)) continue
      released = true
      ctx.logger.info('mcp-status: %s is enabled in the profile; the row takes the connection over', serverName)
      // The row is already activating, so this must not await a slow teardown.
      void unmount(serverName).catch((error) => {
        ctx.logger.warn('mcp-status: could not release %s: %s', serverName, String(error))
      })
    }
    return released
  }

  /** Project the panel's list. */
  const list = () => {
    reconcile()
    const recorded = getStore()?.read()
    return rows().map(({ entry, config, serverName }) => {
      const own = mounted.get(serverName)
      const rowMounted = !entry.disabled
      // The row owns its connection until the panel takes it over; the panel
      // owns whatever it mounted itself.
      const phase = own !== undefined
        ? FIBER_PHASE[own.state] ?? null
        : entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state] ?? null
      // The switch shows user intent: the recorded value when there is one,
      // else the profile row's own state so a hand-enabled row reads as on.
      const recordedState = recorded?.get(serverName)
      // A row the profile still enables is connected by the Loader whatever the
      // database says, so it reads as on and reports the row as its owner.
      const enabled = rowMounted ? true : recordedState !== undefined ? recordedState : false
      return {
        entryId: entry.id,
        serverName,
        transport: typeof config.transport === 'string' ? config.transport : 'unknown',
        target: describeTarget(config),
        enabled,
        connected: phase === 'active',
        phase,
        tools: toolCount(ctx, serverName),
        // Who holds the connection: the profile row, or this panel's own mount.
        // Switching a row-owned server off goes through the Plugin Manager,
        // which persists `disabled: true`, so both owners stay switchable.
        managedBy: rowMounted ? 'row' : 'panel',
        editable: true,
      }
    })
  }

  /** Switch one server: on mounts a connection here, off disposes it. */
  const set = async (entryId, enabled) => {
    const target = rows().find(row => row.entry.id === entryId)
    if (target === undefined) return { ok: false, reason: 'unknown-plugin' }
    const { entry, config, serverName } = target
    const store = getStore()
    if (enabled) {
      // Record the intent first: a slow server must survive the next restart
      // even though this mount is still settling.
      store?.write(serverName, true)
      if (mounted.has(serverName)) return { ok: true, application: 'applied', status: 'already-connected' }
      // A row the profile still enables is already connected by the Loader, so
      // mounting a second instance would collide on `serverName`. Disabling the
      // row first would be the only way to own it, and that is not this
      // switch's job: report the row as the owner instead.
      if (!entry.disabled) return { ok: true, application: 'applied', status: 'already-connected' }
      try {
        const outcome = await mount(serverName, config)
        if (outcome.status === 'failed') {
          store?.write(serverName, false)
          return { ok: false, reason: 'connect-failed', diagnostic: outcome.diagnostic }
        }
        return { ok: true, application: 'applied', status: outcome.status }
      } catch (error) {
        store?.write(serverName, false)
        return { ok: false, reason: 'connect-failed', diagnostic: String(error?.message ?? error) }
      }
    }
    store?.write(serverName, false)
    // A row that is still enabled would reconnect at the next start, so the
    // switch also persists its disablement through the Plugin Manager. That
    // reload disposes the row's connection as part of the same change.
    if (!entry.disabled) return await setRowEnabled(entryId, false)
    if (!mounted.has(serverName)) return { ok: true, application: 'applied', status: 'already-disconnected' }
    try {
      await unmount(serverName)
      return { ok: true, application: 'applied', status: 'disconnected' }
    } catch (error) {
      return { ok: false, reason: 'operation-error', diagnostic: String(error?.message ?? error) }
    }
  }

  /**
   * Reconnect every server the database records as on, so reopening DSH
   * restores the set the user left connected.
   *
   * A row the profile still enables is skipped: the Loader already mounted it,
   * and mounting a second instance would collide on its `serverName`.
   */
  const restore = async () => {
    const recorded = getStore()?.read()
    if (recorded === undefined) return
    for (const { entry, config, serverName } of rows()) {
      if (recorded.get(serverName) !== true) continue
      if (!entry.disabled) continue
      try {
        const outcome = await mount(serverName, config)
        if (outcome.status === 'failed') {
          ctx.logger.warn('mcp-status: could not restore %s: %s', serverName, outcome.diagnostic)
        } else {
          ctx.logger.info('mcp-status: restored %s', serverName)
        }
      } catch (error) {
        ctx.logger.warn('mcp-status: could not restore %s: %s', serverName, String(error))
      }
    }
  }

  /** Dispose every mount this plugin opened and close the database. */
  const dispose = async () => {
    const fibers = [...mounted.values()]
    mounted.clear()
    await Promise.allSettled(fibers.map(fiber => fiber.dispose()))
    try {
      store?.close()
    } catch {
      // Closing an already-closed handle is not worth reporting.
    }
  }

  return { list, set, restore, reconcile, dispose, databasePath: options.databasePath }
}

/**
 * Register the panel's two authenticated Host routes.
 * @param ctx - plugin context.
 * @param state - the panel's Host state.
 */
function registerRoutes(ctx, state) {
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: LIST_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json(200, { servers: state.list() })
        } catch (error) {
          return json(500, { error: String(error?.message ?? error) })
        }
      },
    }), 'mcp-status: list route')

    scope.effect(() => scope.connection.fetch.register({
      path: SET_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          const text = await request.text()
          body = text.trim() === '' ? undefined : JSON.parse(text)
        } catch {
          return json(400, { ok: false, reason: 'invalid-json' })
        }
        if (body === null || typeof body !== 'object') return json(400, { ok: false, reason: 'invalid-body' })
        if (typeof body.entryId !== 'string' || body.entryId === '') return json(400, { ok: false, reason: 'invalid-entry' })
        const result = await state.set(body.entryId, body.enabled === true)
        return json(result.ok ? 200 : 409, result)
      },
    }), 'mcp-status: set route')
  })
}

/**
 * Activate the MCP status panel: its routes, the restore of the recorded
 * connections, and the teardown of every connection it opened.
 * @param ctx - plugin context.
 * @param config - raw row config.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const state = createState(ctx, options)
  registerRoutes(ctx, state)

  // Connections belong to this plugin instance: unloading it (a profile edit,
  // a disable, a restart) closes every one of them.
  ctx.effect(() => () => state.dispose(), 'mcp-status: connections')

  // The restore needs the full row tree, which finishes after this row loads.
  const timer = setTimeout(() => {
    void state.restore().catch((error) => {
      ctx.logger.warn('mcp-status: restore failed: %s', String(error))
    })
  }, options.restoreDelayMs)
  timer.unref?.()
  ctx.effect(() => () => clearTimeout(timer), 'mcp-status: restore timer')

  // A row enabled from the plugin list (or by another plugin) must not collide
  // with a connection the panel already holds, so release it as soon as the
  // loader reports the change rather than at the panel's next poll.
  ctx.on('loader/volatile-update', () => { state.reconcile() })
}
