---
name: encrypted-office-visual-inspection
description: "企业透明加密（DLP）Office 读取、复刻、编辑与回归。信号：JSZip 报 Can't find end of central directory、文件头非 zip；桌面/微信打不开；Office MCP 报 QODER_OFFICE_FILE_TYPE_INVALID（仅 PPTX）。触发词：透明加密、DLP 加密、密文、明文、加密 Word、加密 Excel、加密 PPT、加密 PDF、表格打不开、复刻加密文档、加密夹具、解密测试、文档截图取证、版式层对象、CUA 编辑加密文档；不用于：普通 xlsx/docx→office-docs；PPT 制作→pptx；口令破解不支持。"
---

# 透明加密 Office 文档：读取、复刻与编辑

## Overview

企业透明加密（DLP）环境下，Office 文件落盘即密文，只有授权进程（Office 本体）能解密渲染。本技能覆盖 **Word / Excel / PowerPoint** 三种格式，提供三条能力链：

1. **读取取证**：程序化读取（快）→ 命中密文则降级 CUA 窗口截图逐页/逐表取证
2. **完美复刻**：基于 `read_slide`/`read_context` 精确规格 + 截图识别的内容结构，用 office-docs / pptx 技能生成格式一致的新文档（**字体风格/大小/缩进/颜色均须完美复刻**）
3. **编辑原文档**：通过 CUA 驱动在已打开的文档中操作鼠标键盘，完成文字修改、单元格编辑、幻灯片调整等

不重试注定失败的路线——一旦确认密文，立即切换到截图取证通道。

## 快速通道（先照这三步跑，不必先读全文）

脚本目录：`S=~/.qoder/skills-library/encrypted-office-visual-inspection/scripts`

1. **判路线（1 秒）**：`head -c 4 "<文件>"` —— `50 4b 03 04` 是明文（直接复制，见 2.0）；`d0 cf 11 e0` 是旧格式；**其它一律按透明加密**，走第 2 步。
2. **取内容 + 重建明文**（380 格实测 25 秒 + 0.7 秒）：
   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File $S/xlsx-dump.ps1 -Src "<加密.xlsx>" -Out "D:\\tmp\\job\\dump.json"
   node $S/xlsx-rebuild.cjs "D:\\tmp\\job\\dump.json" "D:\\tmp\\job\\out\\明文.xlsx" "D:\\tmp\\job\\out\\明文.csv"
   ```
   `xlsx-rebuild.cjs` 自带文件头断言，产物不是 zip 就退 1。
3. **验收（约 30 秒，9 项断言，任一不符退 1）**：
   ```bash
   powershell -NoProfile -ExecutionPolicy Bypass -File $S/xlsx-verify.ps1 -Src "<加密.xlsx>" -Out "D:\\tmp\\job\\out\\明文.xlsx"
   ```

链路自检：用 PowerShell 7 的完整路径执行 `fixture-selftest.ps1 -WithWord`（命令见第四部分；不带开关为 Excel 4 项，带开关共 9 项）。不要使用 Windows PowerShell 5.1 或修改其执行策略。

**两条死路不要试**：`read_context` 读 xlsx（Office MCP 只支持 PPTX，直接返回 `QODER_OFFICE_FILE_TYPE_INVALID`）、指望 Office「另存为」得到明文（授权进程写盘必被重新加密）。

## 决策树：何时用哪种方式

```
目标是什么？
├─ 要一份可编辑、格式完全一致的明文副本 → 先验原文件头：是 504b0304/d0cf11e0 就【直接复制】（2.0 路线）
│                                        └─ 复制后头变密文 → 回到第二部分的规格复刻
├─ 只需要看内容 → 第一部分：读取取证（S1→S2→S3→S4）
├─ 原文件确为密文且要可编辑副本 → 第一部分读取 + 第二部分按规格复刻
├─ 需要直接改原文档 → 第三部分：CUA 编辑
├─ 需要改原文档 + 留备份 → 第一部分截图留证 + 第三部分编辑
└─ 没有现成密文样本 / 要回归验证链路 → 第四部分：自造加密夹具
```

**方式选择（优先级从上到下）**：
| 方式 | 适用条件 | 限制 |
|---|---|---|
| 直接复制（2.0） | **原文件头正常**（ZIP/OLE 明文） | 最快、零失真；复制后必须复验文件头与 md5 |
| S2 程序化读取 | 文件可复制到授权目录 | 只能拿文字，拿不到图片和渲染效果 |
| S3 导出 | 非加密或导出文件头正常 | 加密环境下导出即密文，先验文件头后决定 |
| S4 CUA 截图 | 任何已打开的文档 | 依赖截图质量，需 zoom 提高精度；仅作兜底 |
| read_slide/read_context | 文件可复制到授权目录 | 按规格重建前必须调用，获取精确坐标/颜色/字体 |
| 按规格复刻 | 原文件确为密文，或复制后被加密 | 工作量大、易走形；必须按第二部分规格表逐项复刻 |
| CUA 编辑 | 文档已在 Office 中打开 | 自绘区域需坐标点击，操作前截图留证 |

## 适用场景与信号

满足任一信号即走本流程：

- Office MCP `read_context` 报 resource denied「outside the authorized task directories」
- 导出的文件头不是正常魔数（PNG `89 50 4E 47`、ZIP/DOCX `50 4B 03 04`、OLE/XLS `D0 CF 11 E0`）
- 文件系统搜索不到已打开文档的真实路径（微信等渠道传输，文件名乱码）
- 需要复刻加密文档的结构和内容
- 需要通过自动化操作修改已打开的加密文档

不适用：未加密文档直接用 office-docs（Excel/Word 数据读写）或 pptx（编辑演示文稿）技能。

## 前置条件

- 目标文件已在对应 Office 程序中打开；未打开时先经 CUA `launch_app` 打开
- `cua_driver` MCP 可用
- 已知当前项目目录（Office MCP 的授权目录 = 任务工作目录及其子目录）
- 复刻时需 office-docs / pptx 技能可用

## 三种程序的 COM 对象与窗口类名对照

| 程序 | COM 对象 | 进程名 | 集合属性 | 导出方式 |
|---|---|---|---|---|
| PowerPoint | `PowerPoint.Application` | `POWERPNT.EXE` | `Presentations` | `Slides.Item(i).Export(path, "PNG", w, h)` |
| Word | `Word.Application` | `WINWORD.EXE` | `Documents` | `ExportAsFixedFormat` (PDF) / 窗口截图 |
| Excel | `Excel.Application` | `EXCEL.EXE` | `Workbooks` | 窗口截图（逐 sheet 切换） |

## CUA 工具选用指南

操作 Office 窗口时，按以下优先级选用 CUA 工具：

| 操作 | 首选工具 | 说明 |
|---|---|---|
| 发现窗口 | `list_windows(app="POWERPNT")` | 按进程名过滤，取 `pid` + `window_id` |
| 读控件树 + 截图 | `get_window_state(pid, window_id)` | **两个参数都必填**；返回 UIA 树 + 截图 |
| 仅截图（不读树） | `get_window_state(pid, window_id, include_accessibility_tree=false)` | 快速截图，不消耗 UIA 遍历 |
| 放大截图 | `zoom(pid, window_id)` → 再 `get_window_state` | 提高小字体/细节的截图精度 |
| 点击控件 | `click(element_token=...)` | 优先 element_token；自绘区域用 `x,y` + 默认 background |
| 双击 | `double_click(element_token=...)` 或 `click(count=2)` | Excel 双击进入单元格编辑 |
| 输入文字 | `type_text(pid, text=...)` | PostMessage WM_CHAR，不抢焦点 |
| 设置控件值 | `set_value(element_token, value)` | UIA ValuePattern，比 type_text 更可靠（适用于对话框输入框） |
| 快捷键 | `hotkey(pid, keys=["ctrl","h"])` | 组合键用 hotkey 比 press_key+modifiers 更干净 |
| 单键 | `press_key(pid, key="return")` | 单键（Enter/Esc/F2/方向键等） |
| 滚动 | `scroll(pid, direction="down", amount=3)` | WM_VSCROLL，后台送达 |
| 拖拽 | `drag(pid, ...)` | 移动文本框等（注意：可能需 foreground） |

**关键约束**：
- `get_window_state` 的 `pid` 和 `window_id` **都是必填**，缺一个会报错
- `element_token` 来自最近一次 `get_window_state` 快照，**同一回合取即用**，下一次快照会使其失效
- 所有输入工具默认 `delivery_mode:"background"`，不抢前台、不动真实光标
- 只有驱动报 `background_unavailable` 时才对该动作升级到 `foreground`

---

## 第一部分：读取取证

### S1 定位真实路径（PowerShell COM）

Git Bash 下整条 `-Command` 必须用**单引号**包裹；双引号会被 shell 吞掉 `$p`、`$_`：

**PowerPoint**：
```
powershell -NoProfile -Command '$p=New-Object -ComObject PowerPoint.Application; $p.Presentations | ForEach-Object { $_.FullName }'
```

**Word**：
```
powershell -NoProfile -Command '$w=New-Object -ComObject Word.Application; $w.Documents | ForEach-Object { $_.FullName }'
```

**Excel**：
```
powershell -NoProfile -Command '$e=New-Object -ComObject Excel.Application; $e.Workbooks | ForEach-Object { $_.FullName }'
```

判据：输出真实绝对路径。文件系统搜不到（乱码文件名）时，这是唯一可靠来源。

### S2 复制进项目授权目录再程序化读

Office MCP 对项目目录外的路径一律拒绝。仅对**用户已授权读取**的文件，复制进项目内临时目录再读；复制前确认文件敏感性，不得用这一步绕过平台对目录访问的审批。复制后按敏感文件管理：

```
Copy-Item -LiteralPath "<S1得到的路径>" -Destination "<项目目录>\.tmp-doc\<文件名>" -Force
```

- `read_context` 对项目内副本可成功解析文字与几何信息，但拿不到图片渲染
- 需要看图 / 确认格式时不要停留，直接走 S3

### S3 导出先验文件头（关键失败点）

**PowerPoint** — 导出 PNG：
```
powershell -NoProfile -Command '$p=New-Object -ComObject PowerPoint.Application; $pres=$p.Presentations.Item(1); New-Item -ItemType Directory -Force -Path "<输出目录>" | Out-Null; for($i=1;$i -le $pres.Slides.Count;$i++){ $pres.Slides.Item($i).Export("<输出目录>\slide$i.png","PNG",1280,720) }; Get-ChildItem "<输出目录>" | Select-Object Name,Length'
```

**Word** — 导出 PDF：
```
powershell -NoProfile -Command '$w=New-Object -ComObject Word.Application; $doc=$w.Documents.Item(1); $doc.ExportAsFixedFormat("<输出目录>\doc.pdf",17)'
```

**Excel** — 导出 PDF（当前 sheet）：
```
powershell -NoProfile -Command '$e=New-Object -ComObject Excel.Application; $wb=$e.Workbooks.Item(1); $ws=$wb.ActiveSheet; $ws.ExportAsFixedFormat(0,"<输出目录>\sheet.pdf")'
```

导出后**先验文件头**：
```
od -A x -t x1 <输出文件> | head -1
```

| 格式 | 正常魔数 | 密文魔数（实测） |
|---|---|---|
| PNG | `89 50 4e 47` | `1f 44 ...` |
| PDF | `25 50 44 46` (`%PDF`) | `1f 44 ...` 或 `d0 cf 11 e0` 变体 |
| DOCX | `50 4b 03 04` | `1f 44 ...` |

见到密文头即停：导出路线整体作废，走 S4 截图取证。

### S4 降级取证：CUA 窗口截图

1. `list_windows(app="POWERPNT")` （或 `WINWORD` / `EXCEL`）→ 取 `pid` + `window_id`
2. `get_window_state(pid, window_id)` → 返回 UIA 控件树 + 截图
3. 截图精度不够时：先 `zoom(pid, window_id)` 放大，再 `get_window_state` 取高清截图
4. **翻页/切 sheet**：
   - **PPT**：从无障碍树取左侧缩略图窗格的 `element_token` 点选 `click(element_token=...)`；或 `hotkey(pid, keys=["pageDown"])`
   - **Word**：`hotkey(pid, keys=["ctrl","end"])` 到文档末尾；长文档用 `scroll(pid, direction="down", amount=5)` 分段截取
   - **Excel**：`click` 底部 sheet 标签 element_token；或 `hotkey(pid, keys=["ctrl","pageDown"])` 切换 sheet
5. 每页截图核对 `freshness: fresh` 后再读图判读

**注意**：点击可能把 Office 窗口拉到前台，挤掉原本的前台窗口；取证完成后把原窗口激活回去。

### S4.5 截图内容识别（OCR / 视觉读取）

截图拿到后需要提取文字内容：

- **直接读图**：CUA 截图返回后，agent 可直接读图识别文字（多模态能力）
- **提高精度**：小字体区域先用 `zoom` 放大再截图，避免 OCR 误识别
- **表格识别**：Excel 截图中的表格，按行列网格逐单元格读取；注意合并单元格
- **公式识别**：Excel 编辑栏内容可从 UIA 树读取（选中单元格后编辑栏是独立控件），比截图识别更准确
- **结构化提取**：读图时按文档结构输出——标题层级、段落、表格、列表等

---

## 第二部分：完美复刻原文档

### 2.0 路线 0：原文件可读时，直接生成明文副本（首选，零失真）

**先判文件头，再决定是否值得重建**：

```
od -A n -t x1 -N 4 "<原文件>"
# 50 4b 03 04 → 明文 ZIP（.pptx/.docx/.xlsx）
# d0 cf 11 e0 → 明文 OLE（.ppt/.doc/.xls）
# 1f 44 ...    → 透明加密密文 → 只能走 2.1 规格复刻 / 截图兜底
```

文件头正常时，**直接复制文件**即可得到「格式 100% 保留」的明文新文档：

1. 用文件复制（`Copy-Item`），**不要经 Office「另存为」**——Office 写盘可能被 DLP 重新加密
2. 输出到项目工作区，命名 `<原名>-明文副本.<ext>`
3. 三项复验（缺一不可，全部要能失败）：
   - `Get-FileHash -Algorithm MD5` 源与副本相同
   - 副本头仍是 `50 4b 03 04`
   - Office MCP 能直接 `read_slide` / `read_context` 打开（证明未加密、可编辑）
4. 若复制后头变密文（DLP 按路径/进程加密）：换一个输出目录重试一次；仍失败再回退到 2.1 规格复刻
5. 该副本与原件内容等价，仍按敏感文件管理；对外发送需单独授权

> 图像识别/截图只作为**原文件确为密文**时的兜底手段，不要用它替代可读文件的直接复制——识别误差会把「完美复刻」变成「近似复刻」。

### 复刻前精确取证（关键步骤）

**用户明确要求：字体风格/大小/缩进/颜色等均要完美复刻。** 截图识别精度有限，必须先用 `read_slide` / `read_context` 获取精确规格：

#### PPT 精确取证流程

1. **复制原文档到授权目录**（S2 步骤）
2. **`read_slide` 取基础规格**（坐标/填充/描边/文字/字号/表格内容）
3. **解包原文件补全 `read_slide` 拿不到的字段**（未加密时）：把 `.pptx` 当 zip 解到 `D:\tmp`，读 `ppt/slides/slideN.xml` + `_rels` + `ppt/theme/theme1.xml` + `ppt/media/*`
4. **记录锁定元素**：`read_slide` 返回 `locked:true` 的元素（版式背景图）→ 从 `ppt/slideLayouts/slideLayout1.xml` 的 `<p:pic>` 取 rId，再到 rels 找 media 文件，直接用真实图片回填

**必须逐形状记录的字段（缺一项就会复刻走形）**：

| 字段 | 从哪取 | 为什么必须 |
|---|---|---|
| 名称 + 序号 | `<p:cNvPr name>` | 对齐“矩形: 圆角 N / 椭圆 / 标注: 线形 N”，判断真实形状类型 |
| 预设几何 `prst` | `<a:prstGeom prst>` | 区分 **椭圆 vs 圆角矩形**（扁圆最易被误判） |
| 包围盒 | `<a:off>/<a:ext>` | 位置尺寸 |
| **adj 调整值** | `<a:avLst><a:gd name="adj" fmla="val N">` | 同名 `roundRect` 圆角半径可差 10 倍（例：adj=2012 近乎直角，缺省 16667 很圆） |
| 翻转 | `<a:xfrm flipH/flipV>` | 决定箭头、斜线方向 |
| **自定义路径顶点** | `<a:custGeom><a:path>` 的 moveTo/lnTo 点 + 是否 `<a:close/>` | 多边形边数/角度/朝向只能从这里得到；`read_slide` 只说“任意多边形” |
| 描边宽度 | `<a:ln w="...">`（缺省=1pt） | 默认 1pt，别臆测成 1.5pt |
| 字号 | run 的 `<a:rPr sz="...">` | **`read_slide` 的 fontSizePt 是原型值**，常比实际大 0.5–2pt（11 vs 10.5） |
| 文本对齐/锚点 | `<a:pPr algn>` / `<a:bodyPr anchor>` | 左对齐 + 默认内边距 ≈10px，决定文本框要不要外扩 |

**自定义形状重建（多边形/折线）**：MCP 不支持 custGeom，按顶点拆成 `line` 段：
- 像素坐标 = `off + pt * ext / pathDim`
- `line` 只能画“左上→右下”；按方向判定：右下=不翻，左下=`flipH`，右上=`flipV`，左上=`flipH`（再核对）
- 先批量 `addElement`，再 `flipElements {els:[...], axis:"h"|"v"}` 一次性翻转
- 原路径 `open` 且视觉闭合时，往往另有一条“直接连接符”补上缺口，别漏
- 描边色/宽度按原 `<a:ln>` 复制

**箭头/连接符（谁指向谁）**：
- `straightConnector1` + `flipH/flipV` 决定真实起点终点；`tailEnd type="triangle"` 表示**终点带箭头**
- 复刻顺序：按包围盒画 `lineArrow` → 再 `flipElements` 对齐方向；方向错了看起来“指反/没连上”
- 有 `<a:stCxn>/<a:endCxn>` 的，按连接目标的元素位置校验落点

**标注框（borderCallout1）**：
- 蓝底说明框几乎都是 `borderCallout1`（矩形 + 指引尾），不是圆角矩形
- 必须原样复制 `adj1..adj4`（如 `adj1=-893 adj2=-1170 adj3=-41538 adj4=-33509`），尾巴朝向由这四个值决定
- 做法：`setShapeGeometry prst="borderCallout1"` + `setShapeAdjust {adj1..adj4}`；**不要手画指引线**（手画的线与原图不一致）

**表格样式**：
- `read_slide` 不返回单元格填充色；用 COM 读实际色：
  `$tb.Cell($r,1).Shape.Fill.ForeColor.RGB` → **返回 BGR**，需按 `#BBGGRR` 还原
- 斑马纹是两色交替（例：`#CFD5EA` / `#E9EBF5`），不是“浅色 + 白”
- `setTableStyle` 带 `cells:[{row,col},...]` 指定着色范围；同时关掉 `bandRow`，否则内置样式再叠一层

**字体**：
- 演示文稿默认主题字体不是微软雅黑；原稿常用 `微软雅黑`（正文）/`等线`（少量）
- 页面文本没有显式字体时，用 `applyTheme {minorFont:"微软雅黑"}` 一次改全局；或对 run 指定 `fontFamily`
- 主题色板参数要一并给出，避免顺手改了配色

**图片**：
- OOXML 的图片是 `<a:stretch>`（拉伸铺满），而 `put_image` 是 cover 裁切 → **先按目标宽高重采样**（System.Drawing）再插入，避免裁切错位
- 版式背景图按该文件 layout 里 `<a:ext>` 的**实际宽高**重采样，放在基础矩形之上、所有内容之下

**底图来源规则（必须逐文件现取，禁止默认值/复用）**：
- 每页底图只能来自**当前正在处理的这个文件**：`ppt/slideLayouts/slideLayoutN.xml` 的 `<p:pic>` → rId → `_rels` → `ppt/media/<文件>`
- layout/master 没有背景图的页 → 复刻件也**不得**添加任何全页图片（保持白底）
- 严禁把示例文件、上一个项目或「默认底图」套到新文件上；不同文件、不同版式的底图必须各自提取
- 交付时记录来源：`源文件 → slideLayoutN → media 文件名 + md5 + 目标宽高`，便于复核

**版式层对象（最容易漏的一层，必须整层复制）**：
- Ppt 的"界面底子"分两层：**幻灯片对象** + **版式/母版对象**（地图、右/左导航栏、顶部工具条、底部工具栏、图标字形通常在版式里，且常**包在组里**）
- 遍历必须**递归进 group**：COM 里 `Shape.Type -eq 6` → 展开 `GroupItems`；XML 里 `<p:grpSp>` 内继续找 `<p:pic>`/`<p:sp>`；只看顶层会把 1280×671 的地图当成"不存在"
- 判定版式归属：`Slide.CustomLayout`，按版式名分组，同一版式的页共用同一套底图/UI
- 复制顺序：先插入版式 UI（形状/文字）→ 再底图 → 再幻灯片自身对象；每次插入后 `reorderElement dir:"back"` 逐层压底，最后加底衬（或把底衬填充设为 `none`）
- 验收：版式里的图片数、形状数与源文件逐版式对平；"地图在、导航栏/工具栏不在"就是漏了版式层

**层序（z-order）**：严格按原 `read_slide` 列表顺序分批插入：版式底图/UI → 幻灯片图片 → 形状 → 标注 → 文字。`put_image` 永远追加到最上层，所以图片要插在需要压住它的形状之前。

### 2.0-B 用 Office MCP 逐层复刻（源是密文、本机 Office 能打开时；2026-10 实测）

全套 op 配方、换算表和踩坑清单见 `references/office-mcp-edit-ops.md`。主流程：

1. **COM 只读 dump 源**：幻灯片 + `CustomLayout`（递归进 `Type=6` 组），记录 `AutoShapeType / 包围盒 / 旋转 / 翻转 / 填充 / 线条 / 文字 runs / Adjustments`；自由曲线另取 `Shape.Nodes`。
2. **同一套 dump 成品**，按「位置+尺寸+文本」最近邻匹配，产出「缺失 / 多余 / 类型不符 / 位置偏差」四类清单。
3. **MCP 批量修复**：`apply_ops`（每次 ≤50 op，带 `expectedRevision`+`operationId`）→ `put_image`（替换用 `elementId`，新增用 `frame`）→ `save_document`。
4. **PowerPoint 实开 + 逐页并排截图**验收（只过 MCP 读回不算）。

九条硬规则（每条都能失败）：

| # | 规则 | 反例后果 |
|---|---|---|
| 1 | 组内子对象 `Left/Top` 已是**幻灯片绝对坐标**，dump 时不要再加 `group.Left` | 子对象整体位移一倍（本套第 4/8/9 页面板、图片、复选组全错位） |
| 2 | 层序套路：底图/顶栏→`front` → 插版式 UI → **顶栏→`back`、底图→`back`**（最后 back 的最靠底）→ 原对象按原序逐个→`front` | 顶栏被不透明地图盖住（只剩文字、青色渐变条消失）；版式按钮被底图压住 |
| 3 | 圆角必按源 `adj` 设（比例×100000），默认 16667 明显过圆 | 大面板四角像胶囊（本套 18 处） |
| 4 | `snip2SameRect` + `adj=50000` 会让 **PowerPoint 打不开文件**（MCP 能读、XML 合法、unzip 也过） | 文件看似正常但打不开；切角小条保持 `rect` |
| 5 | 标注用 `borderCallout1` + 原 `adj1–adj4`（比例×100000） | 蓝底标注没有尾巴，和原稿对不上 |
| 6 | 透明图片要取剪贴板 `Art::GVML ClipFormat`（ZIP 内 `clipboard/media/image1.png`） | `Clipboard.GetImage()`/PNG 压白底 → logo 后面出现白方块 |
| 7 | custGeom 自由曲线 MCP 建不了：节点渲染成透明 PNG 插入，并写进差异说明 | 拆成几百条 line，对象数爆炸且不可编辑 |
| 8 | 小控件源里常是 `wrap="none"`：`setTextBodyProps {wrap:false}` | 「保存」被拆成「保/存」并报文本溢出 |
| 9 | 验收对象数按**组展开**后对平；颜色差异以对象模型为准（原稿窗口带 DLP 水印，截图整体偏亮） | 拿被水印漂白的截图当色差，或漏掉整层对象 |

**保存与锁**：PowerPoint 打开着目标文件时 `save_document` 必失败 → 先关窗再存；新建对象的 ID 当次拿不到，`setTransform/groupElements` 要拆下一批。

### 2.0-C Excel：COM 全量 dump → ExcelJS 重建（Office MCP 不支持 xlsx；2026-10-23 实测）

**两条被实测否掉的路，不要浪费时间**：
- Office MCP `read_context` 只吃 PPTX，传 `.xlsx` 直接返回 `QODER_OFFICE_FILE_TYPE_INVALID`；
- Excel COM `Workbook.SaveAs(..., 51)` 的产物仍是密文（头 `31 e7 cc 13`），与 PPT 导出一致——授权进程写盘必被 DLP 重新加密。

**可行链路**：Excel（授权进程）只读打开 → COM 全量 dump → Node + ExcelJS 重建 → COM 逐格比对验收。三个脚本已随技能分发：`scripts/xlsx-dump.ps1 -Src -Out`、`scripts/xlsx-rebuild.cjs <dump.json> <out.xlsx> [out.csv]`、`scripts/xlsx-verify.ps1 -Src -Out`。重建产物由非授权进程写出，实测是明文 `50 4b 03 04`；打开查看不写盘，不会重新加密。中文路径可直接作参数传入（Git Bash → PowerShell 实测无损）。

**COM dump 必采字段**：

| 字段 | 取法 | 坑 |
|---|---|---|
| 值 / 公式 / 显示文本 | `UsedRange.Value2`、`.Formula`、`cell.Text` | 区域整取返回 `object[,]`，单格返回标量，取值前先判类型 |
| 数字格式 | **逐格** `cell.NumberFormat` | `Range.NumberFormat` 在格式混杂时整块返回 `null` |
| 合并区 | `cell.MergeArea.Address` | 未合并的格子也返回自身地址（如 `$E$3`），只有含 `:` 的才是真合并 |
| 字体 / 填充 | `cell.Font.*`、`cell.Interior.Color` | 颜色是 **BGR**，转 ARGB 要换位 |
| 对齐 / 边框 | `HorizontalAlignment` / `Borders.Item(7/10/8/9)` | 左7 右10 上8 下9；`1`=实线，`-4142`=无 |
| 列宽 / 行高 | `ColumnWidth` / `RowHeight` | 列宽单位是字符宽度，不是像素 |

**ExcelJS 重建的四个坑**（每条都实测踩过）：
1. `mergeCells()` 让子格与主格**共享同一个 style 对象**，之后给子格设样式会连带改掉主格（实例：A1 大标题加粗被末位子格覆盖）→ 每个合并子格先 `cell.style = {}` 再设样式。
2. `column.width` 要比 Excel 的 `ColumnWidth` 多 **+0.625**（默认字体等线 11、MDW 8px、5px padding），否则每列都窄 0.625。
3. 日期保留序列号 + `numFmt: "yyyy/m/d"`，百分比用 `numFmt: "0%"`；公式写 `{ formula, result }` 并设 `workbook.calcProperties.fullCalcOnLoad = true`。
4. 合并区只给主格写值。

**验收（缺一不可）**：COM 同时打开原件与成品，逐格断言 Value2 / Text / 字体 / 填充 / 边框 / 合并集合 / 列宽 / 行高全等；再真实打开成品截图核对版式；最后复查成品文件头仍是 `50 4b 03 04`。

#### Word/Excel 精确取证

- **Word**：`read_context` 获取段落样式、表格结构、字体规格
- **Excel**：`read_context` 获取单元格格式、数字格式、列宽、合并范围；填充色同样用 COM `Interior.Color`（BGR）核对

### 复刻流程

#### 1. 内容提取（从截图 + read_slide 结合）

逐页/逐表读取截图，**对照 read_slide 精确规格**，提取以下结构化信息：

**Word 文档**：
- 标题层级（H1/H2/H3）
- 正文段落与缩进
- 表格（行列数、合并单元格、内容）
- 图片位置与大小描述
- 页眉页脚内容
- 页码与分节信息
- **字体族、字号、颜色（以 read_context 返回为准，截图仅辅助）**

**Excel 工作簿**：
- 每个 sheet 名称
- 表头（列名）
- 数据行内容
- 合并单元格范围
- 数字格式（货币、百分比、日期）
- 列宽近似比例
- 公式（优先从 UIA 编辑栏读取，截图识别兜底）
- 条件格式与颜色标记

**PowerPoint 演示文稿**：
- 每页幻灯片布局（标题+内容、空白、两栏等）
- 文本框位置与内容（**以 read_slide 坐标为准**）
- 图片/图表位置与描述
- **配色方案（以 read_slide 返回的 fill/textColor/strokeColor 为准）**
- 动画/切换效果（截图无法获取，需从 UIA 树或手动记录）
- **锁定元素清单**（背景图等无法复刻的项）

#### 2. 用 office-docs / pptx 技能生成副本

**Word 复刻**（调用 office-docs 技能）：
```
使用 office-docs 技能的 docx 生成能力：
- 按提取的标题层级创建 Heading 样式
- 按原文表格结构创建 Table（含合并单元格）
- 段落样式（字体族、字号、颜色、行距）严格按 read_context 规格
- 页眉页脚按原文内容设置
- 输出 .docx 到项目目录
```

**Excel 复刻**（调用 office-docs 技能）：
```
使用 office-docs 技能的 xlsx 生成能力：
- 按 sheet 创建工作表
- 写入表头和数据
- 设置列宽（按 read_context 返回的列宽规格）
- 合并单元格按原范围
- 数字格式匹配原表
- 输出 .xlsx 到项目目录
```

**PPT 复刻**（调用 pptx 技能）：
```
使用 pptx 技能的演示文稿生成能力：
- 按 read_slide 精确坐标逐页创建幻灯片
- 文本框位置、大小、字体族、字号、颜色严格按规格
- 填充色、边框色、文字颜色用 read_slide 返回的十六进制值
- 布局类型匹配（标题页、内容页等）
- 输出 .pptx 到项目目录
```

#### 3. 复刻验收

逐页**并排截图对比**，按以下清单逐项断言（任一不满足即回到规格提取补数据）：

| 验收项 | 判据 |
|---|---|
| 页数/表格行列 | 与原文件完全一致 |
| 位置尺寸 | 每个元素包围盒误差 ≤2px |
| 形状几何 | `prst` 一致；roundRect 的 adj 一致；custGeom 按顶点逐段对齐（边数、角度、开闭） |
| 箭头/连接线 | 起点、终点、箭头端与原图一致（方向反了就是不合格） |
| 标注引线 | borderCallout1 的 adj1–adj4 与原值一致，尾巴落点指向同一元素 |
| 颜色 | 填充/描边/文字色取原值（表格斑马纹两色都要对） |
| 字号字体 | 以 XML run sz 与 typeface 为准，不采信 read_slide 的原型字号 |
| 逐 run 样式 | 同一文本框内每段/每 run 的颜色、字号、加粗分别核对（红标题、白正文这种混排） |
| 小控件/按钮 | 按版式里的真实控件形状与尺寸复刻；底衬图片（patch）与控件分两层，不能拿底衬尺寸当按钮 |
| 底图来源 | 每页底图可追溯到**本文件** layout 的 media（记录文件名+md5+宽高）；源页无底图的页，复刻页必须无全页图片 |
| 图片 | 原 media 图片按同一包围盒铺满，无裁切错位 |
| 层序 | 背景图在下、形状居中、文字在上；遮挡关系与原图一致 |

- 标注确实无法还原的项（动画/切换、被 DLP 拦截的导出产物、缺失字体），写明原因，不写「近似」了事
- 复刻完成后**逐页双击缩略图实看一遍**，不能只看 read_slide 的数字

---

## 第三部分：通过 CUA 鼠标键盘编辑原文档

在已打开的加密文档中，通过 CUA 驱动直接操作鼠标键盘完成编辑。

### 通用原则

- **先 `get_window_state(pid, window_id)` 拿控件树快照**，优先用 `element_token` 操作
- 元素不可寻址（文档编辑区是自绘表面）时用 **`x,y` + 默认 `background`**
- **`type_text`** 走 `PostMessage(WM_CHAR)`，逐字符送达，不抢焦点
- **`hotkey`** 发送组合快捷键（如 `hotkey(pid, keys=["ctrl","h"])` = Ctrl+H）
- **`press_key`** 发送单键（Enter/Esc/F2/方向键等）
- **`set_value(element_token, value)`** 设置对话框输入框的值（比 type_text 更可靠）
- 编辑前**先截图记录当前状态**，便于回滚对照

### Word 编辑操作

| 操作 | CUA 方法 |
|---|---|
| 定位到指定文字 | `hotkey(pid, ["ctrl","h"])` 打开替换对话框 → `set_value` 或 `type_text` 输入查找内容 → click「查找下一处」 |
| 选中文本 | 三击选中段落（`click(count=3)`）；或 `hotkey(pid, ["shift","end"])` 选到行尾；或 `hotkey(pid, ["ctrl","a"])` 全选 |
| 替换文字 | 先定位 → 选中 → `type_text` 输入新内容（自动替换选中） |
| 修改格式 | 选中文字 → `hotkey(pid, ["ctrl","d"])` 打开字体对话框 → `set_value` / click 操作控件 |
| 插入表格 | Alt 导航到插入选项卡 → 表格 → 选择行列数（通过 `click` 菜单项 element_token） |
| 删除段落 | 定位到段落 → `click(count=3)` 选中 → `press_key(pid, key="delete")` |
| 导航到页首 | `hotkey(pid, ["ctrl","home"])` |
| 导航到页尾 | `hotkey(pid, ["ctrl","end"])` |
| 翻页 | `press_key(pid, key="pageup")` / `press_key(pid, key="pagedown")` |
| 打开页眉页脚 | 双击页眉/页脚区域，或 Alt 导航到插入 → 页眉 |
| 撤销 | `hotkey(pid, ["ctrl","z"])` |
| 保存 | `hotkey(pid, ["ctrl","s"])`（保存前确认用户授权） |

**Word 编辑示例 — 替换指定文字**：
```
1. list_windows(app="WINWORD") → 取 pid + window_id
2. get_window_state(pid, window_id) → 取编辑区 element_token 或坐标
3. hotkey(pid, keys=["ctrl","h"])（打开查找替换对话框）
4. get_window_state → 取查找输入框 element_token
5. set_value(element_token=查找框, value="原文字")
6. get_window_state → 取替换输入框 element_token
7. set_value(element_token=替换框, value="新文字")
8. click "全部替换" 按钮 element_token
9. press_key(pid, key="escape")（关闭对话框）
10. get_window_state 截图验证替换结果
```

### Excel 编辑操作

| 操作 | CUA 方法 |
|---|---|
| 选中单元格 | `click` 单元格坐标；或 `press_key` 方向键导航；或 `hotkey(pid, ["ctrl","g"])` 输入单元格地址 |
| 编辑单元格 | `double_click` 单元格（或 `press_key(pid, key="f2")`）→ `type_text` 新内容 → `press_key(pid, key="return")` |
| 修改公式 | 选中单元格 → `press_key(pid, key="f2")` 进入编辑 → 修改公式内容 → `press_key(pid, key="return")` |
| 从编辑栏读/写公式 | 选中单元格后，编辑栏是独立 UIA 控件 → `get_window_state` 取 element_token → `set_value` 读写 |
| 批量填充 | 选中区域 → `type_text` 内容 → `hotkey(pid, ["ctrl","enter"])` 批量填入 |
| 插入行/列 | `click(button="right")` 行号/列标 → `click`「插入」菜单项 |
| 删除行/列 | 选中行号/列标 → `hotkey(pid, ["ctrl","-"])` 或右键菜单 |
| 自动列宽 | 双击列标右边框（`double_click` 列标分隔线坐标） |
| 切换 sheet | `click` 底部 sheet 标签 element_token；或 `hotkey(pid, ["ctrl","pageDown"])` |
| 设置格式 | 选中区域 → `hotkey(pid, ["ctrl","1"])` 打开格式对话框 → `set_value` / `click` 操作控件 |
| 复制粘贴 | `hotkey(pid, ["ctrl","c"])` → 导航到目标 → `hotkey(pid, ["ctrl","v"])` |
| 筛选 | `hotkey(pid, ["ctrl","shift","l"])` 切换筛选 |
| 撤销 | `hotkey(pid, ["ctrl","z"])` |
| 保存 | `hotkey(pid, ["ctrl","s"])`（保存前确认用户授权） |

**Excel 编辑示例 — 修改指定单元格**：
```
1. list_windows(app="EXCEL") → 取 pid + window_id
2. get_window_state(pid, window_id) → 确认当前 sheet 和视图
3. hotkey(pid, keys=["ctrl","g"])（打开定位对话框）
4. get_window_state → 取定位输入框 element_token
5. set_value(element_token=定位框, value="B5")
6. press_key(pid, key="return")（跳转到 B5）
7. press_key(pid, key="f2")（进入编辑模式）
8. hotkey(pid, keys=["ctrl","a"])（全选单元格内容）
9. type_text(pid, text="新值")（输入新内容）
10. press_key(pid, key="return")（确认）
11. get_window_state 截图验证修改结果
```

### PowerPoint 编辑操作

| 操作 | CUA 方法 |
|---|---|
| 切换幻灯片 | `click` 左侧缩略图 element_token；或 `press_key(pid, key="pagedown")` / `press_key(pid, key="pageup")` |
| 编辑文本框 | `click` 文本框 → 进入编辑 → `type_text` 修改 |
| 替换文字 | `hotkey(pid, ["ctrl","h"])` 打开替换 → `set_value` 输入查找/替换内容 |
| 插入新页 | `hotkey(pid, ["ctrl","m"])` 或 `click(button="right")` 缩略图 → `click`「新建幻灯片」 |
| 删除当前页 | `click` 选中缩略图 → `press_key(pid, key="delete")` |
| 移动文本框 | `click` 选中 → `press_key` 方向键微调；或 `drag` 到新位置 |
| 修改字体/颜色 | 选中文本 → `click` 开始选项卡控件的 element_token（字体下拉、颜色按钮等） |
| 复制粘贴元素 | `hotkey(pid, ["ctrl","c"])` → `hotkey(pid, ["ctrl","v"])` |
| 对齐/分布 | 选中多个形状 → `click` 格式选项卡 → 对齐/分布控件 |
| 进入母版视图 | Alt 导航到 视图 → 幻灯片母版 |
| 撤销 | `hotkey(pid, ["ctrl","z"])` |
| 保存 | `hotkey(pid, ["ctrl","s"])`（保存前确认用户授权） |

**PPT 编辑示例 — 替换所有幻灯片中的指定文字**：
```
1. list_windows(app="POWERPNT") → 取 pid + window_id
2. get_window_state(pid, window_id) → 确认当前幻灯片
3. hotkey(pid, keys=["ctrl","h"])（打开替换对话框）
4. get_window_state → 取查找输入框 element_token
5. set_value(element_token=查找框, value="旧公司名")
6. get_window_state → 取替换输入框 element_token
7. set_value(element_token=替换框, value="新公司名")
8. click "全部替换" 按钮 element_token
9. press_key(pid, key="escape")（关闭对话框）
10. 逐页 get_window_state 截图验证替换结果
```

### 编辑操作的安全纪律

1. **编辑前截图**：`get_window_state(pid, window_id)` 记录修改前的完整状态，作为回滚依据
2. **编辑后截图**：再次 `get_window_state` 验证修改已正确应用
3. **`hotkey(pid, ["ctrl","z"])` 回滚**：操作失误时立即撤销
4. **不做不可逆操作**：除非用户明确要求（如「保存并关闭」）
5. **保存**：`hotkey(pid, ["ctrl","s"])`；另存为：`press_key(pid, key="f12")`。保存前确认用户授权
6. **敏感内容**：编辑过程中看到的文档内容不写入记忆或日志
7. **操作失败恢复**：
   - `background_unavailable` → 对该动作升级到 `delivery_mode:"foreground"`，完成后还原前台
   - `stale_element_token` → 重新 `get_window_state` 获取新快照
   - 操作后 UI 未响应 → `get_window_state(since=...)` 检查是否变化，无变化则重试一次

---

## 第四部分：加密自测夹具（生成加密 Word/PDF 并验证解密）

没有现成密文样本、或改完技能要回归时，自造一个**中性内容**的加密夹具。实测环境：某企业透明加密（DLP）客户端 + Office 2016（32 位）+ Acrobat Reader DC（2026-10-23）。

### 生成（明文 → 授权应用写盘 = 密文）

使用 PowerShell 7，不调整 Windows PowerShell 5.1 的执行策略；脚本通过 `#requires` 拒绝旧宿主：

```powershell
$Pwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
$Test = Join-Path $HOME '.qoder/skills-library/encrypted-office-visual-inspection/scripts/fixture-selftest.ps1'
& $Pwsh -NoProfile -File $Test -WithWord -WorkDir 'D:\tmp\dlp-fixture-selftest'
```

- 默认保留 Excel 4 项；`-WithWord` 共 9 项，Word 在**同一个进程**里完成打开 → SaveAs2 → PDF 导出 → 重开 → 全文对比 → 退出检查，不再拆成多个会话。
- COM 路径在赋值处声明 `[string]$path = Join-Path ...`；文件头用文件流读取 4 字节，不使用 PowerShell 7 不支持的 `Get-Content -Encoding Byte`。
- 每次在指定根目录下新建唯一子目录，不删除或覆盖旧文件。进度含 `RUNTIME`、`WORD_PID` 和 `STEP`，超时由调用方监督，只回收核实归属且获准终止的测试进程。
- 2026-10-26：pwsh 7.6.5 下完整流程连续 3 轮通过（约 13–15 秒/轮），独立文本断言变异退出 1；旧环境根因未证实，不能再写「同会话多步必挂」或「分步必过」。
- 密文头值可能变化，非 ZIP/PDF 头本身不证明加密；结合自造源文档、应用保存、授权回读一致与非授权解析失败共同核验。本自测只验证 PDF 导出落盘，PDF 内容渲染另走下方截图验收。

### 解密验证（正例 + 负对照，缺一不可）

| 对象 | 正例 | 负对照 |
|---|---|---|
| docx | Word COM 打开密文本读 `Content.Text`，与明文文档文本 `-ceq` 比较（实测 87 字符全等） | `office.js read-docx 密文本` 必须报"文件头非 zip" |
| pdf | Acrobat 打开密文 PDF，CUA 截图确认内容正常渲染（本机可见 DLP 水印） | `head -c 4` 必须不是 `%PDF` |

只跑正例是假绿：明文文件同样能被 Word 打开，必须同时证明磁盘上是密文。

### 坑

| 症状 | 根因 | 处法 |
|---|---|---|
| Word 保存卡在 `SaveAs2` | 历史失败来自 PS5 自测，不能归因为「同会话多步」；PS7 同会话多步及原始/强类型路径对照均通过，PS5 的原始原因仍未证实 | 使用上述 pwsh 7 入口与显式 `[string]` 路径，保留逐步日志、超时和精确 PID 归属；参数绑定案例及本轮对照见 `intermittent-hang-ab-triage` 技能的 word-com-saveas 参考（该技能未随本包发布） |
| `$word.Quit()` 返回后进程仍在 | 返回不保证进程已经退出；残留不能直接认定为挂起原因，也不能仅凭 `/Automation` 判归属 | 关闭并释放 Range/Document/Documents，再 Quit 和释放 Application；对本轮登记的进程调用有期限的 WaitForExit，不按镜像名清理其他实例 |
| 自测脚本改坏判据仍全绿 | 变异改在"造夹具"一侧，比对基准跟着一起变 | 变异只动比对端（如换读取单元格），确认断言能判红且退出码非 0 才算自测有效 |
| 自带 `.ps1` 报"字符串缺少终止符" | PS 5.1 把无 BOM 的 UTF-8 按 ANSI 读，中文注释/串吞掉引号 | 技能内 `.ps1` 一律 ASCII；中文断言改成两份文本 `-ceq` 比较 |
| PS 里 `Contains('中文')` 恒为 False | 同上（编码失真，不是内容不对） | 同上 |
| Word COM 打开 PDF 返回 `$null` | PDF 需转换确认，无头模式被取消 | 用真实 PDF 阅读器（Acrobat/Edge）打开 + CUA 截图验证 |
| 夹具用完留在磁盘 | 测试文件可能含业务词 | 内容用中性文本，放 `D:\tmp\`，验证完删除 |

> 官方口径（2026-10-23 查证）：无人值守的 Office COM 自动化不是受支持场景；静默卡住的两类通因是「没有用户可点的对话框」与「COM 对象未释放留下占资源的隐藏进程」；调用被 callee 拒绝（`0x80010001 RPC_E_CALL_REJECTED`）时标准做法是 IOleMessageFilter 或退避重试，而不是改脚本结构绕。

## 常见坑

| 症状 | 根因 | 处法 |
|---|---|---|
| PowerShell 报「无法将=New-Object识别为 cmdlet」 | Git Bash 双引号吞 `$p`/`$_` | 整条 -Command 改单引号 |
| read_context 报 outside authorized task directories | 授权目录=任务工作目录 | 复制进项目子目录再读 |
| 导出文件打不开、文件头 `1f44` | 透明加密按进程授权，落盘产物即密文 | 放弃导出，走 S4 窗口截图 |
| find 搜不到已打开的文档 | 微信传输文件名乱码 | S1 用 COM FullName 直取 |
| 其他窗口截图突然失败 | CUA 点击激活 Office 抢了前台 | 完事激活回原窗口 |
| Excel type_text 丢字符 | 编辑区是 canvas，PostMessage 偶有丢失 | 先 F2 进入编辑模式再输入；或用 set_value |
| Word 替换对话框找不到 | 对话框可能被文档窗口遮挡 | get_window_state 取完整控件树，找对话框 element_token |
| 复刻文档格式偏差大 | 截图识别精度有限 | **必须先 read_slide/read_context 取精确规格**，截图仅辅助 |
| get_window_state 报错缺参数 | pid 和 window_id 都必填 | list_windows 取到后两个都传 |
| element_token 操作报 stale | 已被下一次 get_window_state 快照替换 | 重新 get_window_state 取新 token |
| 小字体截图看不清 | 默认截图分辨率不够 | 先 zoom 放大再截图 |
| Office 对话框 set_value 失败 | 某些控件不支持 ValuePattern | 降级 type_text + hotkey 全选覆盖 |
| read_slide 返回 `locked:true` | 元素受母版/布局保护（如背景图） | 从 `ppt/slideLayouts` 的 rels 找 media 真实图片，按目标尺寸重采样后 `put_image` 回填 |
| 复刻表格表头颜色不对 | apply_ops 的 setTableStyle 需指定 cells 参数 | 用 `cells:[{row:0,col:0},{row:0,col:1},...]` 逐单元格设置 shadingColor |
| apply_ops 报 QODER_OFFICE_OPERATION_FAILED | 文件被 Office 进程锁定 | 先关闭 PowerPoint/Word/Excel 再操作 |
| 多边形边数/朝向不对 | 只看到“任意多边形”，没取 custGeom 顶点 | 解包读 `<a:custGeom>` 顶点，按线段重建，逐段判 flipH/flipV |
| 箭头指反 / 没连上目标 | 忽略连接符的 flipH/flipV 与 tailEnd | 先画 `lineArrow` 再 `flipElements`；tailEnd=箭头在终点 |
| 引线尾巴方向不对 | 用圆角矩形+手画线代替 `borderCallout1` | `setShapeGeometry prst="borderCallout1"` + 原样 `adj1..adj4` |
| 扁圆被做成圆角矩形 | 只看形状名，没看 `prst` | 按 `prst` 判定 ellipse/roundRect；roundRect 还要看 adj |
| 圆角大小差很多 | 漏读 `<a:avLst><a:gd name="adj">` | adj=2012 近直角，缺省 16667 很圆，按原值 `setShapeAdjust` |
| 表格斑马纹不一致 | 只看截图/凭经验用了「浅色+白」 | COM 读 `Cell.Shape.Fill.ForeColor.RGB`（BGR），两色交替照抄 |
| 字号整体偏大 | 信了 read_slide 的 fontSizePt（原型值） | 以 XML run `sz` 为准（常见 10.5 vs 11） |
| 字体不像原稿 | 默认主题字体不是微软雅黑 | `applyTheme {minorFont:"微软雅黑"}` 或 run 级 fontFamily |
| 复刻图片被裁切/变形 | OOXML 是 stretch，put_image 是 cover | 先按目标宽高重采样再插入 |
| CUA 单击缩略图不跳页 | 单击只选中，回车可能新建页 | 用 `double_click` 缩略图切页 |
| 中文名/空格文件找不到 | 路径里空格或全半角差异 | 用 `Get-ChildItem -Filter "*关键词*"` 取 FullName，不手拼路径 |
| 直接复制后打不开/头变 `1f44` | DLP 对写盘文件强制加密 | 换输出目录重试一次；仍失败回退到规格复刻，并记录该路径不可用 |
| 按钮比原图大一圈 | 把版式底衬图（如 117×33 的深色 patch）当成了按钮 | 按钮本体是版式里的独立形状（如 roundRect 60×26）；底衬图与控件分两层复刻 |
| 局部文字颜色漏掉 | 只按整框取色，没逐 run 读 | 同一文本框内逐 run 读颜色（实例：「1.1 版本更改」标题是 `#FF0000`，正文白） |
| 组内对象整体偏移一倍 | dump 时给 `GroupItems` 子对象又加了 `group.Left` | 子对象 `Left/Top` 已是绝对坐标，直接用 |
| 图片背后出现白方块 | 用 `Clipboard.GetImage()` / PNG 剪贴板取图，alpha 被压白 | 取 `Art::GVML ClipFormat`（ZIP）里的 `clipboard/media/image1.png` |
| 写入后 PowerPoint 打不开（MCP 能读） | `snip2SameRect` + `adj=50000` 组合 | 该小条保持 `rect`，差异写进交付说明 |
| 保存报 `QODER_OFFICE_OPERATION_FAILED` | PowerPoint 正打开目标文件 | 先关窗再 `save_document`，重开后再验收 |

---

## 收尾

- 临时副本（S2/S3 产物）用完即删；只保留取证截图和复刻文档
- 文档内容敏感：截图路径可入汇报，内容要点按需脱敏
- 编辑操作完成后保存（Ctrl+S），保存前确认用户授权
- 复刻文档放项目目录，标注「基于加密文档截图复刻，格式近似」
