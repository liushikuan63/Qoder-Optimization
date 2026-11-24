---
name: verify-ui-in-browser
description: "前台真实运行验收：网页/客户端/小程序/小游戏/App 必须真跑、实际操作并截图比对，单测/构建不算。网页用真实浏览器走完整路径与负向用例，SPA fallback 核 content-type；小程序/小游戏用开发者工具，App 用模拟器/真机，客户端截窗口。含四向内缩、布局塌陷、图标缺字（tofu/方框叉＝静态资源被答成 200 text/html）、报错刷屏的可失败判据与量测 harness。触发：前端验收、UI 验证、打开界面、dev server、playwright、矮屏、滚动条、贴边、内缩、布局塌陷、图标不显示。"
---

# 前台真实运行验收

## 概述

前台功能（网页 / 客户端 / 小程序 / 小游戏 / App）不能只靠单测和构建验收 —— 单测覆盖不到真实交互（大量能力门禁与条件渲染都会在真实运行时才暴露）。判据是：**真实运行 + 实际操作 + 截图取证**；网页额外要求「页面证据 + 后端证据」双重取证。

## 零、审美前置门（每次前端检测必走，2026-11-18 补）

**触发**：功能验收、截图比对、多断点检查、UI 走查等任何前端检测，都先过本门，不需要用户点名“审美”。只过功能断言没做审美检查时，结论只能写“功能通过，审美未验证”。

1. **结构层 rubric**（每条都要能判红）：层次与间距节奏、对齐与视觉重心、信息密度、颜色语义与对比、状态覆盖（默认 / hover / active / disabled / 主题切换）、空态 / 加载 / 错误 / 窄屏四态。至少给出 3 条具体问题，或“无问题 + 依据（计算样式 / 截图坐标）”。
2. **细节精修**：按需读 `better-ui`（圆角、视觉对齐、阴影层级、图标与切换、微交互精确值）与 `better-typography`（字阶、行高、换行与截断、标点）；建站审美用 `design-taste-frontend`，AI 味的确定性检测用 `impeccable detect`。
3. **负对照**：确认本门能判红——用已知丑样例，或临时破坏一处间距 / 对比，断言必须失败；全绿没有负对照视为未验证。
4. **落证据**：汇报写“哪项 / 证据（截图、计算样式、像素差）/ 结论”；没做就写“审美门未做 + 原因”，不得用“看起来不错”结案。
5. **量化内缩与布局契约门（2026-11-21 补，肉眼走查会放过贴边）**：凡涉及列表/表单/卡片页的前端验收，除主观走查外**必须跑判据脚本**——四向内缩（文字与内容块距主容器 ≥12px 水平 / ≥8px 垂直）、列表塌陷与死白（分页条与容器底差 8–20px、距视口底 ≤40px）、窄屏横向溢出（真实滚动容器，宽档必须为 0）、覆盖率（声明路由全测到）。流程与阈值见 [references/edge-gutter-layout-checklist.md](references/edge-gutter-layout-checklist.md)，脚本见 §三「机器判据脚本」。**判据本身要能失败**：同一脚本喂旧构建量测件必须报红，只报绿不算建立判据。**负对照有两种，至少跑一种**：`probeCss` 注入剥离内缩契约的 CSS（证明贴边会判红）、`clearTransitionResidue:false` 保留过渡残留（证明量测态污染会判红）——两种都由 harness 参数触发，不需要改业务代码。

## 一、标准验收流程

1. 启动服务：后端与前端各自起好（示例：`yarn run start:community:hot`，127.0.0.1:8889）。
2. 用真实浏览器走**完整用户路径**，包含**负向用例**（无权限 / 未登录 / 边界输入）。
3. 双重取证：**页面快照 / 截图 + 后端任务事件 / 接口返回**，两者对照。
4. HTTP 判活用对照组：本环境 SPA fallback 会把任意编造路径答成 `200 text/html`，真实 API 回 `application/json` —— 必须用 **content-type / 特征串 / 错误码**区分，否则对照组永远 200，看不出问题。

## 一·五、改动回归矩阵（防「只验了首页」）

改动面决定截图条数，不能用"首页正常"代表"功能正常"。按下表逐行取证，行数 = 证据条数：

| 行 | 至少要走的路径 | 判据 |
|---|---|---|
| 改动的页面/路由 | 每个改动点各自走一遍（含弹窗、抽屉、二级页） | 截图 + 关键断言 |
| 孪生入口 | 同族列表/详情/编辑、旧菜单、旧路由至少各一条 | 旧入口可进入且数据正确 |
| 状态覆盖 | 空态、无权限、未登录、边界值 | 各自与预期一致 |
| 数据路径 | 新增记录 → 列表可见 → 详情正确 → 编辑保存 | 端到端闭环 |
| 用户报告的问题 | 先原样复现，修后走同一路径确认症状消失 | 复现记录 + 修复后截图 |

缺行即未验证，显式写「未覆盖 + 原因」，不得用其它行的绿代替。存量模块的旧菜单/旧流程兼容清单另见 `legacy-entry-compat-regression`。

## 一·六、图标渲染成方框叉（tofu）：静态资源被 SPA fallback 吞掉

**症状**：按钮/标签前的图标显示成方框内 X 或空白方块（用户常直接红框圈出来指认）。

**根因模式（不是"环境问题"）**：CSS 里 `@font-face` / 图片用**绝对站点根路径**（如 `/xxx/static/font/icon.woff2`），而当前宿主（dev server、子路径部署、网关）没有该前缀的路由 ⇒ SPA history fallback 把它答成 **`200 text/html`（不是 404！）** ⇒ 浏览器拿 HTML 当字体/图片解析失败 ⇒ tofu。**关键迷惑点：状态码是 200，网络面板看着"成功"**，只看 `status` 的断言永远抓不到。

**四层判据（都要能失败）**：

1. **网络层（最省事的自动抓法）**：CDP `Network.responseReceived` 收集所有带静态扩展名（`woff2?|ttf|eot|otf|css|js|png|jpe?g|gif|svg|ico`）的响应，断言 `status==200 && mimeType` 命中 `text/html` 的集合**为空**。非空即缺陷，清单直接给出被吞的 URL。
2. **运行态**：对每个图标字体族断言 `document.fonts.check('12px <family>')` 为 true，或枚举 `@font-face` 的 `loaded`；全 false 就是字体没拿到。
3. **像素层**：改前/改后**同 bbox、同倍率** `compare`，`diff_pixels` 必须 >0（图标真的变了）；同图自比必须 ==0（负对照，证明量具没坏）。
4. **双端 parity**：把 dev 代理表与生产网关/nginx 的 location 前缀**逐个比对**——生产修过、dev 没同步，是这类缺陷最常见的成因（同一根因在两个环境分别复发）。

**结案纪律**：不得以「headless 环境不加载字体」「第三方页面改不动」结案。先跑第 1 层拿 content-type——`200 text/html` 就是本侧路由缺失，属可修范围；确实上游不可达（5xx）时才可标注「修复效果未实测」，且要写明是哪一条断言因何未能判定。

**修复形态**：给该前缀补同源代理/反代（dev 代理表加一条 `pathRewrite`；生产加 `location` + 静态资源 `expires`），改完必须重启 dev（代理中间件不热加载），再跑第 1/2/3 层复验。

## 二、browser-use 无可见视口时的处理

**首要排查（2026-10-16 用户口径 —— 先查这个，不要直接降级）**：`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`（viewport=0x0 / visibilityState=hidden）的根因**大多是**：① **Qoder 侧边栏（内置浏览器所在面板）没打开**；② **当前会话不在主窗口**。
修法＝**操作电脑**：computer-use `list_windows` 找到 Qoder 主窗口 → `activate_window`（传完整对象 `{app,id,title}`，id 必须字符串）调到前台；需要时把会话切回主窗口并打开侧边栏。本机实测（2026-10-16 某项目 B05）：激活主窗口后 `take_screenshot` **立即恢复**。**不要先反复重试截图**。

以上已排除、确实拿不到视口时再走降级：

- 改用 `evaluate_script` 驱动页面：交互用**原生 setter + dispatchEvent** 触发 React onChange。
- 注意 `textarea` 与 `input` 的 setter 不同；`Illegal invocation` 通常是 prototype setter 用错，或对 `querySelectorAll` 返回的 NodeList 直接调方法。
- 点击开关、断言 DOM 文案与持久化状态都可以用脚本完成。
- 同一页面 `evaluate_script` 连续报 `Inspected target navigated or closed` 时**不要试第三次**：执行上下文已被 iframe 导航销毁；改 `take_snapshot` 取证，或直接导航到目标页 / 用同源 iframe harness 做断言。若该错误出现在**主动 `location.href` 导航之后**，属预期上下文销毁而非失败：用带 setTimeout 等待加载完成的新 `evaluate_script` 接续即可，不计入失败/重试预算（2026-11-18 并入）。**同理，不要在同一个 `evaluate_script` 里调用 `location.reload()` / 页面跳转后再等待或断言**——导航会销毁该次执行上下文并稳定报此错；固定拆成两次调用：第一次只触发导航，第二次（新调用）等待后取证（2026-11-19）。
- 截图拿不到就明确说明"以 DOM 断言代替视觉检查"，**不要谎报看到了界面**。

## 三、视口尺寸限制

内嵌浏览器视口固定 **724×729**，`window.resizeTo` 与各工具均无法调整（browser-use 无 resize 工具，computer-use 的 `get_window` / `perform_secondary_action` 也不支持改窗口尺寸）。

- 窄屏媒体查询分支（如 ≤700px）**无法在真实视口实测**。
- 响应式改动要么用**注入 CSS 模拟桌面态测量**（可行），要么在总结里**显式标注"该断点未实测"**。

### 多断点实测（2026-11-17 补；2026-11-18 加高度维度）

固定视口下的断点实跑路径：用 `responsive-craft` 技能自带的 `preview.js <页面或URL> --breakpoints 375,768,1024,1440`（在该技能的 scripts 目录）起多 iframe 预览（每个 iframe 按目标宽度独立渲染），**矮屏加 `--sizes 1366x768,1280x720,825x785` 显式指定宽×高**；或 headless Edge/CDP 指定窗口尺寸；或按清单里的同源 iframe harness 显式 width+height 测量。验收按 [references/multi-breakpoint-checklist.md](references/multi-breakpoint-checklist.md)：横向溢出断言、sticky 生效、触控目标与 IME 文本规则、**矮屏首屏可操作性 / 双滚动条 / 合法溢出声明**，并做**负对照页判红**——只跑正例出绿是假绿。

机器判据脚本（本技能 scripts/，均可失败、EXIT 1 判红）：

- `assert-shortscreen.cjs <measurements.json>`：矮屏布局断言（横向溢出、双滚动条、未声明溢出、首屏关键操作可见），测量 JSON 由清单内 harness 导出。
- `assert-scrollbar.py <shot.png> --thumb #… --track #… --width 8 --forbid #…,#…`：滚动条视觉语言像素断言（带宽/反例色/暗轨存在/WCAG ≥3:1）；负对照＝注入旧调色板截图判红后移除复绿。
- `assert-edge-gutter.cjs <measure.json> --expect r1,r2,… [--min-x 12] [--min-y 8]`：四向内缩与贴边断言（文本轴 + 内容块轴 + 路由覆盖率 + 量测稳定性），消费 `harness-inset-probe.cjs` 的产出。除阈值外还先判 `pageLoadedMeasured`（超时/缺主容器的记录没有可信读数，判红而不是让阈值各报一次 null 不达标）与 `transitionSettled`（过渡类残留会让右/底轴系统性偏移，实测 −20px）。**Git Bash 下必须先 `export MSYS2_ARG_CONV_EXCL="*"`**，否则 `--expect /,/source` 会被改写成 Windows 路径，脚本会直接 exit 2 报出来。
- `harness-inset-probe.cjs`：内缩量测 harness（同源 iframe、settle 后取第二次；已内置「表头误入文本轴」「滚动条宽度误判贴边」两处修正的参数化版本）。
- `assert-layout-collapse.cjs <measure.json> [--min-list 200] [--gap-min 8] [--gap-max 20] [--dead-max 40] [--overflow-wide 0] [--overflow-narrow 200]`：列表塌陷 / 分页死白 / 分页贴底 / 横向溢出 / 错误态可解释断言，兼容新旧字段名（`tableHeight`/`listHeight`、`pageFillBottom`/`containerBottom`）。面板高度规则按 `paneIsAncestor` 分叉：pane 是 list 的祖先才判「面板不该比表格矮」，否则只能按下限判塌陷（`.el-table` 含表头本就比 `.el-table__body-wrapper` 高，直接判 `pane>=list` 是反的）；错误态只在**确有 alert/错误 toast 信号**时要求可解释，真实空集显示空表不是缺陷。
- `harness-layout-probe.cjs`：上述布局量测 harness；会校验溢出容器 `overflow-x` 确为 `auto/scroll`，不是则记 `hOverflowUnusable` 而不是产出恒 0 的假绿读数。

**六个坑只有真跑才暴露**（A 表头进文本轴 / B 外层 `overflow-x:hidden` 恒 0 / C settle 后二次量测 / D 超时后补量必须冻结读数 / E 隐藏标签页 rAF 被节流→过渡类永久残留→读数系统性偏 20px 并造假出「壳层底边缺陷」/ F 超时定时器未 clear 会把已完成的记录标成 timeout）：细则、参数与本轮实跑数字见 [references/edge-gutter-layout-checklist.md](references/edge-gutter-layout-checklist.md)。

## 三·五、贴边与布局塌陷的根因修法（改哪儿，而不是调阈值）

用户点出一处贴边＝**判据缺失**，不是单页缺陷。修法顺序：

1. **先量化全仓**：按路由表把**全部路由 × 四向**（左/右/上/下）一次测全，别只修被点名的那页；应测路由用覆盖率参数 `--expect` 显式声明，缺一条即判红。
2. **修在单一真源**：水平/垂直内缩属于布局契约（壳层组件的 padding 与整块元素的 margin），不在各视图里重复 scoped 定义；已有同值局部定义时**删局部、留全局**，删后必须复跑判据证明行为中性（同读数、同 EXIT）。
3. **区分 padding 与 margin**：整块要真正离开边缘只能用 margin（块自身内缩值 ≥12 视作“靠 padding 内缩”，不计入贴边命中）；只加 padding 会背景贴边、文字仍贴边。
4. **异常读数先怀疑量测态，再动阈值（2026-11-21 实跑纠正）**：上一轮登记的「壳层底边整体偏低 15px」经真实浏览器复跑证伪——那是坑 E 的过渡类残留假读数（清理后 `containerBottom=768` 恰等于视口高、`gap=16`）。所以任何"整片同向偏移"的读数，先查 `hostVisibility` / `transitionStuck` / `residueCleared` 再立项；确认是真缺陷才登记，**不得为让判据通过把阈值调成 0 或调成"分页紧贴容器底"**——那正是上一轮放过缺陷的原因。
5. **收尾**：新阈值上线后重跑旧数据件，旧构建必须报红（负对照）；把“上一轮标准放过了什么”写进缺陷清单。

## 四、用户说"打开界面"时

- 用**系统默认浏览器**打开目标地址（Windows：`Start-Process <url>`），并**保持服务运行**，而不是只开一个自动化会话。
- 被门禁挡住入口的页面，把打开方式（如控制台片段）一并给用户。
- 这与"自动化验收"是两件事：自动化负责取证，打开界面负责让用户亲自复核，两件都要做。

## 五、非网页前台（小程序 / 小游戏 / App / 客户端）

- **小程序 / 小游戏**：微信开发者工具模拟器实际点击 + 截图；真机预览另算。
- **App**：模拟器或真机 + 截图。
- **桌面客户端**：真实启动窗口 + 截图；Windows 下用 CUA 点击/输入前先读 [references/windows-cua-guardrails.md](references/windows-cua-guardrails.md)（窗口内坐标、守卫拦截、React 受控输入、CEF 截图）。

网页之外的"前台"同样必须**真实运行 + 实际截图**，只过单测 / 构建不算完成。按平台选择手段：

- **小程序 / 小游戏**：调起**微信开发者工具**，在模拟器里实际点击走查并截图；涉及支付、相机、性能等真机相关能力时再走**预览 / 真机调试**。
  - 驱动方式：优先用开发者工具自带的 CLI / 自动化接口；否则用 computer-use MCP 对工具窗口 `launch_app` → `get_window_state` → `click` → 截图。
  - `miniprogram-ci` 的预览 / 上传只是产物交付，**不能替代**模拟器里的实际点击验证。
- **App（移动端）**：模拟器（Android emulator / iOS Simulator）或真机运行，`adb shell screencap` 等取截图；关键流程覆盖正反用例。
- **桌面客户端**：真实启动应用窗口，用窗口截图（computer-use `get_window_state`）取证，不能只看日志。

**共同要求**：

- 截图与预期**逐项比对**，差异要说明是"预期变化"还是"回归"。
- 工具不可用（未安装 / 无图形界面 / 需凭据）时：显式写"**未做视觉验证 + 原因**"，并给出用户可自行验证的最短路径（命令 / 入口），不得以"应该没问题"结案。

## 视觉清晰度与模式切换完整性（2026-11-12 补）

只截全图"看起来正常"会漏掉两类缺陷（某项目实例：暗底近黑单选标签、浅蓝字压蓝底的 link 按钮、弹窗透底叠影；切分组后左下筛选与未选屏幕未隐藏）。每次前台验收至少加这两组**可失败断言**：

1. 文字/控件清晰度（计算样式，不靠肉眼）：
   - 对关键文案逐项取 `getComputedStyle(el).color / backgroundColor`，按 WCAG 算对比度：正文 ≥ 4.5:1，大文本（≥18.66px 粗 / 24px）与禁用态 ≥ 3:1；不达标即缺陷。
   - 暗色主题重点查全局样式覆盖：`.ant-btn*` 给 `type="link"` 铺底、`.ant-radio-group/.ant-radio-wrapper` 近黑字、弹窗 `opacity<1` + `mask=false` 透底叠影。
   - 截图要**局部放大**核对文字与按钮，不只拍整页。

2. 模式/状态切换完整性（不是只看数据变化）：
   - 枚举界面所有模式（tab / radio / 开关），对每个模式下**应显示 / 应隐藏**的每个区块断言 `getComputedStyle(el).display !== 'none' && el.offsetHeight > 0`（或反向），并做"切回恢复"的负向用例。
   - 隐藏条件要绑定**模式本身**而不是"选中的具体数据"（如 `selectMode` vs `groupId`），否则空选中时会漏出。
   - 断言清单写进脚本、能失败；截图只作佐证，不能替代断言。

3. 局部采样放大对比（确保成果与效果一致，2026-11-13 补）：
   - 收尾不得只凭整页截图下"一致/正常"结论。抽 N 个局部样本（文字区／纹理区／色彩光影区／**空白区**），对源与成果（或改前／改后）取**同一 bbox、同倍率**放大并排对比。
   - 读像素差与属性差（色相／饱和度／对比度／纹理边缘能量／高光阴影占比）：声称一致的样本差≈0，声称有改动的样本差>0 且对应属性差显著；反了即缺陷。
   - **非文字属性同样纳入**：纹理变化、色彩/饱和度、对比度、光影效果都要查，不只查文字清晰度；描述词要有测量值支撑，无数字支撑的形容词降级为"推断"。
   - 空白样本不得"看出"内容（降幻觉负对照）；看出即幻觉，该轮描述作废重读。
   - 工具：`image-detail-inspect` 技能的 `compare`／`stats`（Pillow 零依赖）；目视并排图与数字冲突时信目视并复查坐标。

## 视觉成品最终检测清单（2026-11-16 补）

对用户可见的视觉交付物，最终验收固定五项；缺一项就写“未验证 + 原因”，不能宣布完成：

1. **真实运行与完整路径**：按本技能前文真实启动/操作，覆盖至少一个负向或边界用例；截图只作佐证，不能替代断言。
2. **关键部位细节放大**：对承载几何/材质的区域（轮、挡泥板、脸、手、控件等）取 1:1 与 2–4× 同 bbox 裁剪；用 `image-detail-inspect` 的 `compare`/`stats` 或等效量具。几何类必须给可失败数值：轮廓半径极差、间隙、对称、重叠；只写“看起来正常”不算通过。
3. **审美 rubric**：用 `impeccable` 的 craft-floor/polish 或等效清单逐项过：关键文字/控件对比度（正文 ≥4.5:1，大文本/禁用态 ≥3:1）、焦点可见、状态覆盖（默认/hover/active/disabled/主题切换）、层次与接触阴影、`prefers-reduced-motion`。固定 rubric + 最多一轮修订，避免无限打磨。
4. **运行期行为矩阵**：动画/暂停/恢复、主题/模式切换、关键交互与控制台错误；每项有本轮命令、截图或断言结果。
5. **证据落盘与未验证项**：每条给截图/裁剪/指标/退出码；调用了 `image-detail-inspect` 或 `impeccable` 本身不算通过，必须给可观测结果。

**分级**：A 类用户可见成品（默认）五项全过；B 类内部原型/演示至少过第 1、2 项的主对象与第 3 项的基础对比度/焦点；C 类非视觉任务 N/A。工具是手段，不是判据；判据是上述可失败检查与证据。

## 六、边界

- 启动服务、跑脚本、改代码等本地可逆动作自主推进。
- 端口被并发会话占用时换端口起自己的服务，**不要去杀别人的进程**。
- **TaskStop 树杀失败的回退（2026-11-18 实测采纳）**：本机 TaskStop 对「launcher＋子进程树」后台任务（node preview→serve-static、Chrome 等）会报 `Failed to terminate process tree … exit code null`，**不重复重试**；改 pwsh7 `Get-CimInstance Win32_Process` 按本轮 profile/路径过滤出显式 PID 清单（同屏打印他人进程负对照计数）→ 逐 PID `Stop-Process` → 复验 LEFT=0 与端口 closed；首遍残留子进程再跑同过滤一遍。视觉证据确实拿不到时，如实降级说明；可失败判据本身的设计原则见 `verify-before-claim`。

## 七、Playwright / Cypress 稳定性（写 E2E 时）

- **优先项目已装的框架**，能力缺失时先查已有工具；不为一个冒烟测试全局新装 agent-browser 或另一套测试框架。
- **语义定位器优先**：`role` / `label` / 稳定 `test id`，不用脆弱的层级或文本位置选择器。用自动等待的 locator / 断言，**按具体 UI 或请求结果等待**；不把固定 `sleep`、全站 `networkidle` 或反复重试当成通用修复。
- **探针报"找不到按钮"先归因，再改口径（2026-11-23 实测采纳）**：按可见文案匹配（`textContent === '查看' / 'View'`）的点击探针，会被他人把操作列改成 icon-only 按钮（只剩图标 + Tooltip，无文字）打断而报"找不到"。这类失败既不是产品回归、也不是环境问题，**不许直接结案成其中任何一种**：先 `svn log` / `git log` 查该组件近期改动的归属与时间，确认是 UI 改造后改探针 —— 换成图标 / 语义定位（`.anticon-eye`、`aria-label`、`data-testid`），并保留旧文案匹配作回退（新旧构建都要能点中）。改完判据仍能失败（匹配不到时返回 null 让断言红），且**"换个选择器就绿"要连同原始失败一起报告**，不合并成一次成功。若日志显示同一时段还有 dev server / 服务被他人重启，`iframe count=0` 一类偶发读数要先在自有实例上复跑排除归属真空，再决定是否算缺陷。
- **等特定网络事件要在触发操作之前建立等待**，否则竞态（事件先到、监听后建）。
- **隔离数据与登录状态**；并行只在服务、账户与产物互不干扰时用。
- **不稳定失败保留初次失败与 trace / 截图**，查选择器、数据竞争、异步顺序与环境差异；重试后成功要**单独报告**，不隐藏原始失败。
- 真实 OAuth / 支付 / 邮件短信等需相应授权；**mock 或跳过 ≠ 真实流程通过**。Web 验证不替代 Tauri / Android / Cocos 等原生端验收。
- 来源：Codex `local-browser-e2e`（2026-10-11 并入，原技能已停用）。

## 八、深度技巧（SPA / API 捕获 / 组件交互）

需要"把站点操作固化成 API"，或与复杂 SPA（Vue / 组件库 / 图形画布）做深度交互时，见 `references/deep-browser-techniques.md`：XHR/fetch hook 全姿势（三个 prototype 方法同 patch；抓不到先自检 hook）、SPA 导航保 hook、点击策略阶梯（JS 事件 → 真实点击 → 绕 UI 直读路由）、Vue 组件访问与受控输入赋值、双击模拟、自动保存副作用意识。静态反查与对照实验方法论另见记忆 `tooling-frontend-api-archaeology`。
