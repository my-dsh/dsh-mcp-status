# dsh-mcp-status

[English](README.en.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MCP 连接面板插件。

它在对话输入框下方的工具栏里加一个按钮，列出本机所有 MCP 服务器，并逐个开关连接。
**开关状态按工作区存在本机 SQLite 里**：每个工作区记住自己开着的服务器，切换工作区不会串；
重启后恢复，全新安装时一个都不连。

## 为什么需要它

DSH 里每个 MCP 服务器都是一行 `@deepseek-ai/dsh-mcp-client`。这些行一旦启用，Loader
在启动时就会逐个拉起连接；连不上时 supervisor 进入重连退避（500ms → 30s，最多 10 次），
于是后台每几十秒就重试一次。对不常用的服务器来说，这既拖慢启动，也一直在烧子进程和
连接尝试。

本插件把「要不要连」这件事从启动时挪到用户手上：行保留为纯配置，连接由面板按需建立，
而你的选择按工作区记在 SQLite 里，重启和切换工作区都照旧恢复。

## 安装

需要一个 web surface profile（`dsh web` 的默认 profile 名是 `web`）。`git` 和 `pnpm`
都要在 `PATH` 上。

```sh
# 从 GitHub 直装
dsh plugin --profile web add github:my-dsh/dsh-mcp-status

# 或安装已发布到 npm 的版本
dsh plugin --profile web add @my-dsh/dsh-mcp-status
```

包声明了 `dsh.bundle`，安装后自动加入 profile 的 bundle 层栈，重启 DSH 生效。

### 装完之后要做的一件事

把已有的 MCP 行关掉，让 `disabled: true` 写进 profile，这样下次启动才不会自动连。
在 GUI 里点一下对应的开关即可（关闭会写回 profile），或者直接改
`~/.dsh/profiles/<name>/cordis.patch.yml`：

```yaml
- id: mcp-chrome
  disabled: true
- id: mcp-mysql
  disabled: true
```

## 界面

位置在输入框下方那行工具栏：和「+」号、「工作区内修改」在同一个 flex 容器（`.tools`）里，
紧挨「工作区内修改」右侧。

- 按钮显示 `MCP 2/3 已连接`，左侧圆点表示是否有连接（有连接=绿色，读取失败=红色）。
- 点开是一个面板，每个服务器一行：名称、传输方式、连接目标、工具数、连接状态、开关。
- 面板打开时每 4 秒刷新一次；关闭时不发请求。
- 尺寸与相邻 chip 一致：高 28px、`radius-sm`、13px/20px、同样的 hover 底色。
- 中英文案跟随界面语言。

## 它是怎么工作的

**行是纯配置。** 每个 `@deepseek-ai/dsh-mcp-client` 行继续作为服务器配置的唯一来源
（transport / command / args / env / url），但被置为 `disabled: true`，Loader 不再挂载它们，
所以启动时零连接、零重连计时器。

**开关按工作区记在 SQLite 里。** 一个 `node:sqlite` 数据库（默认
`$DSH_HOME/mcp-status/mcp-status.db`）保存 `mcp_state(workspace, server, enabled)` 表，以
**工作区目录**和 `serverName` 为联合主键。工作区由当前会话的目录向上匹配已注册的工作区得出
（与 `dsh-skills-status` 同一套规则）。**某个工作区里没有记录的服务器视为关闭**，所以全新安装、
以及每个新建的工作区，启动时都连零个服务器。

**连接由面板接管。** 打开开关时，插件先为当前工作区写一行 `enabled=1`，再用该行的配置在自己的
context 里挂载官方 `dsh-mcp-client` 插件，工具与资源照旧注册到 `ctx.tools`；关闭开关时删掉那行
并 dispose 掉挂载，传输关闭、工具注销。

**切换工作区会重新协调。** MCP 连接是整机共享的（工具落在同一个全局注册表），所以同一时刻只有
一个工作区的那套连接在线。面板在读取列表时把当前会话所属工作区的记录应用上去：**进入一个工作区
就连它记录的服务器、断开别的工作区持有的连接**，因此切换工作区绝不会继承上一个工作区的状态。

**重启后恢复。** 插件激活后（等 Loader 把行树装完）按默认目录的工作区恢复一次；随后查看任何
工作区的会话时再按该工作区协调。连接失败不会把记录卡在「开」——失败时立即删除那行，面板显示
失败原因，下次启动不会再无谓重试。

**一条兼容路径。** 如果某个行在 profile 里仍是启用状态，面板会如实显示为「已连接（由该行
自己维护）」，此时关闭开关会走 Plugin Manager 把 `disabled: true` 持久化——这样开关的含义
始终一致：关掉就是重启后也不会自动连。

## Host 路由

两条都在需要认证的 `/api` 通道上，客户端用同源 `fetch('api/...')` 调用。

- `GET api/mcp-status.list?sessionId=<id>` → `{ workspace, servers: [{ entryId, serverName,
  transport, target, enabled, connected, phase, tools, editable }] }`
- `POST api/mcp-status.set` `{ sessionId, entryId, enabled }` → `{ ok, application, status }`；
  连不上时 `{ ok: false, reason: 'connect-failed', diagnostic }`

两条都要 `sessionId`：它决定这次读写的**工作区**。

## 配置

`cordis.patch.yml` 里的行可以带可选配置，通过用户 patch 层覆盖：

```yaml
- id: mcp-status
  name: '@my-dsh/dsh-mcp-status'
  config:
    # 开关数据库路径（默认 $DSH_HOME/mcp-status/mcp-status.db）。
    # 目录以 0700 创建、文件以 0600 写入。
    databasePath: /home/me/.dsh/mcp-status/mcp-status.db
    # 单次连接的等待上限毫秒（默认 8000）。超时后面板显示「连接中」并继续等，
    # 不会把还在连的服务器判成失败。
    connectTimeoutMs: 8000
    # 启动后多久开始恢复上次开着的服务器，毫秒（默认 1200）。留出 Loader 把行树装完。
    restoreDelayMs: 1200
```

想清空所有工作区的开关记录，直接删掉数据库文件即可（下次启动会重建空表）：

```sh
rm ~/.dsh/mcp-status/mcp-status.db*
```

从早期「整机一份」的版本升级时，旧表（只有 `server` 主键）会被丢弃重建——那些记录无法归属到
某个工作区，因此不会带入任何一个工作区。

## 依赖

运行时不 import 任何第三方包：MCP 插件通过
`ctx.loader.import('@deepseek-ai/dsh-mcp-client')` 从 Loader 取，所以这个 bundle 不需要
声明 `dependencies`。Host 半只用 Node 内置模块。

Client 半是纯 JavaScript（`React.createElement`，无构建步骤），只 require 平台模块表里的
`react` 和 `react-dom`。

## 源码布局

```
dsh-mcp-status/
├── index.js            # Host 半：按工作区的 SQLite 开关库、读 MCP 行、挂载/卸载连接、两条 /api 路由
├── client.js           # Client 半：工具栏按钮与面板
├── cordis.patch.yml    # bundle 补丁：插入 mcp-status 行
├── locale/
│   ├── zh.json         # 插件列表里的标题与描述
│   └── en.json
├── icon.svg            # 插件图标
└── package.json        # dsh.bundle + dsh.client 声明
```

## 发布到 npm

需要一个能写 `@my-dsh` scope 的 npm 账号。`package.json` 里已设好
`publishConfig.access: public`，维护者执行：

```sh
npm login                       # 用 @my-dsh scope 对应的账号
npm publish
```

仓库根的 `.npmrc` 把 registry 钉在 `https://registry.npmjs.org/`，发布机器无需手工切换。
`npm pack --dry-run` 可预览实际 tarball 内容。

## License

[MIT](LICENSE)
