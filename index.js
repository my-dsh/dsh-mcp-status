/**
 * Host half of the MCP status bundle: it owns MCP connections so that starting
 * DSH connects to nothing.
 *
 * **Rows are inert configuration.** Every `@deepseek-ai/dsh-mcp-client` row in
 * the profile describes one server. This bundle is installed with those rows
 * switched off (`disabled: true` in the profile patch), so the Loader mounts
 * none of them at startup and no connection or reconnect timer ever runs on its
 * own. The rows remain the single source of truth for a server's transport,
 * command, arguments, environment and URL.
 *
 * **The panel owns connections.** Switching a server on mounts the shipped
 * `dsh-mcp-client` plugin in this plugin's context with that row's own config,
 * so its tools and resources register exactly as they always did; switching it
 * off disposes that mount, which closes the transport and unregisters the
 * tools. A connection therefore lives exactly as long as the user keeps it on,
 * and a restart always begins disconnected.
 *
 * **Two authenticated routes** answer the composer-toolbar component: the row
 * inventory with live phase and tool counts, and one switch operation.
 *
 * Only Node builtins are imported. The MCP plugin is loaded through the Loader
 * (`ctx.loader.import`), so the bundle declares no dependencies.
 *
 * @module @my-dsh/dsh-mcp-status
 */

/** Module name of the plugin each managed row runs. */
const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/** Exact Fetch routes on the authenticated shared API channel. */
const LIST_PATH = '/api/mcp-status.list'
const SET_PATH = '/api/mcp-status.set'

/** Defaults for the row's `config`. */
const DEFAULTS = Object.freeze({
  connectTimeoutMs: 8000,
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
 * Validate the row's raw config.
 * @param config - raw `config` from the profile patch.
 * @returns the resolved options.
 * @throws {TypeError} when a field has an unsupported value.
 */
function resolveOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const connectTimeoutMs = raw.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 0 || connectTimeoutMs > 120000) {
    throw new TypeError('mcp-status: connectTimeoutMs must be a number between 0 and 120000')
  }
  return { connectTimeoutMs }
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
 * Create the panel's Host state: the row inventory and the connections this
 * plugin opened.
 * @param ctx - plugin context.
 * @param options - resolved plugin options.
 * @returns the state object with its operations.
 */
function createState(ctx, options) {
  /** Connections this plugin opened, keyed by `serverName`. */
  const mounted = new Map()
  /** Loaded MCP plugin shape, resolved through the Loader once. */
  let mcpPlugin

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
    const fiber = ctx.plugin({
      name: `mcp-status:${serverName}`,
      inject: plugin.inject,
      apply: plugin.apply,
      Config: plugin.Config,
    }, config)
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

  /** Project the panel's list. */
  const list = () => rows().map(({ entry, config, serverName }) => {
    const own = mounted.get(serverName)
    const rowMounted = !entry.disabled
    // A row that is still enabled in the profile connects itself at startup.
    // The panel reports it as connected and takes it over on the next switch
    // off, rather than pretending the row is one of its own mounts.
    const phase = own !== undefined
      ? FIBER_PHASE[own.state] ?? null
      : entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state] ?? null
    return {
      entryId: entry.id,
      serverName,
      transport: typeof config.transport === 'string' ? config.transport : 'unknown',
      target: describeTarget(config),
      enabled: own !== undefined || rowMounted,
      connected: phase === 'active',
      phase,
      tools: toolCount(ctx, serverName),
      editable: own !== undefined || rowMounted || ctx.get('pluginManager') !== undefined,
    }
  })

  /** Switch one server: on mounts a connection here, off disposes it. */
  const set = async (entryId, enabled) => {
    const target = rows().find(row => row.entry.id === entryId)
    if (target === undefined) return { ok: false, reason: 'unknown-plugin' }
    const { entry, config, serverName } = target
    if (enabled) {
      if (mounted.has(serverName)) return { ok: true, application: 'applied', status: 'already-connected' }
      // A row the profile still enables is already connected by the Loader.
      if (!entry.disabled) return { ok: true, application: 'applied', status: 'already-connected' }
      try {
        const outcome = await mount(serverName, config)
        if (outcome.status === 'failed') return { ok: false, reason: 'connect-failed', diagnostic: outcome.diagnostic }
        return { ok: true, application: 'applied', status: outcome.status }
      } catch (error) {
        return { ok: false, reason: 'connect-failed', diagnostic: String(error?.message ?? error) }
      }
    }
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

  /** Dispose every mount this plugin opened. */
  const dispose = async () => {
    const fibers = [...mounted.values()]
    mounted.clear()
    await Promise.allSettled(fibers.map(fiber => fiber.dispose()))
  }

  return { list, set, dispose }
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
 * Activate the MCP status panel: its routes and the teardown of every
 * connection it opened.
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
}
