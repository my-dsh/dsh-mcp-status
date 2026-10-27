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

## 外观账本待记

`design_lint.py ledger add` 需要 Python 版 playwright 才能采集指纹，本机未安装，故未记。
装好后补记：

```sh
pip install playwright pillow && playwright install chromium
python3 ~/.agents/skills/huashu-design/scripts/design_lint.py ledger add \
  design-demos/dir-2.html --project "dsh-mcp-status 面板" \
  --note "来源：Linear settings（按连接状态分组，44px 行，右侧控件硬轴）"
```
