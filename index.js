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
 * **The database is the switch, and it is per workspace.** One `node:sqlite`
 * database holds an `mcp_state(workspace, server, enabled)` table keyed by the
 * workspace's canonical directory and the server's `serverName`. Each workspace
 * therefore keeps its own set of connected servers: switching to another
 * workspace must not inherit the previous one's connections. A server with no
 * row in a workspace is off, which keeps a fresh install — and every newly added
 * workspace — connecting to nothing.
 *
 * **The panel owns connections.** Switching a server on writes the row for the
 * current workspace and mounts the shipped `dsh-mcp-client` plugin in this
 * plugin's context with that row's own config, so its tools and resources
 * register exactly as before; switching it off writes the row and disposes that
 * mount, which closes the transport and unregisters the tools. MCP connections
 * are machine-wide, so the panel reconciles them against the workspace of the
 * Session currently in view: entering a workspace connects what that workspace
 * recorded and drops what another one held.
 *
 * **Two authenticated routes** answer the composer-toolbar component: the row
 * inventory with live phase and tool counts for one Session's workspace, and one
 * switch operation.
 *
 * Only Node builtins are imported. The MCP plugin is loaded through the Loader
 * (`ctx.loader.import`), so the bundle declares no dependencies.
 *
 * @module @my-dsh/dsh-mcp-status
 */

import { chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Services the bundle reads directly. Cordis only exposes a service on `ctx`
 * when the plugin declares it, so every required access is listed here.
 */
export const inject = ['agents', 'workingDirectory']

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
 * Canonicalize a directory the way the workspace registry does, so a symlinked
 * Session directory still matches its workspace.
 * @param path - absolute directory.
 * @returns the real path, or the input when it cannot be resolved.
 */
function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Resolve the workspace a directory belongs to: the deepest registered
 * workspace containing it, or the directory itself when none does.
 *
 * The same rule the skills panel uses, so both plugins agree about what "the
 * current workspace" means. The key is the canonical directory, which is stable
 * across renames of the workspace title.
 * @param ctx - context carrying the optional `workspaceRegistry`.
 * @param cwd - the Session's effective directory.
 * @returns the workspace key plus its display fields.
 */
function workspaceFor(ctx, cwd) {
  const registry = ctx.get('workspaceRegistry')
  const workspaces = registry === undefined ? [] : registry.list()
  const target = canonical(cwd)
  let best
  for (const workspace of workspaces) {
    const base = canonical(workspace.path)
    const rel = relative(base, target)
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    if (!inside) continue
    if (best === undefined || base.length > best.base.length) best = { base, workspace }
  }
  if (best !== undefined) {
    const { workspace, base } = best
    return { key: base, id: String(workspace.id), title: workspace.title, path: workspace.path }
  }
  return { key: target, id: null, title: basename(target), path: cwd }
}

/**
 * Read a Session's effective directory without requiring a live Agent.
 * @param ctx - context carrying `agents`, `workingDirectory`, and optional `sessionQuery`.
 * @param sessionId - Session identity.
 * @returns the absolute directory.
 */
async function directoryOf(ctx, sessionId) {
  // Both services are declared in `inject`, so Cordis guarantees them before
  // `apply` runs; the guards keep a test harness or a partial composition from
  // turning a missing service into a thrown request.
  const agents = ctx.get('agents')
  const workingDirectory = ctx.get('workingDirectory')
  const fallback = typeof workingDirectory?.defaultDirectory === 'string'
    ? workingDirectory.defaultDirectory
    : homedir()
  if (workingDirectory === undefined) return fallback
  const live = agents?.get(sessionId)
  if (live !== undefined) {
    try {
      return await workingDirectory.ensure(live)
    } catch (error) {
      ctx.logger.warn('mcp-status: could not resolve the directory of %s: %s', sessionId, String(error))
      return fallback
    }
  }
  const query = ctx.get('sessionQuery')
  if (query === undefined) return fallback
  try {
    const observation = await query.observeSession(sessionId)
    try {
      const projected = observation.projections?.values?.workingDirectory
      const header = observation.header?.cwd
      if (typeof projected === 'string' && projected !== '') return projected
      if (typeof header === 'string' && header !== '') return header
      return fallback
    } finally {
      const dispose = observation[Symbol.dispose]
      if (typeof dispose === 'function') dispose.call(observation)
    }
  } catch (error) {
    ctx.logger.warn('mcp-status: could not inspect %s: %s', sessionId, String(error))
    return fallback
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
 * Switches are recorded per workspace, so each workspace keeps its own set of
 * connected servers: switching to another workspace must not inherit the
 * previous one's connections. A server with no row in a workspace is off, which
 * keeps a fresh install — and every newly added workspace — connecting to
 * nothing.
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
  // An earlier build keyed rows by server alone. Those rows carry no workspace
  // and cannot be attributed to one, so the table is recreated with the
  // composite key rather than silently adopting a machine-wide default.
  const legacy = db.prepare('PRAGMA table_info(mcp_state)').all()
  const hasWorkspace = legacy.some(column => column.name === 'workspace')
  if (legacy.length > 0 && !hasWorkspace) db.exec('DROP TABLE mcp_state')
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_state (
    workspace TEXT NOT NULL,
    server TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace, server)
  )`)
  const selectWorkspace = db.prepare('SELECT server, enabled FROM mcp_state WHERE workspace = ?')
  const selectOne = db.prepare('SELECT enabled FROM mcp_state WHERE workspace = ? AND server = ?')
  const upsert = db.prepare(`INSERT INTO mcp_state (workspace, server, enabled, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace, server) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = excluded.updated_at`)
  const drop = db.prepare('DELETE FROM mcp_state WHERE workspace = ? AND server = ?')
  let closed = false
  return {
    /**
     * Every switch recorded for one workspace.
     * @param workspace - workspace key.
     * @returns the `serverName → enabled` map.
     */
    read(workspace) {
      const result = new Map()
      for (const row of selectWorkspace.all(workspace)) result.set(String(row.server), row.enabled !== 0)
      return result
    },
    /**
     * One switch recorded for one workspace.
     * @param workspace - workspace key.
     * @param server - configured namespace.
     * @returns the recorded state, or undefined when this workspace never switched it.
     */
    one(workspace, server) {
      const row = selectOne.get(workspace, server)
      return row === undefined ? undefined : row.enabled !== 0
    },
    /**
     * Record one switch for one workspace. An enabled server keeps its row so
     * the panel can restore it; a disabled one drops the row, which is the same
     * state a workspace that never switched it is in.
     * @param workspace - workspace key.
     * @param server - configured namespace.
     * @param enabled - whether the server should stay connected.
     */
    write(workspace, server, enabled) {
      if (enabled) upsert.run(workspace, server, 1, new Date().toISOString())
      else drop.run(workspace, server)
    },
    /**
     * Every workspace that records at least one enabled server.
     * @returns the workspace keys, so the Host knows which ones to restore.
     */
    workspacesWithEnabled() {
      const rows = db.prepare('SELECT DISTINCT workspace FROM mcp_state WHERE enabled = 1').all()
      return rows.map(row => String(row.workspace))
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

  /**
   * The workspace whose switches are currently applied to the live connections.
   *
   * MCP connections are machine-wide — the tools land in one global registry —
   * so only one workspace's set can be connected at a time. This is the one in
   * view, and moving to another workspace reconciles against it.
   */
  let activeWorkspace

  /**
   * Apply one workspace's recorded switches to the live connections.
   *
   * Entering a workspace connects what it recorded and drops what another
   * workspace held, so switching workspaces never inherits the previous one's
   * connections. A row the profile itself enables is left alone: the Loader owns
   * that connection, and mounting a second instance would collide on its
   * `serverName`.
   * @param workspace - the workspace key to apply.
   */
  const applyWorkspace = async (workspace) => {
    if (workspace === activeWorkspace) return
    const recorded = getStore()?.read(workspace) ?? new Map()
    const wanted = new Set()
    for (const { entry, serverName } of rows()) {
      if (recorded.get(serverName) === true && entry.disabled) wanted.add(serverName)
    }
    // Drop connections this workspace does not want. A row-owned connection is
    // not ours to drop, and is not in `mounted` either.
    for (const serverName of [...mounted.keys()]) {
      if (wanted.has(serverName)) continue
      try {
        await unmount(serverName)
        ctx.logger.info('mcp-status: disconnected %s for workspace %s', serverName, workspace)
      } catch (error) {
        ctx.logger.warn('mcp-status: could not disconnect %s: %s', serverName, String(error))
      }
    }
    activeWorkspace = workspace
    for (const { config, serverName } of rows()) {
      if (!wanted.has(serverName)) continue
      if (mounted.has(serverName)) continue
      try {
        const outcome = await mount(serverName, config)
        if (outcome.status === 'failed') {
          ctx.logger.warn('mcp-status: could not connect %s for %s: %s', serverName, workspace, outcome.diagnostic)
        } else {
          ctx.logger.info('mcp-status: connected %s for workspace %s', serverName, workspace)
        }
      } catch (error) {
        ctx.logger.warn('mcp-status: could not connect %s: %s', serverName, String(error))
      }
    }
  }

  /**
   * Project the panel's list for one Session's workspace.
   * @param sessionId - Session identity, which decides the workspace.
   * @returns the workspace descriptor and its rows.
   */
  const list = async (sessionId) => {
    reconcile()
    const cwd = await directoryOf(ctx, sessionId)
    const workspace = workspaceFor(ctx, cwd)
    // Entering the workspace applies its switches before the rows are read, so
    // the phase and tool counts describe this workspace rather than the last.
    await applyWorkspace(workspace.key)
    const recorded = getStore()?.read(workspace.key)
    const servers = rows().map(({ entry, config, serverName }) => {
      const own = mounted.get(serverName)
      const rowMounted = !entry.disabled
      // The row owns its connection until the panel takes it over; the panel
      // owns whatever it mounted itself.
      const phase = own !== undefined
        ? FIBER_PHASE[own.state] ?? null
        : entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state] ?? null
      // The switch shows this workspace's intent. A row the profile still
      // enables is connected by the Loader whatever the database says.
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
    return { workspace, servers }
  }

  /**
   * Switch one server for one Session's workspace.
   * @param sessionId - Session identity, which decides the workspace.
   * @param entryId - Loader entry id of the row.
   * @param enabled - desired connection state.
   * @returns a compact result for the panel.
   */
  const set = async (sessionId, entryId, enabled) => {
    const target = rows().find(row => row.entry.id === entryId)
    if (target === undefined) return { ok: false, reason: 'unknown-plugin' }
    const { entry, config, serverName } = target
    const cwd = await directoryOf(ctx, sessionId)
    const workspace = workspaceFor(ctx, cwd)
    const store = getStore()
    if (enabled) {
      // Record the intent first: a slow server must survive the next restart
      // even though this mount is still settling.
      store?.write(workspace.key, serverName, true)
      activeWorkspace = workspace.key
      if (mounted.has(serverName)) return { ok: true, application: 'applied', status: 'already-connected' }
      // A row the profile still enables is already connected by the Loader, so
      // mounting a second instance would collide on `serverName`. Disabling the
      // row first would be the only way to own it, and that is not this
      // switch's job: report the row as the owner instead.
      if (!entry.disabled) return { ok: true, application: 'applied', status: 'already-connected' }
      try {
        const outcome = await mount(serverName, config)
        if (outcome.status === 'failed') {
          store?.write(workspace.key, serverName, false)
          return { ok: false, reason: 'connect-failed', diagnostic: outcome.diagnostic }
        }
        return { ok: true, application: 'applied', status: outcome.status }
      } catch (error) {
        store?.write(workspace.key, serverName, false)
        return { ok: false, reason: 'connect-failed', diagnostic: String(error?.message ?? error) }
      }
    }
    store?.write(workspace.key, serverName, false)
    activeWorkspace = workspace.key
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
   * Connect the servers the default workspace recorded as on.
   *
   * A restart has no Session in view, so the workspace that opens first decides
   * the set. This applies the default directory's workspace; any other workspace
   * is applied when a Session of it is first viewed.
   */
  const restore = async () => {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      const cwd = typeof workingDirectory?.defaultDirectory === 'string'
        ? workingDirectory.defaultDirectory
        : homedir()
      await applyWorkspace(workspaceFor(ctx, cwd).key)
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
      fetch: async (request) => {
        const sessionId = new URL(request.url).searchParams.get('sessionId')
        if (sessionId === null || sessionId === '') return json(400, { ok: false, reason: 'invalid-session' })
        try {
          const { workspace, servers } = await state.list(sessionId)
          return json(200, { servers, workspace })
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
        if (typeof body.sessionId !== 'string' || body.sessionId === '') return json(400, { ok: false, reason: 'invalid-session' })
        if (typeof body.entryId !== 'string' || body.entryId === '') return json(400, { ok: false, reason: 'invalid-entry' })
        const result = await state.set(body.sessionId, body.entryId, body.enabled === true)
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
