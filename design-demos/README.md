# 设计过程留档

这个目录是面板重设计的工作记录，不是插件运行需要的文件。

| 文件 | 是什么 |
|---|---|
| `thumbs.html` / `thumbs.png` | 六个候选的缩略图总览（A–F 各一格） |
| `dir-1.html` / `dir-1.png` | 方向 A · 台账（Vignelli，横线秩序） |
| `dir-2.html` / `dir-2.png` | 方向 C · 分组（Linear settings，按连接状态分组）**← 最终采用** |
| `dir-3.html` / `dir-3.png` | 方向 D · 图标行（Raycast Store，图标位） |
| `index.html` / `compare.png` | 三方向并排对比页（拿去给用户选的那张） |
| `live-c.png` | 最终版在真实 DSH GUI 里的样子（亮色） |
| `live-dark.png` | 同上，暗色 |

`dir-*.html` 里的面板是**静态复刻**，用同一套 DSH 主题令牌和同一份内容，
用来在选定方向前横向比较骨架；真正的实现是仓库根目录的 `client.js`。

## 体检：不需要 playwright

`design_lint.py` 只用 playwright 做三件事——打开页面、执行它内嵌的 `COLLECT_JS`、
截图。前两件 chrome-devtools-mcp 完全能做，所以这里有一套替代链路：

| 文件 | 是什么 |
|---|---|
| `lint.py` | 把浏览器采集的事实喂给 `design_lint.py` 的 `judge()` / `families()`，跑全部检查 |
| `probe-page.js` | 通用探针：原样执行 design_lint 的 `COLLECT_JS`，测整个页面 |
| `probe-panel.js` | 专用探针：只测 `.dshmcp-panel` 子树，排除应用自身 chrome 的干扰 |

用法见 `lint.py` 顶部注释。要点：先用 chrome-devtools-mcp 的 `evaluate_script`
（`sourcePath` 指向探针、`filePath` 存 JSON），再用 `python3 lint.py <facts.json>` 判定。

**确实还缺的**：`palette` / `layout` 指纹（`compare` 和 `ledger add` 用）要从截图算，
依赖 Pillow，本机没有。所以「三方向撞没撞」「和最近项目撞没撞」这两项没跑；
其余检查（字号、对比度、模板装饰、外观家族）都跑了。

### 一个已知的假红灯

`COLLECT_JS` 用 `elementsFromPoint` 取背景色。面板背景是半透明毛玻璃
（`--dsw-specific-menu` 本身带 0.58 alpha，这是 DSH 有意为之），采样会偶发
穿透到面板下方的内容，把对比度算低。在真实 DSH 里测 `mysqlob` 那行就撞上过
一次（记录 3.11，实算 18.33 —— 采样点落到了页面底部一个蓝色元素的边缘）。

核对方法：按面板自身表面色把 alpha 压平再算，交付版的 7 处文字全部 ≥5.63:1。
不要为了迎合这个采样器把面板改成不透明，那会破坏与宿主的一致性。

## 外观账本待记

`ledger add` 需要 Pillow 采指纹，本机没有。装好后补记：

```sh
pip install pillow
python3 ~/.agents/skills/huashu-design/scripts/design_lint.py ledger add \
  design-demos/dir-2.html --project "dsh-mcp-status 面板" \
  --note "来源：Linear settings（按连接状态分组，44px 行，右侧控件硬轴）"
```
