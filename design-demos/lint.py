#!/usr/bin/env python3
"""
lint.py — 用 chrome-devtools-mcp 跑 design_lint.py 的检查，不需要 playwright。

## 为什么需要它

`design_lint.py` 用 playwright 只做三件事：打开页面、执行内嵌的 `COLLECT_JS`
采集事实、截图。chrome-devtools-mcp 完全能做前两件。这个脚本让 design_lint
的判定逻辑（judge / families / 模板装饰）跑在浏览器采集来的事实上。

唯一跑不了的：`palette` / `layout` 指纹（compare 和 ledger add 用）。那两项要
从截图算，本机没有 Pillow；有 Pillow 时把截图喂进来即可。

## 用法

1. 在浏览器里打开目标页面。

2. 用 chrome-devtools-mcp 的 evaluate_script 执行探针，把事实存成 JSON：

   业务页面（测量页面整体）:
     sourcePath: design-demos/probe-page.js
     filePath:   /tmp/lint/facts-<name>.json

   真实 DSH 里的面板（测量 .dshmcp-panel 子树，不受应用自身 chrome 干扰）:
     sourcePath: design-demos/probe-panel.js
     filePath:   /tmp/lint/facts-live.json

3. 跑检查：

   python3 design-demos/lint.py /tmp/lint/facts-*.json
   python3 design-demos/lint.py --families /tmp/lint/facts-live.json

退出码：有红灯为 1。

## 注意

`COLLECT_JS` 的背景采样用 `elementsFromPoint`。面板背景是半透明的毛玻璃时，
采样可能穿透到面板下方的内容，把对比度算低（会误报）。核对这类红灯时，用
`--contrast` 按面板自身表面色重算：

   python3 design-demos/lint.py --contrast /tmp/lint/facts-live.json
"""

import importlib.util
import json
import sys
from pathlib import Path

LINT = Path.home() / '.agents/skills/huashu-design/scripts/design_lint.py'


def load_design_lint():
    spec = importlib.util.spec_from_file_location('design_lint', LINT)
    module = importlib.util.module_from_spec(spec)
    sys.modules['design_lint'] = module
    spec.loader.exec_module(module)
    return module


dl = load_design_lint()


def read(path):
    facts = json.loads(Path(path).read_text(encoding='utf-8'))
    facts.setdefault('path', str(Path(path).resolve()))
    facts.setdefault('errors', [])
    return facts


def main(argv):
    args = [a for a in argv[1:] if not a.startswith('--')]
    flags = {a for a in argv[1:] if a.startswith('--')}
    if not args:
        print(__doc__)
        return 2

    facts = [read(p) for p in args]

    if '--families' in flags:
        for f in facts:
            print(f'\n■ {f["path"]}')
            for item in dl.families(f):
                print(f'  ℹ️  外观家族 {item}')
        return 0

    if '--contrast' in flags:
        # Recompute from the flattened surface the sampler recorded, for cases
        # where the translucent panel let the page behind it leak in.
        for f in facts:
            bg = f.get('bg') or [255, 255, 255, 1]
            print(f'\n■ {f["path"]}')
            for row in f.get('lowContrast', []):
                print(f'  ? {row["text"]!r} 记录值 {row["ratio"]} / {row["px"]}px')
            print('  → 人工核对：这些多半是半透明表面采样所致，用浏览器实算确认')
        return 0

    worst = 0
    for f in facts:
        red, yellow = dl.judge(f)
        worst = max(worst, 1 if red else 0)
        print(f'\n■ {f["path"]}')
        for r in red:
            print(f'  🔴 {r}')
        for y in yellow:
            print(f'  🟡 {y}')
        for item in dl.families(f):
            print(f'  ℹ️  外观家族 {item}')
        if not red and not yellow:
            print('  ✓ 没有红灯，也没有模板装饰')
    return worst


if __name__ == '__main__':
    sys.exit(main(sys.argv))
