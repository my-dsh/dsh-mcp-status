# dsh-mcp-status

English | [中文](README.md)

An MCP connection panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It adds a button to the toolbar below the message composer that lists every MCP server configured on this machine and switches each connection on or off. **With it installed, DSH starts without connecting to any MCP server.**

## Why this plugin

In DSH each MCP server is one `@deepseek-ai/dsh-mcp-client` row. While such a row is enabled, the Loader opens its connection at startup; a server that fails to connect sends the supervisor into reconnect backoff (500ms → 30s, up to 10 attempts), so the background keeps retrying every few dozen seconds. For servers you rarely use that both slows startup and keeps burning child processes and connection attempts.

This plugin moves the "should this be connected?" decision from startup to the user: rows stay as pure configuration, and connections are opened on demand by the panel.

## Install

You need a web-surface profile (the default profile behind `dsh web` is named `web`). Both `git` and `pnpm` must be on `PATH`.

```sh
# Install straight from GitHub
dsh plugin --profile web add github:my-dsh/dsh-mcp-status

# Or from npm once published
dsh plugin --profile web add @my-dsh/dsh-mcp-status
```

The package declares `dsh.bundle`, so installing it joins the profile's bundle layer stack automatically; restart DSH to take effect.

### One step after installing

Switch your existing MCP rows off so `disabled: true` lands in the profile — otherwise the next start still connects automatically. Click the corresponding switch in the GUI (switching off writes back to the profile), or edit `~/.dsh/profiles/<name>/cordis.patch.yml` directly:

```yaml
- id: mcp-chrome
  disabled: true
- id: mcp-mysql
  disabled: true
```

## The interface

It sits in the toolbar row below the composer: the same flex container (`.tools`) as the "+" button and the permission chip ("工作区内修改"), immediately to the right of that chip.

- The button reads `MCP 2/3 connected`; the dot on its left shows whether anything is connected (green = connected, red = the read failed).
- Clicking opens a panel with one row per server: name, transport, connection target, tool count, connection state, and a switch.
- While open the panel refreshes every 4 seconds; while closed it issues no requests.
- It matches the neighbouring chip: 28px tall, `radius-sm`, 13px/20px, same hover fill.
- Copy follows the active interface language (Chinese and English).

## How it works

**Rows are pure configuration.** Each `@deepseek-ai/dsh-mcp-client` row remains the single source of truth for a server's settings (transport / command / args / env / url), but it is set to `disabled: true` so the Loader mounts none of them. Startup therefore opens zero connections and runs zero reconnect timers.

**The panel owns connections.** Switching a server on mounts the shipped `dsh-mcp-client` plugin in this plugin's own context with that row's config, so its tools and resources register into `ctx.tools` exactly as before; switching it off disposes that mount, closing the transport and unregistering the tools. A connection lives exactly as long as the user keeps it on, and a restart always begins disconnected.

**One compatibility path.** If a row is still enabled in the profile, the panel reports it honestly as "connected (maintained by that row)". Switching it off then persists `disabled: true` through the Plugin Manager, so the switch always means the same thing: off stays off across restarts.

## Host routes

Both live on the authenticated `/api` channel; the client calls them with a same-origin `fetch('api/...')`.

- `GET api/mcp-status.list` → `{ servers: [{ entryId, serverName, transport, target, enabled, connected, phase, tools, editable }] }`
- `POST api/mcp-status.set` `{ entryId, enabled }` → `{ ok, application, status }`; on a failed connection `{ ok: false, reason: 'connect-failed', diagnostic }`

## Configuration

The row in `cordis.patch.yml` accepts an optional config, overridable through the user patch layer:

```yaml
- id: mcp-status
  name: '@my-dsh/dsh-mcp-status'
  config:
    # Milliseconds to wait for one connection (default 8000). After the bound
    # the panel shows "connecting" and keeps waiting instead of calling a slow
    # server failed.
    connectTimeoutMs: 8000
```

## Dependencies

Nothing third-party is imported at runtime: the MCP plugin is fetched through `ctx.loader.import('@deepseek-ai/dsh-mcp-client')`, so this bundle declares no `dependencies`. The Host half uses only Node builtins.

The client half is plain JavaScript (`React.createElement`, no build step) and requires only `react` and `react-dom` from the platform module table.

## Source layout

```
dsh-mcp-status/
├── index.js            # Host half: read MCP rows, mount/unmount connections, two /api routes
├── client.js           # Client half: the toolbar button and its panel
├── cordis.patch.yml    # Bundle patch: inserts the mcp-status row
├── locale/
│   ├── zh.json         # Title and description in the plugin list
│   └── en.json
├── icon.svg            # Plugin icon
└── package.json        # dsh.bundle + dsh.client declarations
```

## Publishing

Publishing this package to npm requires an npm account that can write to the `@my-dsh` scope. `package.json` already sets `publishConfig.access: public`, so a maintainer runs:

```sh
npm login                       # needs the @my-dsh-scope account
npm publish
```

The repo-root `.npmrc` pins the registry to `https://registry.npmjs.org/`, so a publishing machine needs no manual registry switch. `npm pack --dry-run` previews the exact tarball.

## License

[MIT](LICENSE)
