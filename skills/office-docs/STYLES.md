# office-docs 样式层（office-styles.js）

让生成的 Word **默认就好看**：主题化排版 + 目录域 + 页码 + 表格底纹；还能**从图片识别配色 → 生成主题**。与 `scripts/office.js` 分开，互不覆盖；共用技能内 `node_modules`。

```bash
node ~/.qoder/skills-library/office-docs/scripts/office-styles.js themes      # 看主题与排版参数
node ~/.qoder/skills-library/office-docs/scripts/office-styles.js render \
     --md 报告.md -o 报告.docx --theme business --title "季度报告" --header "内部资料"
cat 报告.md | node ~/.qoder/skills-library/office-docs/scripts/office-styles.js render \
     --md - -o 报告.docx --theme gongwen --chapter-break            # 一级标题各起一页
node ~/.qoder/skills-library/office-docs/scripts/office-styles.js --selftest # 76 条断言
```

## 三套主题

| 键 | 适用 | 关键参数 |
|---|---|---|
| `gongwen` | 公文 / 红头 / 报送材料 | A4 边距上 3.7 下 3.5 左 2.8 右 2.6 cm；正文 3 号仿宋、行距 30 磅固定、首行缩进 2 字；标题用黑体 / 楷体，序号自动补「一、／（一）／1.」 |
| `business` | 汇报 / 方案 / 手册 | 边距 2.54 / 3.18 cm；等线 11pt、1.5 倍行距；标题微软雅黑 18/14/12pt 配深蓝；表头深蓝底白字 + 隔行浅底 |
| `minimal` | 说明书 / 长文阅读 | 四边 2.5 cm；等线 11pt、1.375 倍行距；标题灰黑无衬线强调；表格只留细线，无底纹 |

`gongwen` 的数字有出处：**GB/T 9704-2012《党政机关公文格式》**（页边距、3 号仿宋正文、行距、"一、／（一）／1." 层级序号）。其余两套是通用办公排版习惯值，不是编造的"规范"。

## 从图片提取主题（extract-theme）

给一张截图 / 品牌页 / LOGO，量化出主色板并产出一份**与内置主题同形**的 JSON，直接喂 `render`：

```bash
node ~/.qoder/skills-library/office-docs/scripts/office-styles.js extract-theme \
     --from 品牌图.png --name acme -o theme.json --verbose
node ~/.qoder/skills-library/office-docs/scripts/office-styles.js render \
     --md 报告.md -o 报告.docx --theme-json theme.json --title "季度报告"
```

- **取色**：每通道降 4 bit 分桶 → 按覆盖排序 → RGB 距离 45 以内贪心合并（JPEG 噪声并得掉、邻近色相吃不掉）。超过 20 万像素时按步长采样，4K 图约 2 秒。
- **角色分配**：背景＝覆盖最大的色；主色＝与背景拉开 50 以上、且有彩度优先的最大色；强调色＝剩余里"彩度×√覆盖"最高的；文字色＝最深的可用色。图里没有彩度色时**不编造**（强调色记 `null` 或取图里的中性色），层级就靠字号与粗细。
- **派生**：表头底纹＝主色、隔行底色＝主色提亮 94%、边框＝主色提亮 70%，全部同色系加减明度，不引入图里没有的第三种色相。
- **可读性兜底（WCAG 2.1 AA）**：普通文字 4.5:1、大字 3:1。表头这种"底色已定"的成对关系，先挑白字 / 深黑里对比更高的一侧；两边都不达标（中灰底是死区）就**改底纹明度**而不是硬留白字。标题与正文一律按**白底纸面**校准（主题不改页面背景），所以浅灰主色会被压深到能读，绝不产出"浅灰底配白字"。改了什么记在 `meta.readabilityFixes` 里，`--verbose` 会打出来。
- **不静默出怪主题**：以下情况**报错并退码 2**（`0` 成功 / `1` 运行失败 / `2` 用法或前置错误）——文件不存在、文件头不是 png/jpeg/gif/bmp/tiff/webp、全透明 PNG、纯色或单色渐变（分辨不出第 2 个颜色）、小于 8×8。
- 不带 `-o` 时 stdout 只有 JSON（方便管道），诊断信息走 stderr。`--theme-json` 优先于 `--theme`；只写颜色的半成品主题会合并到 `business` 骨架上。

## 目录（TOC）

写进文档的是 **TOC 域**，不是手打目录 —— 页码要 Word / WPS 打开后「更新目录」或按 <kbd>F9</kbd> 才生成。**这是 OOXML 的固有机制**：没有哪个生成器能离线算出准确页码（页码取决于渲染时的字体与分页）。
标题一律使用真正的 `HeadingLevel`（并在 `styles.xml` 里登记 `outlineLevel`），所以正文里不会再出现第二份"手打的目录"，目录也能自动收录。

## 支持的 Markdown 结构

`#`–`####`（四级并入三级）、段落、`**粗体**`、`` `行内代码` ``、`-`/`*` 无序、`1.` 有序、`| 表格 |`（首行当表头）、`![说明](图.png "宽度")` 插图、`---` 分隔线。
不支持：链接、代码块围栏、HTML 内联、脚注 —— 这些按普通文本进去，需要时另提需求。

## 验证边界（重要）

`--selftest` 的 76 条断言查的是**生成物的 XML 事实**与**取色算法的可失败性质**：

- 原有 32 条（三套内置主题各 9 条：目录域存在、用的是真 Heading 样式、页边距按主题落进 `sectPr`、表格有底纹、页码页脚挂上、内容读得回、首行缩进按主题、settings 可读、zip 头合法；加 5 条原有负对照）——**一条不许退化**；
- 取色正例 11 条：程序生成的已知色块 PNG，主色 / 强调色与输入色的 RGB 距离 ≤ 24、背景判为近白、表头对比 ≥ 4.5、隔行与主色同色系且比表头浅、正文与标题对白底不越 AA、`--verbose` 打得出色板、不带 `-o` 时 stdout 是可直接管道的纯 JSON；
- 端到端 7 条：提取出的 JSON 喂 `render` 后，解包 `word/document.xml` 断言表头底纹 / 表头文字 / 二级标题 / 正文 / 隔行色**真的写进了 `w:shd` 与 `w:color`**（不是只存了 JSON）；其中一条前置要求这些槽位与 `business` 默认值不同色，避免撞色假绿；
- 中性灰输入 3 条：全图无彩度时强调色不编造、派生的五个槽位全部保持中性；
- 主色过亮专项 4 条：浅蓝主色 → 表头换深字、标题同色系压深到 AA 且色相不漂、`readabilityFixes` 留痕；
- 对比度函数 6 条独立断言：黑白 = 21:1、浅灰底白字判为不达标并能被推到达标、中灰底白字落在 3.0~4.5 之间（证明两个阈值没写反）、中灰死区改的是底纹、亮黄底自动换深字；
- 负对照 10 条（**真实子进程**跑，校验退出码 = 2 且提示可行动）：改名 `.png` 的文本、纯色图、全透明 PNG、不存在的路径、4×4 极小图、漏 `--from`、非法 JSON、色值非 6 位 hex、JSON 里无样式字段、theme-json 文件不存在；
- 隔离 3 条：半成品主题合并成功、合并不污染内置 `THEMES`、`--theme` 与 `--theme-json` 两条路径不串。

以上都**不等于肉眼验收**：本机没有安装 Office / WPS，无法渲染截图，样式好不好看没人确认过。第一次用某个提取主题时请打开成品看一眼版式，需要微调就把结论写回这里。
