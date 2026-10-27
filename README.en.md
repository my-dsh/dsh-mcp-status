# dsh-mcp-status

English | [中文](README.md)

An MCP connection panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It adds a button to the toolbar below the message composer that lists every MCP server configured on this machine and switches each connection on or off. **Each switch is stored in local SQLite per workspace**, so every workspace remembers its own set, switching workspaces does not carry state across, a restart restores what you left on, and a fresh install connects to none.

## Why this plugin

In DSH each MCP server is one `@deepseek-ai/dsh-mcp-client` row. While such a row is enabled, the Loader opens its connection at startup; a server that fails to connect sends the supervisor into reconnect backoff (500ms → 30s, up to 10 attempts), so the background keeps retrying every few dozen seconds. For servers you rarely use that both slows startup and keeps burning child processes and connection attempts.

This plugin moves the "should this be connected?" decision from startup to the user: rows stay as pure configuration, connections are opened on demand by the panel, and your choice is recorded in SQLite per workspace so it survives both a restart and a workspace switch.

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
- Clicking opens a **320px panel whose list is grouped by state** — connected and not connected. Opening it answers "what is running" before a single row's status is read; each group heading carries its own count.
- Each 44px row holds a status dot, the server name, one line of metadata, the tool count, and a switch. **The tool count gets its own column** (right-aligned, tabular figures) because it is the only proof the connection actually reached something; with no tools it reads `—`.
- The metadata line carries only what **distinguishes this server** (the URL's host, the script name, or the transport); the full command line is available on hover via `title`, rather than being truncated into fragments at 320px.
- While open the panel refreshes every 4 seconds; while closed it issues no requests.
- It matches the neighbouring chip: 28px tall, `radius-sm`, 13px/20px, same hover fill.
- Light and dark themes use only DSH theme tokens, so switching themes never breaks the colours; measured body contrast is at least 5.6:1.
- Copy follows the active interface language (Chinese and English).

The design record is kept in `spec.md`, `directions.md`, and `direction-approved.md`, with the
three directions and their screenshots under `design-demos/` (`thumbs.html` for the six
candidates, `dir-1/2/3.html` for the three full directions, `index.html` for the side-by-side
comparison). The shipped version is direction C: grouped by connection state rather than sorted
by name.

## How it works

**Rows are pure configuration.** Each `@deepseek-ai/dsh-mcp-client` row remains the single source of truth for a server's settings (transport / command / args / env / url), but it is set to `disabled: true` so the Loader mounts none of them. Startup therefore opens zero connections and runs zero reconnect timers.

**The switch lives in SQLite, per workspace.** One `node:sqlite` database (default `$DSH_HOME/mcp-status/mcp-status.db`) holds an `mcp_state(workspace, server, enabled)` table keyed by the **workspace directory** plus `serverName`. The workspace is resolved by matching the current Session's directory upward against the registered workspaces (the same rule `dsh-skills-status` uses). **A server with no row in a workspace is off**, so a fresh install — and every newly created workspace — starts connected to nothing.

**The panel owns connections.** Switching a server on writes the row for the current workspace first, then mounts the shipped `dsh-mcp-client` plugin in this plugin's own context with that row's config, so its tools and resources register into `ctx.tools` exactly as before; switching it off deletes that row and disposes the mount, closing the transport and unregistering the tools.

**Switching workspaces reconciles.** MCP connections are machine-wide — the tools land in one global registry — so only one workspace's set can be connected at a time. Reading the list applies the current Session's workspace: **entering a workspace connects what it recorded and drops what another workspace held**, so a workspace switch never inherits the previous one's connections.

**A restart restores the set.** After activation (once the Loader has built the row tree) the plugin applies the default directory's workspace once; viewing a Session of any other workspace reconciles against that one. A failed connection never leaves the record stuck on: the failure deletes the row immediately, the panel shows why, and the next start does not retry it pointlessly.

**One compatibility path.** If a row is still enabled in the profile, the panel reports it honestly as "connected (maintained by that row)". Switching it off then persists `disabled: true` through the Plugin Manager, so the switch always means the same thing: off stays off across restarts.

## Host routes

Both live on the authenticated `/api` channel; the client calls them with a same-origin `fetch('api/...')`.

- `GET api/mcp-status.list?sessionId=<id>` → `{ workspace, servers: [{ entryId, serverName, transport, target, enabled, connected, phase, tools, editable }] }`
- `POST api/mcp-status.set` `{ sessionId, entryId, enabled }` → `{ ok, application, status }`; on a failed connection `{ ok: false, reason: 'connect-failed', diagnostic }`

Both require `sessionId`: it decides which **workspace** the read or write belongs to.

## Configuration

The row in `cordis.patch.yml` accepts an optional config, overridable through the user patch layer:

```yaml
- id: mcp-status
  name: '@my-dsh/dsh-mcp-status'
  config:
    # Switch database path (default $DSH_HOME/mcp-status/mcp-status.db).
    # The directory is created 0700 and the file written 0600.
    databasePath: /home/me/.dsh/mcp-status/mcp-status.db
    # Milliseconds to wait for one connection (default 8000). After the bound
    # the panel shows "connecting" and keeps waiting instead of calling a slow
    # server failed.
    connectTimeoutMs: 8000
    # Milliseconds after activation before restoring the servers recorded as on
    # (default 1200). Gives the Loader time to finish building the row tree.
    restoreDelayMs: 1200
```

To clear every workspace's recorded switches, delete the database file (the next
start rebuilds an empty table):

```sh
rm ~/.dsh/mcp-status/mcp-status.db*
```

Upgrading from the earlier machine-wide build drops and recreates the old table
(which had only a `server` key): those rows cannot be attributed to a workspace,
so they are not carried into any of them.

## Dependencies

Nothing third-party is imported at runtime: the MCP plugin is fetched through `ctx.loader.import('@deepseek-ai/dsh-mcp-client')`, so this bundle declares no `dependencies`. The Host half uses only Node builtins.

The client half is plain JavaScript (`React.createElement`, no build step) and requires only `react` and `react-dom` from the platform module table.

## Source layout

```
dsh-mcp-status/
├── index.js            # Host half: per-workspace SQLite switch store, MCP rows, mount/unmount, two /api routes
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
