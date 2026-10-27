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
 * **The database is the switch, and it is machine-wide.** One `node:sqlite`
 * database holds an `mcp_state(server, enabled)` table keyed by the server's
 * `serverName`. MCP connections are machine-wide by construction — every
 * `mcp-client` instance registers its tools into one global registry, and a
 * `serverName` may be held by one live instance at a time — so one set of
 * switches is the only set that can be true. A server with no row is off, which
 * keeps a fresh install connecting to nothing.
 *
 * **Reading never reconnects.** The list route is a pure projection: it reports
 * the live phase, tool count and recorded switch of every row and changes
 * nothing. Only a switch operation and the startup restore move connections,
 * which is what keeps a second Session, tab or workspace from tearing down a
 * connection another one is using.
 *
 * **The panel owns connections.** Switching a server on writes the row and
 * mounts the shipped `dsh-mcp-client` plugin in this plugin's context with that
 * row's own config, so its tools and resources register exactly as before;
 * switching it off writes the row and disposes that mount, which closes the
 * transport and unregisters the tools.
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

/**
 * Services the bundle reads directly. Cordis only exposes a service on `ctx`
 * when the plugin declares it, so every required access is listed here. The
 * switches are machine-wide, so the panel no longer needs a Session's directory
 * to answer: it reads Loader rows, the tool registry and the database.
 */
export const inject = []

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
 * Switches are machine-wide, because MCP connections are: every `mcp-client`
 * instance registers its tools into one global registry and a `serverName` can
 * be held by only one live instance, so one set of switches is the only set
 * that can be true. A server with no row is off, which keeps a fresh install
 * connecting to nothing.
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
  migratePerWorkspace(db)
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
  const drop = db.prepare('DELETE FROM mcp_state WHERE server = ?')
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
     * @returns the recorded state, or undefined when this server was never switched.
     */
    one(server) {
      const row = selectOne.get(server)
      return row === undefined ? undefined : row.enabled !== 0
    },
    /**
     * Record one switch. An enabled server keeps its row so the panel can
     * restore it; a disabled one drops the row, which is the same state a
     * server that was never switched is in.
     * @param server - configured namespace.
     * @param enabled - whether the server should stay connected.
     */
    write(server, enabled) {
      if (enabled) upsert.run(server, 1, new Date().toISOString())
      else drop.run(server)
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
 * Collapse a per-workspace table into the machine-wide one, once.
 *
 * An earlier build keyed rows by `(workspace, server)`. Those rows described one
 * machine-wide set of connections split into per-workspace opinions, which is
 * what made two Sessions in different workspaces disconnect each other. The
 * intent the user expressed is "keep this server on", wherever it was stated, so
 * the migration keeps every server that is on in at least one workspace and
 * drops the rest. An older table keyed by `server` alone is already the target
 * shape and is left untouched.
 * @param db - open database handle.
 */
function migratePerWorkspace(db) {
  const columns = db.prepare('PRAGMA table_info(mcp_state)').all()
  if (!columns.some(column => column.name === 'workspace')) return
  const enabled = new Set(
    db.prepare('SELECT DISTINCT server FROM mcp_state WHERE enabled = 1').all().map(row => String(row.server)),
  )
  db.exec('DROP TABLE mcp_state')
  db.exec(`CREATE TABLE mcp_state (
    server TEXT NOT NULL PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  const insert = db.prepare('INSERT OR REPLACE INTO mcp_state (server, enabled, updated_at) VALUES (?, 1, ?)')
  const now = new Date().toISOString()
  for (const server of enabled) insert.run(server, now)
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

  /**
   * Apply the recorded switches to the live connections.
   *
   * This is the one place that opens and closes connections, and it runs only
   * from the startup restore and from a switch operation — never from a read.
   * A row the profile itself enables is left alone: the Loader owns that
   * connection, and mounting a second instance would collide on its
   * `serverName`.
   * @param wanted - the `serverName` set the database says should be connected.
   */
  const applySwitches = async (wanted) => {
    // Drop connections that are no longer wanted. A row-owned connection is not
    // ours to drop, and is not in `mounted` either.
    for (const serverName of [...mounted.keys()]) {
      if (wanted.has(serverName)) continue
      try {
        await unmount(serverName)
        ctx.logger.info('mcp-status: disconnected %s', serverName)
      } catch (error) {
        ctx.logger.warn('mcp-status: could not disconnect %s: %s', serverName, String(error))
      }
    }
    for (const { config, serverName } of rows()) {
      if (!wanted.has(serverName)) continue
      if (mounted.has(serverName)) continue
      try {
        const outcome = await mount(serverName, config)
        if (outcome.status === 'failed') {
          ctx.logger.warn('mcp-status: could not connect %s: %s', serverName, outcome.diagnostic)
        } else {
          ctx.logger.info('mcp-status: connected %s', serverName)
        }
      } catch (error) {
        ctx.logger.warn('mcp-status: could not connect %s: %s', serverName, String(error))
      }
    }
  }

  /**
   * The servers the database says should be connected and the profile lets the
   * panel own: enabled in the record, and a row the Loader does not already
   * mount itself.
   * @returns the `serverName` set to apply.
   */
  const wantedSwitches = () => {
    const recorded = getStore()?.read() ?? new Map()
    const wanted = new Set()
    for (const { entry, serverName } of rows()) {
      if (recorded.get(serverName) === true && entry.disabled) wanted.add(serverName)
    }
    return wanted
  }

  /**
   * Project the panel's list.
   *
   * A pure read: it reports what the Loader and this plugin currently hold and
   * what the database records, and touches no connection. Reading from a second
   * Session, tab or workspace therefore cannot disturb the ones in use.
   * @returns the rows, plus the machine-wide switch set they were read against.
   */
  const list = () => {
    reconcile()
    const recorded = getStore()?.read()
    const servers = rows().map(({ entry, config, serverName }) => {
      const own = mounted.get(serverName)
      const rowMounted = !entry.disabled
      // The row owns its connection until the panel takes it over; the panel
      // owns whatever it mounted itself.
      const phase = own !== undefined
        ? FIBER_PHASE[own.state] ?? null
        : entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state] ?? null
      // The switch shows the recorded intent. A row the profile still enables
      // is connected by the Loader whatever the database says.
      const recordedState = recorded?.get(serverName)
      const enabled = rowMounted ? true : recordedState === true
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
    return { servers }
  }

  /**
   * Switch one server, machine-wide.
   * @param entryId - Loader entry id of the row.
   * @param enabled - desired connection state.
   * @returns a compact result for the panel.
   */
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
   * Connect the servers recorded as on.
   *
   * The record is machine-wide, so a restart needs no Session and no directory
   * to decide the set: it connects exactly what was left on, once the Loader has
   * built the row tree this restore reads from.
   */
  const restore = async () => {
    try {
      await applySwitches(wantedSwitches())
    } catch (error) {
      ctx.logger.warn('mcp-status: restore failed: %s', String(error))
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
          return json(200, state.list())
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
