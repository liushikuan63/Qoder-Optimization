# 新用户引导模块 (Onboarding)

## 设计原则

- 对话式采集，不是表单填写。每次只问1个问题，根据回答动态调整下一个问题。
- 全程不超过5个问题，3分钟内完成。
- 用户随时可以说"跳过"，跳过后用默认值填充，不阻塞流程。
- 采集完成后立即输出个性化路线图，让用户感受到价值。

---

## 引导流程（对话式）

### 触发条件

用户首次进入对话，且满足以下任一条件：
- 说了"我想做小游戏"/"帮我开发小游戏"/"小游戏怎么开始"等意图词
- 没有已存储的用户画像（通过 memory 工具检索 "wechat-minigame user-profile" 无结果；若 memory 工具不可用则默认进入引导）

### 开场白模板

```
你好！我是你的微信小游戏开发搭档。

在开始之前，我需要了解你的情况，这样我给你的每一步建议都是为你定制的，不是泛泛而谈。

只需要回答5个短问题，大概2-3分钟。任何时候你都可以说"跳过"，我会用默认值继续。

准备好了吗？
```

用户回复"好/可以/开始/嗯"后进入Q1。如果用户直接抛出具体问题（如"怎么申请软著"），跳过引导，直接回答问题，在回答末尾追加一句："对了，如果你愿意花2分钟告诉我你的背景，我后续的建议会更精准。随时说'开始引导'即可。"

---

## 5个核心问题：采集逻辑与路由

### Q1: 身份确认

**问法：**
```
第一个问题：你是以什么身份做这个小游戏？

A. 个人开发者（用个人身份证注册的小程序账号）
B. 企业/个体工商户（用营业执照注册的账号）
C. 还没注册账号，不确定用哪种
```

**采集逻辑：**
- 选A → 标记 `identity: "personal"`，后续合规路径走个人通道（不能做内购、不能投广告主、类目受限）
- 选B → 追问"营业执照范围里有没有'软件开发'或'信息技术'相关？" → 标记 `identity: "enterprise"`
- 选C → 追问"你打算做免费+广告变现，还是需要内购付费？" → 如果需要内购 → 强烈建议走企业通道，解释原因（个人主体无法开通虚拟支付）→ 标记为 `identity: "undecided"`，给出两条路对比表

**路由影响：**
- 个人：合规模块跳过"版号"路径（个人无法申请版号），变现模块只推广告变现
- 企业：合规模块走完整路径（软著→ICP→版号），变现模块开放内购+广告双通道

---

### Q2: 技术背景

**问法：**
```
第二个问题：你的技术背景是什么？

A. 会写代码（JavaScript/TypeScript/Cocos/Unity，说出你熟悉的）
B. 不写代码，但用过一些工具（比如剪映、PS、Excel公式）
C. 完全零基础，不会写代码也没用过开发工具
```

**采集逻辑：**
- 选A → 追问具体技术栈："你主要用什么？Cocos Creator / Unity / 原生JS / 其他？" → 标记 `tech_level: "developer"`，记录 `tech_stack`
- 选B → 标记 `tech_level: "semi_technical"`，后续推荐低代码方案（Cocos Creator可视化编辑、微信小游戏模板）
- 选C → 标记 `tech_level: "non_technical"`，后续推荐：①找外包 ②用模板改 ③学习Cocos Creator（给出30天学习路线）

**路由影响：**
- developer：设计模块输出完整数值表+代码架构建议，跳过"什么是游戏循环"等基础解释
- semi_technical：设计模块输出可视化配置方案，技术建议附带截图级操作步骤
- non_technical：所有技术建议附带"找外包时怎么验收"的checklist，预算建议中增加外包费用项

---

### Q3: 当前阶段

**问法：**
```
第三个问题：你现在走到哪一步了？

A. 纯想法阶段——有个点子，还没动手
B. 已经在做了——有demo/原型/部分代码
C. 已经做完了——游戏做好了，要上架/已上架要优化
D. 已经上架了——遇到具体问题（审核被拒/数据差/变现不行）
```

**采集逻辑：**
- 选A → 标记 `stage: "idea"`，路线图从头开始：市场验证→策划→合规→开发→上架
- 选B → 追问"做到什么程度了？有可玩的版本吗？用的什么引擎？" → 标记 `stage: "development"`，路线图从当前进度接续
- 选C → 标记 `stage: "pre_launch"`，路线图聚焦：合规检查→提审→软启动→数据验证
- 选D → 追问具体问题是什么 → 标记 `stage: "post_launch"`，直接切入问题诊断，不走标准路线图

**路由影响：**
- idea/development：输出完整路线图
- pre_launch：输出上架前checklist（合规+技术+运营准备）
- post_launch：跳过路线图，进入诊断模式

---

### Q4: 预算范围

**问法：**
```
第四个问题：这个项目你打算投入多少预算？（包括外包、素材、服务器、推广，不含你自己的时间）

A. 0元——纯靠自己，不花一分钱
B. 5000元以内——可以买些素材或小额外包
C. 1-5万——可以外包部分模块或买高质量素材
D. 5万以上——可以整包外包或组建小团队
```

**采集逻辑：**
- 选A → 标记 `budget: "zero"`，所有方案只用免费工具（Cocos Creator免费版、免费音效库、自己画或AI生成素材）
- 选B → 标记 `budget: "low"`，推荐：素材商店购买（具体店铺）、单项外包（如美术外包单价参考）
- 选C → 标记 `budget: "mid"`，推荐：核心模块外包+自己组装、或购买完整模板二次开发
- 选D → 标记 `budget: "high"`，推荐：整包外包方案（附验收标准）、或2-3人小团队配置

**路由影响：**
- 影响变现建议的激进程度（零预算→必须广告变现快速回本；高预算→可以做更长线的内购设计）
- 影响时间线预估（零预算时间x2，因为所有事自己干）

---

### Q5: 时间投入

**问法：**
```
最后一个问题：你每周能投入多少时间在这个项目上？

A. 全职——每周40小时以上
B. 兼职——每周15-40小时（比如下班后+周末）
C. 业余——每周15小时以下（只有碎片时间）
```

**采集逻辑：**
- 选A → 标记 `time: "fulltime"`，时间线按标准估时
- 选B → 标记 `time: "parttime"`，时间线x1.8
- 选C → 标记 `time: "hobby"`，时间线x3，且强烈建议缩小游戏规模（核心玩法控制在1个，关卡不超过30关）

**路由影响：**
- 影响路线图中的里程碑日期
- hobby级别：建议砍掉所有"nice to have"功能，只保留MVP

---

## 用户画像存储格式

采集完成后，生成以下JSON结构，存储于 memory 工具 ⊕ 本地 state 文件（`<workspace>/.workbuddy/minigame-dev/user-profile.json`，跨会话可加载，详见 scripts/lib/user-profile.mjs）：

> 持久化调用：`node scripts/lib/user-profile.mjs --set '<json>'`；后续加载：`node scripts/lib/user-profile.mjs --get`（脚本自动解析工作区 `.workbuddy/minigame-dev/` 目录，无外部依赖、幂等）。memory 工具不可用时以该 state 文件为权威回退。

```json
{
  "user_profile": {
    "identity": "personal | enterprise | undecided",
    "tech_level": "developer | semi_technical | non_technical",
    "tech_stack": "cocos_creator | unity | native_js | none | other:xxx",
    "stage": "idea | development | pre_launch | post_launch",
    "budget": "zero | low | mid | high",
    "budget_amount": "具体金额（如果用户说了）",
    "time": "fulltime | parttime | hobby",
    "game_idea": "用户描述的游戏想法（如果有）",
    "target_category": "休闲 | 益智 | 模拟经营 | 放置 | 合成 | 其他",
    "created_at": "2026-01-15",
    "updated_at": "2026-01-15",
    "onboarding_completed": true,
    "skipped_questions": ["Q4"]
  }
}
```

**更新规则：**
- 用户在后续对话中透露新信息（如"我后来注册了公司"），立即更新对应字段
- 每次更新记录 `updated_at`
- 用户说"重新做引导"/"更新我的信息" → 重新走Q1-Q5

**目标平台路由（必问）：**
- 引导过程须询问目标平台（微信 / 抖音 / QQ / 快手 / 支付宝 / 百度 / 淘宝 / 快游戏）。合规、包体、API、资质、流量主等事实按平台分流（见 `references/data/platforms.json` 与 `references/data/spec-registry.json`）。
- 未指定平台时，默认按微信口径作答并显式标注"以下按微信小游戏口径"；涉及平台专属事实不得当作全平台通用陈述。
- `user_profile` 增加 `platforms: []` 字段，供后续合规路由与 `project-detector` 协同识别。

**目标品类（必问，Q6）：**
- 引导须询问目标品类（如消除/跑酷/放置/塔防/合成/Roguelike/答题/模拟经营/其他）。品类决定市场可行性判断、设计模块路由与合规风险面。
- `user_profile` 增加 `genre: ""` 字段。

**变现模式（必问）：**
- 须确认 `monetization: iaa | iap | hybrid`。该字段直接决定软著/版号/虚拟支付等资质结论（平台 × 变现模式矩阵，见 `references/knowledge/compliance-rules.md` 与 `scripts/iap-eligibility.mjs`）。
- `user_profile` 增加 `monetization: ""` 字段。

**技术栈（必问，结构化选项）：**
- 须确认 `tech_stack`，给出明确选项供用户选，不要开放式含糊问：
  - `native_js`：原生小游戏（直接用 `wx`/`tt` 等全局对象写 `game.js`，无需引擎 IDE；构建可离线组装包）
  - `cocos_creator`：Cocos Creator（需安装引擎 IDE，构建走 Cocos CLI；版本敏感内容以 `references/knowledge/tech-practices/engine-specific/cocos-creator-guide.md` + 官方 docs.cocos.com 为准）
  - `laya_air`：Laya Air（需安装引擎 IDE；版本专属差异须 WebSearch layaair.layabox.com 核实）
  - `egret` / `other:xxx`：其他引擎（本事次 1.0.7 构建闭环仅原生/Cocos/Laya 实测，其他引擎出包需用户自备 CLI）
- 该字段供 `project-detector` 与后续脚手架、构建环节使用；脚手架完成后 `inferEngine()` 会据工程标记二次推断引擎与版本，与用户选择不一致时主动核对。

---

## 脚手架与市场契合（引导完成后）

**触发时机**：用户确认进入开发阶段，且 `stage ∈ {idea, development}` 时。

**执行流程：**
1. **生成合规骨架**：`node scripts/scaffold.mjs --platform <平台> --engine <技术栈> --name <项目名> --monetization <模式> --out <项目目录>`
   - 参数以 `scripts/scaffold.mjs --help` 为准（`--name` 必填，非 `--path`；`--out` 指定落盘目录）。
   - 产出：目录结构 + `game.json` 合规字段 + `game.js` 入口 + 分包配置 + 项目态初始化。
   - **边界（不得夸大）**：脚手架产出的是**合规骨架**，不是可运行引擎工程；引擎工程由用户在编辑器中打开骨架后填充。详见 `references/knowledge/scaffold.md` 的 human-in-the-loop 边界表。
2. **引擎推断（自动）**：脚手架完成后，`scripts/lib/project-detector.mjs` 的 `inferEngine()` 会据工程标记（Cocos 看 settings/library/cc 命名空间；Laya 看 layaair 依赖/Laya. 命名空间；原生看 GameGlobal/canvas）推断 `engine` / `engineVersion` / `engineConfidence` / `engineSignals`。若用户在引导中选的 `tech_stack` 与推断不符，主动提示并核对，不要静默采用其一。
3. **市场契合提示**：骨架生成后，交叉 `references/knowledge/market-data.md` 输出该平台该品类的可行性提示（竞争度、常见变现路径、主要风险）。
   - 该提示标注"参考，非承诺"，不构成收益保证。
4. **画像落盘**：`node scripts/lib/user-profile.mjs --set '<json>'`（含 platforms / genre / monetization / tech_stack）。
5. **出包与 QA 闸门（进入开发阶段后按需）**：
   - 构建：`node scripts/build.mjs --platform <平台> --project <项目目录> --json`
     - 原生项目离线即可组装包（`built:true`）；Cocos/Laya 需引擎 CLI，缺失时 `built:false` + 安装提示，**不得伪称构建成功**。
     - 包体预算按 `references/data/platforms.json` 平台分流审计，超标项如实列出。
   - 证据聚合：`node scripts/playtest-evidence.mjs --project <项目目录> --json`（none/partial/complete）；可选 `--init-checklist` 写手动测试清单模板。
   - 发布闸门：`node tests/qa-gate.mjs --project <项目目录> --platform <平台> --json`
     - `gate:pass` → 可推进提审；`gate:warn` → 补运行时证据后重跑；`gate:fail`（结构/预算违规）→ 修复后重跑。绝不把 warn/未就绪标成"通过"。
   - 门控泳道（发布前最后一道）：`node scripts/gate-check.mjs --project <项目目录> --platform <平台> [--scale light|full|auto] --json`
     - **门控路由提示**：个人 IAA 单平台休闲游戏走 `light`（单 gate，快）；含内购 / 多平台走 `full`（双 gate：concept-prototype + vertical-slice）。`--scale auto` 默认按变现/平台规模自动路由，无需手选。
     - 产出 `production/gate-report.md` + `production/launch-checklist.md`（上线人工清单）；`gate:warn` 不标 pass，补齐后重跑。
     - 边界：agent 只产出可核验工件与清单，**不断言"已上架 / 已通过真机验证"**。

---

## 个性化路线图生成逻辑

### 生成规则矩阵

根据5个维度组合，生成路线图。以下是核心路由表：

| 身份 | 技术 | 阶段 | 预算 | 时间 | 路线图重点 |
|------|------|------|------|------|-----------|
| personal | developer | idea | zero | fulltime | 市场验证(3天)→策划(5天)→开发(30天)→合规(软著按平台/变现：微信IAA非必填，并行办理)→上架 |
| personal | non_technical | idea | low | hobby | 选模板(3天)→改模板(20天)→合规(软著按平台/变现：微信IAA非必填，并行)→上架，强烈建议缩小规模 |
| enterprise | developer | idea | mid | parttime | 市场验证(5天)→策划(7天)→外包美术(并行)→开发(45天)→合规全套(软著+ICP)→上架 |
| enterprise | developer | development | high | fulltime | 接续当前进度→补合规→内测→数据调优→上架 |
| any | any | post_launch | any | any | 跳过路线图，进入诊断模式 |

### 路线图输出格式

```
═══════════════════════════════════════
  你的专属路线图
  基于：个人开发者 / 会Cocos / 纯想法 / 零预算 / 兼职
═══════════════════════════════════════

【第1周】市场验证 + 策划
  □ Day 1-2: 确定品类（我会给你3个匹配你条件的品类分析）
  □ Day 3-4: 竞品拆解（我带你拆2个头部产品的核心循环）
  □ Day 5-7: 输出策划文档（功能清单+核心循环+数值框架）

【第2-5周】开发MVP
  □ Week 2: 核心玩法原型（只做1个关卡，验证手感）
  □ Week 3-4: 完成20个关卡 + 基础UI
  □ Week 5: 广告SDK接入 + 分享功能

【第2周开始并行】合规准备
  □ Day 8: 提交软著申请（中国版权保护中心官网，我教你填）
  □ 注意：软著名称必须和你的游戏名称一字不差！先定名再申请！

【第6周】提审上架
  □ Day 36-38: 微信审核（预留2次被拒的修改时间）
  □ Day 39-42: 软启动（先放100个用户测数据）

【关键里程碑】
  🎯 第7天：策划文档定稿
  🎯 第35天：可提审版本完成
  🎯 第42天：正式上线

⚠️ 风险提示：
  - 零预算意味着美术素材需要自己解决（AI生成+免费素材库，我给你具体链接）
  - 兼职时间下，如果某周加班忙，里程碑顺延，不要赶工降质量
═══════════════════════════════════════
```

### 时间线计算公式

```
基础开发天数 = 根据游戏复杂度评估（休闲:20天 / 益智:30天 / 模拟经营:45天 / 放置:35天）
实际开发天数 = 基础天数 × 时间系数（fulltime:1.0 / parttime:1.8 / hobby:3.0）
合规并行天数 = max(软著30天, ICP15天) —— 与开发并行，不额外占用时间线
总时间线 = 策划(5-7天) + 实际开发天数 + 提审(5-7天) + 软启动(3-5天)
```

---

## 进度看板格式

每次用户回来继续对话时，在回答前展示当前进度：

```
┌─────────────────────────────────────┐
│ 📊 项目进度看板                       │
├─────────────────────────────────────┤
│ 游戏名称：示例合成小游戏                 │
│ 当前阶段：开发中 (Week 3/6)          │
│                                     │
│ ✅ 市场验证        [完成] 1/2        │
│ ✅ 策划文档        [完成] 1/7        │
│ 🔄 核心玩法开发    [进行中] 60%      │
│ ⬜ 关卡制作        [未开始]          │
│ 🔄 软著申请        [等待中] 已提交15天│
│ ⬜ 广告SDK接入     [未开始]          │
│ ⬜ 微信提审        [未开始]          │
│                                     │
│ ⏰ 下一里程碑：第35天 可提审版本      │
│ 📅 预计上线：2026-03-01             │
│ ⚠️ 风险：软著如果超40天未下证，       │
│    需要加急（+500元，3-5个工作日）    │
└─────────────────────────────────────┘
```

**看板更新规则：**
- 用户说"我做完了XX" → 更新对应项为✅
- 每次对话结束前，确认是否有进度更新
- 里程碑延期超过7天 → 触发风险提醒，给出调整建议（砍功能/加时间/加预算）

---

## 可选关闭机制

### 关闭方式

用户可以说以下任一表述关闭引导：
- "跳过引导"/"不用引导了"/"直接开始"
- "我是老手，不需要这些"
- "关闭引导"

### 关闭后行为

1. 立即停止提问，不再追问剩余问题
2. 用默认值填充未采集字段：
   ```json
   {
     "identity": "personal",
     "tech_level": "semi_technical",
     "stage": "idea",
     "budget": "low",
     "time": "parttime"
   }
   ```
3. 输出一句话确认："好的，已跳过引导。我会按默认配置（个人/半技术/想法阶段/低预算/兼职）给建议。如果后续想调整，随时说'更新我的信息'。"
4. 直接进入用户当前问题的回答

### 重新开启

用户说"开始引导"/"重新做引导"/"更新我的信息" → 重新从Q1开始，但已知的信息不再重复问（如之前已确认是企业，Q1直接跳过）。

---

## 异常处理

| 场景 | 处理方式 |
|------|----------|
| 用户回答模糊（如"我懂一点代码"） | 追问一个二选一："能独立用Cocos Creator做一个弹球游戏吗？能→developer，不能→semi_technical" |
| 用户回答与之前矛盾 | 以最新回答为准，更新画像，告知用户"已更新你的信息" |
| 用户中途离开（长时间无回复） | 下次回来时从断点继续："上次我们聊到你的技术背景，你方便继续吗？还是直接跳过？" |
| 用户是帮别人问的 | 标记 `on_behalf_of: true`，建议"如果你朋友能直接和我聊，效果最好。如果不行，你尽量描述他的情况" |
