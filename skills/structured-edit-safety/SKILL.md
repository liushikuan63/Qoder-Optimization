---
name: structured-edit-safety
description: "对清单/表格/队列/台账/多站点源码做批量机械改造的安全 playbook：追加型编辑锚点丢失（队列行被顶掉、表格行丢失）、多处替换只中一部分却「看起来成功」、dry-run→apply→复扫四段式、逐处计数断言当门禁、混行尾文件正则零命中、批量替换禁止 sed。触发词：批量替换、追加变覆盖、锚点、计数断言、dry-run、复扫、台账批量编辑。不用于字符级转义（→safe-text-editing）。"
---

# 结构化文本批量改造：四段式 playbook

单点替换很安全，**多点同构改造**才是事故区：每处单看都"改成功"，合起来可能只中一半、或把结构吞掉。本技能管流程与断言；字符级细节（引号、`$` 模式、编码、MSYS 路径）走 `safe-text-editing`。

## 四段式（缺一段就等于没验证）

1. **清单**：把每处改动写成结构化记录——`文件 / 锚点（原文完整片段）/ 替换文本 / 预期命中数`。
2. **dry-run**：只列每处命中行号与计数，不写盘；把命中数先摆出来。
3. **门禁**：命中数 != 预期即 FAIL 中止，**绝不带病继续**（案例：B11 空 catch 补日志首跑 3 文件 `count=0 expected 6`，被拦下后修正才续跑；partial write 是这类改造的默认失败态）。
4. **apply → 复扫**：写完断言旧片段归零；**残留逐条解释**（可接受清单 + 理由），解释不了的部分不进台账。

操作清单示例（键为文件路径，按序执行）：

```json
{
  "src/rows.tsv": [
    { "anchor": "\tBLOCKED\t", "replacement": "\tDONE\t", "expectCount": 3 }
  ],
  "docs/ledger.md": [
    { "anchor": "| B05 |", "replacement": "| B05 | fixed |", "expectCount": 1 }
  ]
}
```

## 批量替换写脚本，不写 sed

- 结构化行（清单行 / 表格行 / 队列台账行）**禁 sed 批改**：BRE 里 `\|` 是"或"、空分支会吞掉行尾结构，跨结构边界的替换点写完后"命令成功、文件已坏"。
- 写 Node 脚本读→替换→写，dry-run 先跑；断言在脚本里做成**退出码**（FAIL 即非零），不要靠肉眼看输出。
- 脚本落 `D:\tmp\*.js` 再 `node <file>`；报 `Cannot find module '<项目依赖>'` 是解析不到项目 `node_modules`——改放项目内或补 `NODE_PATH`。
- 路径参数化（argv），别把含反斜杠的路径写进 `node -e` 的字符串（转义 + MSYS 不转换，实测 `/tmp/...` 被 Node 解析成盘根 `D:\tmp\...`）。
- 替换文本用函数式写法（JS `s.replace(a, () => text)`），防 `$&` / `$1` 在替换串里被当特殊模式。

## 追加型编辑铁律（清单/表格/队列）

- **锚点必须完整重包含原锚点原文**（含行尾标题行、表格分隔符行），否则"追加"变"覆盖"（案例：队列里 B08 行被 B05 行顶掉、台账行按缺锚点续写）。
- 追加前先读目标区段 1–2 行作参照；追加后**重读整段**核对：原锚点行仍在、文件行数增量 == 追加行数。
- 同一文件多段追加尽量**一次构造、一次写盘**——分多次小改每次都要重读，中途半成品会被后续编辑吃掉。

## 行尾与字节

- 混行尾文件（`CRLF, LF line terminators`）里正则一律写 `\r?\n`；只写 `\n` 会零命中，只写 `\r\n` 会漏行。
- 改前探测目标文件 EOL；改后用字节数/片段抽检确认改动量与预期相符（防"替换放大/吞行"）。

## 收尾三件

- **结构层**：重读目标区段——标题层级、表格列数、列表标记一致。
- **语法/编译门禁**：`node --check`、`javac`、`babel` 任一可用就跑。
- **内容层**：按 dry-run 计数驱散现场 + 全文关键字扫描；`--selftest` 类自检要有**故意错计数的负例**（问一句：这条断言在什么情况下才会红？）。

## 配套脚本（已内置，路径用绝对形式）

```bash
# 批量编辑：dry-run 先看计数（默认即 dry-run，不写盘）
node $HOME/.qoder/skills/structured-edit-safety/scripts/structured-edit.js --dry-run ops.json
node $HOME/.qoder/skills/structured-edit-safety/scripts/structured-edit.js --apply ops.json   # 计数全过才落盘
# 追加/批改后的收口检查：锚点成活 + 行数增量 + 表格列数
node $HOME/.qoder/skills/structured-edit-safety/scripts/merge-rows-check.js --spec check.json <目标文件>
# 两脚本均自带 --selftest（正例 + 故意错计数的负例）
```

- `structured-edit.js` 的 ops.json：`{baseDir?, files:[{file, edits:[{anchor, replacement, expectCount}]}]}`。**计数任一不符即非零退出、不写任何文件**；锚点重复（`expectCount>1`）需拆分或显式 collapse，工具会拒绝。
- `merge-rows-check.js` 的 check.json：`{beforeLineCount?, expectLineDelta?, expectLineCount?, containsLines:[{text,min}], occurrences:[{text,count}], notContains:[...], tableColumns:[{prefix,separator,columns}]}`。
- 替换用字面量，不解释正则；仍要防 `$&` 类陷阱时改函数式写法（见 `safe-text-editing`）。

## 边界

- 字符级转义 / 编码 / 引号 / MSYS 路径 → `safe-text-editing`。
- `.cmd` 工具链 → `verify-windows-cmd-tool`。
