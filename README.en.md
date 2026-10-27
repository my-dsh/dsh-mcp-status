# dsh-mcp-status

English | [中文](README.md)

An MCP connection panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It adds a button to the toolbar below the message composer that lists every MCP server configured on this machine and switches each connection on or off. **Nothing is stored: every start begins with everything disconnected**, and you open the few servers this run needs. Quit DSH and they all close; the next start begins from zero again.

## Why this plugin

In DSH each MCP server is one `@deepseek-ai/dsh-mcp-client` row. While such a row is enabled, the Loader opens its connection at startup; a server that fails to connect sends the supervisor into reconnect backoff (500ms → 30s, up to 10 attempts), so the background keeps retrying every few dozen seconds. For servers you rarely use that both slows startup and keeps burning child processes and connection attempts.

This plugin moves the "should this be connected?" decision from startup to the user: rows stay as pure configuration, connections are opened on demand by the panel, and **they last only for this run** — nothing you opened last time comes back on its own.

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

- The button reads `MCP 2/3` (connected / total); the dot on its left shows whether anything is connected (green = connected, red = the read failed).
- Clicking opens a **320px panel whose list is grouped by state** — connected and not connected. Opening it answers "what is running" before a single row's status is read; each group heading carries its own count.
- Each 44px row holds a status dot, the server name, one line of metadata, the tool count, and a switch. **The tool count gets its own column** (right-aligned, tabular figures) because it is the only proof the connection actually reached something; with no tools it reads `—`.
- The metadata line carries only what **distinguishes this server** (the URL's host, the script name, or the transport); the full command line is available on hover via `title`, rather than being truncated into fragments at 320px.
- Type sizes are calibrated to the readability floor: server names at 13px, all other body and label text at 12px (several were 10px/11px).
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

**Nothing is stored.** The set of open connections lives in this plugin instance's memory only. A restart, a plugin reload or a profile edit empties it — **every start is zero connections**, and you open whichever server this run needs.

That is deliberate. A connected MCP server is a long-lived child process plus a live connection, and it holds a `serverName` (only one live instance per name). Persisting the set would put the startup connection cost right back where it came from, just with a different decider. So this panel keeps no record: **only what you opened in this run is connected.**

**The panel owns connections.** Switching a server on mounts the shipped `dsh-mcp-client` plugin in this plugin's own context with that row's config, so its tools and resources register into `ctx.tools` exactly as before; switching it off disposes the mount, closing the transport and unregistering the tools. **The panel does not write the profile**: a switch is a runtime action, not a configuration edit, so it never rewrites `cordis.patch.yml` or recomposes the tree.

**Reading never reconnects.** The `list` route is a pure projection: it reports each row's current phase, tool count and switch, and performs no connection work. **Only a switch operation** mounts or unmounts anything. That matters: an earlier build reconciled per workspace on every read, so a second window or Session polling the list tore down a connection another one was using — visible as tools being added to and removed from a running Session, and as `unknown tool` failures mid-conversation.

**One compatibility path.** If a row is still enabled in the profile, the panel reports it honestly as "connected (maintained by that row)". Switching it off persists `disabled: true` through the Plugin Manager, which is the only place the panel ever writes configuration — and only when you explicitly turn such a row off.

## Host routes

Both live on the authenticated `/api` channel; the client calls them with a same-origin `fetch('api/...')`.

- `GET api/mcp-status.list` → `{ servers: [{ entryId, serverName, transport, target, enabled, connected, phase, tools, managedBy, editable }] }`
- `POST api/mcp-status.set` `{ entryId, enabled }` → `{ ok, application, status }`; on a failed connection `{ ok: false, reason: 'connect-failed', diagnostic }`

Neither takes a `sessionId`: the panel has no per-Session semantics, and a read is just a projection.

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

There is no database and no state to clean up. Upgrading from a build that had
one, the old `$DSH_HOME/mcp-status/mcp-status.db` is simply no longer read and
can be deleted:

```sh
rm -rf ~/.dsh/mcp-status
```

## Dependencies

Nothing third-party is imported at runtime: the MCP plugin is fetched through `ctx.loader.import('@deepseek-ai/dsh-mcp-client')`, so this bundle declares no `dependencies`. The Host half imports nothing at all — no filesystem, no SQLite.

The client half is plain JavaScript (`React.createElement`, no build step) and requires only `react` and `react-dom` from the platform module table.

## Source layout

```
dsh-mcp-status/
├── index.js            # Host half: MCP rows, mount/unmount, two /api routes (no persistence)
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
