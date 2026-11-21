# 四向内缩 / 布局塌陷 / 报错可读性 判据清单

来源：真实前端验收与线上负对照实测（多页面、多视口、真实点击与截图）沉淀出的判据，不是通用审美口号。
用法：先跑 `scripts/harness-inset-probe.cjs` + `scripts/harness-layout-probe.cjs` 取量测 JSON，再用
`scripts/assert-edge-gutter.cjs` / `scripts/assert-layout-collapse.cjs` 判红绿。**每条判据都必须能失败**——
判据上线前先拿「已知有缺陷的旧构建」量测件跑一遍，跑出红才算成立。

## 一、判据表

| # | 缺陷类别 | 可量化判据 | 怎么量 | 常见假绿陷阱 | 根因修法 |
|---|---|---|---|---|---|
| A | 文字/内容块贴边（四向） | 文本框距主容器左/右内缩 ≥12px、上/下 ≥8px；块（卡片/告警/tabs/筛选表单）左或右内缩 ≤1px 即命中 | `assert-edge-gutter.cjs` | 只量**容器盒子**会把天生全宽的布局壳（`.page-fill`、页脚）误报成贴边；文本轴用「父元素自身 className 排除」会把表头算进来，量出假贴边 | 在布局契约里补**唯一真源**：区块级 `padding`，整块脱离边缘要用 `margin`（padding 只让背景贴边）；页脚脱离契约容器时单独补内缩 |
| B | 列表区被压扁 + 下方死白 | 列表可视高度 ≥200px；分页条底边与主容器底边差值落在 8–20px；分页条距视口底 ≤40px | `assert-layout-collapse.cjs` | **把「分页条紧贴容器底」当奖励**（旧判据 `|容器底-分页底|≤2` 实为贴边）；只看有没有滚动条不看高度 | 页面主体走与同类页相同的布局契约（tabs/表格放同一弹性容器，表格给 `height:100%`），内缩由全局契约提供 |
| C | 窄屏横向溢出 | 宽视口档溢出 =0；窄视口档 ≤约定上限（与同类页实测基线对齐，不凭空定） | 同上（`hOverflowPx`） | 量了 `overflow-x:hidden` 的外层——`scrollWidth-clientWidth` 恒为 0，怎么都不报红 | 组件库真实滚动容器是内层 `overflow-x:auto` 那层（如 `.el-scrollbar__wrap`）；列宽用 `min-width` 收敛而不是加断点 |
| D | 报错刷屏 | 同一错误文案在窗口期内只出现 1 个 toast；被门禁/停轮询时**请求数 0、toast 数 0** | 真实点击 N 次 + 计数控制台/网络 | 「连点只弹 1 个」可能是去重把不同文案也吞了——要同时验 403 与超时两种文案都显示 | 请求层按文案去重（时间窗），门禁/降级态停止轮询而不是继续打 |
| E | 状态假绿 / 空态不可解释 | 拉取失败时状态显示「未知」而非上次的「运行中/已配对」；空表文案说明**为什么空**（含错误码与重试入口） | 断网/403 场景实拍 + 文本断言 | 生产页面用合成数据兜底充数；只判「有没有行」不判「为什么没行」 | 失败态单独建模，卡内给可解释告警（错误码 + 重新检测按钮），告警块高度 ≤90px 不塌陷布局 |
| F | 量测态污染（过渡类残留 / 加载超时） | `transitionSettled` 与 `pageLoadedMeasured` 两条前置判据先过，阈值读数才有意义：残留 >0 或超时即判红并**丢弃该条读数** | 两个 harness 的 `transitionStuck`/`residueCleared`/`hostVisibility`/`timeout` 字段 | **把隐藏标签页的 rAF 节流当成业务缺陷**——本项目实例：上一轮登记的「壳层底边整体偏低 15px」实为 `fade-slide-enter-from` 残留带来的 −20px 假读数，清理后 `containerBottom=768`＝视口高、`gap=16` | harness 默认注入 `*{transition:none!important;animation:none!important}` 并剥掉残留类（`clearTransitionResidue:false` 可关掉做负对照）；确认是真缺陷才登记，见 §四 |
| G | 多语言列宽 | 有 i18n 的表格列一律 `min-width`（不是 `width`）；逐键核对各 locale 键数一致，且**用实际取键方式**比对而不是文本猜测 | `npm run build` + i18n 检查脚本 + 切语言实拍 | 只看中文视图；用正则数文件里的键（漏动态键、漏回退） | 列宽 `min-width`；最长语言（如英文/阿姆哈拉语）实拍一遍再放行 |
| H | 覆盖率 | 声明的路由清单必须**全部**测到（缺一个直接判红），只测单页不得报「全站通过」 | `assert-edge-gutter.cjs --expect` | 抽样 top-N 后汇报「全部通过」 | 路由清单来自路由表本身，不手写省略；额外路由也报出来 |
| I | 量测稳定 | settle 后测两次，差 >2px 记 `unstable` 并**以第二次为准** | 两个 harness 内置 | 首测就当真值（异步数据/图表落地前的框不同），或「多测取平均」掩盖抖动 | 等本轮网络静默再量；判据等待条件要能失败（不等空表、不等 svg 存在） |
| J | 像素 vs DOM 冲突 | 启发式像素扫描只作交叉核对，**与 DOM 盒模型冲突时以 DOM 为准** | 白块扫描 + `getBoundingClientRect` 对照 | 像素启发式把表格内部白色单元格当成卡片边，读出「已内缩」的假绿 | 记录冲突并保留 DOM 读数；截图用于视觉确认，不用于唯一裁决 |
| K | 线上对照真伪 | 对照组用**不存在路径 + content-type** 判定，不看 HTTP 状态码 | 真实请求对照 | SPA fallback 下任何不存在路径都回 200，「旧 hash 仍 200」被误判成异常 | 真实资产 `application/javascript`，回退页 `text/html`；部署验收另按内容级 hash/md5 集合比对 |

## 二、判据本身会被升级（留证方法）

抬高阈值后，**上一轮"已通过"的数据件必须重跑**：若旧数据件在新判据下变红，说明上一轮标准放过了缺陷（本项目实测：分页条 gap=0 的读数在新阈值下判 FAIL）。这类记录要写进缺陷清单，而不是只改脚本。

## 三、命令速查（Windows + Git Bash）

```bash
# 1) 量测：把 harness 返回的函数交给 browser-use evaluate_script 执行，结果落盘成 measure.json
#    base / pathPrefix / mainSelector / excludeSelector / routes 都要显式给
# 2) 判红绿（正/负对照各跑一次）
node <skill>/scripts/assert-edge-gutter.cjs   measure-fixed.json --expect /,/a,/b   # 期望 EXIT=0
node <skill>/scripts/assert-edge-gutter.cjs   measure-old-build.json --expect /,/a,/b  # 期望 EXIT=1（负对照）
node <skill>/scripts/assert-layout-collapse.cjs measure-fixed.json                    # 期望 EXIT=0
node <skill>/scripts/assert-layout-collapse.cjs measure-old-build.json                 # 期望 EXIT=1
```

Git Bash 两个坑（都会静默改变结论）：路由串以 `/` 开头会被 MSYS 当路径转换，须
`export MSYS2_ARG_CONV_EXCL='*'`；数据件路径要给 Windows 形式（`D:/proj/...`），传 `/d/proj/...`
会被 Node 解析成 `C:\d\...` 而 MODULE_NOT_FOUND / ENOENT。脚本已对前者做**硬防呆**：`--expect`
里出现盘符或反斜杠时直接 `exit 2` 并报出该先设的环境变量，而不是让覆盖率假报缺失。

### 负对照两种模式（不改业务代码，harness 参数即可）

```bash
export MSYS2_ARG_CONV_EXCL='*'
# 模式一：剥离内缩契约（把 .section-pad/.gutter-x/.page-footer 的缩进清零）→ 必须判红
node <skill>/scripts/harness-inset-probe.cjs --emit > callN-css.js   # 在 options 里塞 probeCss
node <skill>/scripts/assert-edge-gutter.cjs measure-neg-css.json --expect /forward   # 期望 EXIT=1，且带 probeCssApplied 横幅
# 模式二：保留过渡残留（关掉清理）→ 必须判红 transitionSettled
#   options: { clearTransitionResidue: false }
node <skill>/scripts/assert-edge-gutter.cjs measure-neg-residue.json --expect /forward  # 期望 EXIT=1
```

两种模式产出的记录都带自声明字段（`probeCssApplied` / `transitionResidue`），断言脚本会在横幅里
点名"这一轮的 PASS 不能作为交付证据"，防止负对照轮被误当成正例。

## 四、只有真跑才暴露的坑（2026-11-21 实跑台账）

本轮把两个 harness 在真实浏览器里跑起来（Vite dev + 同源 iframe），暴露出静态读码发现不了的 3 个
harness 缺陷和 2 个判据语义错误，全部已修：

| 坑 | 症状 | 根因 | 修法 |
|---|---|---|---|
| D | 超时后 iframe 仍在后台加载完，补量把旧记录污染成"看起来正常" | `finish()` 之后 onload 还会再跑一次 | onload 与二次量测前都 `if (done) return;` 冻结读数 |
| E | 右/底轴系统性 −20px，并造假出「壳层底边偏低 15px」缺陷 | 隐藏标签页 rAF 被节流，Vue 路由过渡类（`fade-slide-enter-from/-active`，含 `position:absolute;width/height:100%;transform:translateX(20px)`）永久残留 | 默认注入 `transition:none` 并剥残留类，残留清不掉记 `transitionStuck` 判红；同时记录 `hostVisibility` |
| F | 已完成的记录被标成 `timeout:true` | 超时定时器没随正常完成一起 clear | `finish()` 里 `clearTimeout(timer)` |
| 判据语义 1 | 每条健康页面都报 `errorStateExplained` 红 | 无条件要求"解释空态"，而真实空集显示空表本来就正确 | 只在 `alertCount+errorToastCount>0` 时要求可解释 |
| 判据语义 2 | `paneHeight>=listHeight` 恒红 | `.el-table` 含表头，本就比 `.el-table__body-wrapper` 高，方向是反的 | 按 `paneIsAncestor` 分叉：祖先才判"面板不该比表格矮"，否则按下限判塌陷 |

**本轮数字（可复算）**：内缩判据 14 路由 × 预热二跑 = **85/85 PASS（EXIT=0，0 超时）**；负对照 A（留残留）
`/forward` 报「残留 8 个过渡类」EXIT=1；负对照 B（剥契约）`L=0/T=0/B=6` + 三个 flush block，EXIT=1；恢复后
13/13 PASS。布局判据 **31/32**，唯一红项 `1366x768@/dead-msg hOverflowPx<=0（实测 83）` 是**新发现的真实缺陷**
（不是判据错），根因见 `views/DeadMsg.vue` 固定列宽合计 1155px > 主区可用 ≈1078px。

**像素侧**：内置浏览器面板 `visibilityState=hidden` 时 `take_screenshot` 报
`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，改由 CUA 后台启动 Edge（隔离 `--user-data-dir`）+
`get_window_state(screenshot_out_file=…)` 取真实窗口图；`set_window_frame` 把外框设到 1368×801
可让截图宽度正好等于 1366 视口，与量测档位对齐。要读列裁切等细节用 `zoom`（区域宽 ≤500px）。

