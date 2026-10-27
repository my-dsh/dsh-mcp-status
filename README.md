# dsh-mcp-status

[English](README.en.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 MCP 连接面板插件。

它在对话输入框下方的工具栏里加一个按钮，列出本机所有 MCP 服务器，并逐个开关连接。
**开关状态存在本机 SQLite 里，整机生效**：这个窗口里打开的服务，另一个窗口、另一个工作区
的会话也照样在用；重启后恢复，全新安装时一个都不连。

## 为什么需要它

DSH 里每个 MCP 服务器都是一行 `@deepseek-ai/dsh-mcp-client`。这些行一旦启用，Loader
在启动时就会逐个拉起连接；连不上时 supervisor 进入重连退避（500ms → 30s，最多 10 次），
于是后台每几十秒就重试一次。对不常用的服务器来说，这既拖慢启动，也一直在烧子进程和
连接尝试。

本插件把「要不要连」这件事从启动时挪到用户手上：行保留为纯配置，连接由面板按需建立，
而你的选择记在 SQLite 里，重启后照旧恢复。

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

- 按钮只显示 `MCP 2/3`（已连接数/总数），左侧圆点表示是否有连接（有连接=绿色，读取失败=红色）。
- 点开是一个 **320px 面板**，列表按「已连接 / 未连接」**分组**：打开的第一眼就能看到谁在
  跑，不必逐行读状态。分组标题右侧是这一组的条数。
- 每行 44px：状态点、服务器名、一行元信息、工具数、开关。**工具数单独占一列**（右对齐、
  等宽数字），因为它是「这条连接真的通到了东西」的唯一证据；没工具时显示 `—`。
- 元信息只放**能区分这台服务器的那一点**（URL 的 host、脚本名或传输方式），完整命令行
  在 `title` 里悬停可见，不在 320px 里挤成一坨截断的碎片。
- 字号已按可读性下限校准：服务器名 13px、其余正文与标签 12px（原本有 10px/11px 的）。
- 面板打开时每 4 秒刷新一次；关闭时不发请求。刷新只是读状态，**不会动任何连接**。
- 尺寸与相邻 chip 一致：高 28px、`radius-sm`、13px/20px、同样的 hover 底色。
- 亮色与暗色都只用 DSH 主题令牌，切主题不会花；正文对比度实测 ≥5.6:1。
- 中英文案跟随界面语言。

设计过程留档在 `spec.md`、`directions.md`、`direction-approved.md`，三方向初稿与截图在
`design-demos/`（`thumbs.html` 六格候选、`dir-1/2/3.html` 三个完整方向、`index.html`
并排对比）。最终采用的是方向 C：按连接状态分组，而不是按名字排序。

## 它是怎么工作的

**行是纯配置。** 每个 `@deepseek-ai/dsh-mcp-client` 行继续作为服务器配置的唯一来源
（transport / command / args / env / url），但被置为 `disabled: true`，Loader 不再挂载它们，
所以启动时零连接、零重连计时器。

**开关记在 SQLite 里，整机一份。** 一个 `node:sqlite` 数据库（默认
`$DSH_HOME/mcp-status/mcp-status.db`）保存 `mcp_state(server, enabled)` 表，以 `serverName`
为主键。**没有记录的服务器视为关闭**，所以全新安装启动时连零个服务器。

MCP 连接本来就是整机共享的：每个 `mcp-client` 实例都把工具注册到同一个全局注册表，同一个
`serverName` 同一时刻也只能有一个活着的实例。所以一份开关才是唯一说得通的那份——**你在任何
窗口打开的服务，所有会话都能用**。

**连接由面板接管。** 打开开关时，插件先写一行 `enabled=1`，再用该行的配置在自己的 context 里
挂载官方 `dsh-mcp-client` 插件，工具与资源照旧注册到 `ctx.tools`；关闭开关时删掉那行并 dispose
掉挂载，传输关闭、工具注销。

**读列表不会重连。** 面板的 `list` 路由是纯投影：它报告每一行此刻的 phase、工具数和记录的开关，
不做任何连接动作。**只有开关操作和启动恢复**会真的挂载或卸载——这是关键，否则第二个窗口、
第二个会话每读一次列表就把别人正在用的连接拆掉一次（早期按工作区协调的版本正是这样，
表现为工具在会话中途反复「新增/移除」，甚至调用时报 `unknown tool`）。

**重启后恢复。** 插件激活后（等 Loader 把行树装完）按数据库恢复一次，与任何会话、任何目录无关。
连接失败不会把记录卡在「开」——失败时立即删除那行，面板显示失败原因，下次启动不会再无谓重试。

**一条兼容路径。** 如果某个行在 profile 里仍是启用状态，面板会如实显示为「已连接（由该行
自己维护）」，此时关闭开关会走 Plugin Manager 把 `disabled: true` 持久化——这样开关的含义
始终一致：关掉就是重启后也不会自动连。

## Host 路由

两条都在需要认证的 `/api` 通道上，客户端用同源 `fetch('api/...')` 调用。

- `GET api/mcp-status.list` → `{ servers: [{ entryId, serverName, transport, target, enabled,
  connected, phase, tools, editable }] }`
- `POST api/mcp-status.set` `{ entryId, enabled }` → `{ ok, application, status }`；
  连不上时 `{ ok: false, reason: 'connect-failed', diagnostic }`

两条都不需要 `sessionId`：开关是整机的，读也只是一次投影。

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

想清空开关记录，直接删掉数据库文件即可（下次启动会重建空表）：

```sh
rm ~/.dsh/mcp-status/mcp-status.db*
```

从「按工作区记」的版本升级时，旧表（`workspace, server` 联合主键）会自动折叠成整机一份：
**任何一个工作区里记着「开」的服务器都保留为开**，其余丢弃。按工作区拆开的那套判断正是
两个会话互相拆连接的原因，折叠是这次升级的一部分，不需要手动处理。

## 依赖

运行时不 import 任何第三方包：MCP 插件通过
`ctx.loader.import('@deepseek-ai/dsh-mcp-client')` 从 Loader 取，所以这个 bundle 不需要
声明 `dependencies`。Host 半只用 Node 内置模块。

Client 半是纯 JavaScript（`React.createElement`，无构建步骤），只 require 平台模块表里的
`react` 和 `react-dom`。

## 源码布局

```
dsh-mcp-status/
├── index.js            # Host 半：整机的 SQLite 开关库、读 MCP 行、挂载/卸载连接、两条 /api 路由
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
