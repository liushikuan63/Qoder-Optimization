# 执行层调用协议

> 定义 AI 如何调用 scripts/ 下的执行工具，实现"改完即预览、提审前自检、问题即诊断"的自动化闭环。
> 本协议是 Skill 执行层的核心规则，优先级仅次于 P0 合规红线和反幻觉规则。

---

## 一、执行工具清单

| 脚本 | 能力说明 | 调用时机 |
|------|---------|---------|
| verify-devtool.mjs | 环境验证（CLI 可达性/版本） | 首次使用执行层前 / 环境异常 |
| run-game.mjs | 运行预览生成二维码 | 代码改完 / 用户要求预览 |
| get-logs.mjs | 获取运行日志 | 预览后2秒 / 用户报错 |
| screenshot.mjs | 截图 | 用户要截图 / 审查视觉 |
| real-device.mjs | 真机预览二维码 | 用户要真机测试 |
| publish.mjs | 上传代码到微信后台 | 用户要发布 |
| readiness-check.mjs | 质量自检：14项就绪度自检 | 提审前必做 |
| compliance-scan.mjs | 质量自检：7条代码层红线+3条安全规则扫描 | 提审前必做 / 代码改完 |
| package-analyzer.mjs | 质量自检：包体分析优化 | 包体超标 / 性能优化 |
| perf-profiler.mjs | 质量自检：性能打点注入/读取 | 性能问题诊断 |
| asset-check.mjs | 质量自检：素材版权检查 | 上线前 / 素材更新后 |
| knowledge-filter.mjs | 质量自检：知识库过滤（按阶段/主题/角色精准加载） | 路由命中知识 / 上下文精简 |
| sop-timeliness-check.mjs | 质量自检：SOP时效巡检（8份核实周期扫描） | 需要核实规范时效 / 定期巡检 |
| fetch-official-docs.mjs | 质量自检：官方规范联网核验（缓存+降级） | 需核实最新规范 / 规则变动 |
| verify-specs.mjs | 全平台/全维度事实时效核实 | 引用合规事实前 / 规则变动 / 定期巡检 |
| freshness-check.mjs | 全量事实文件元数据巡检 | 需核实规范时效 / 定期巡检 |
| sensitive-word-scan.mjs | 敏感词扫描（七分类词库） | 内容/文案评审 / 审核前 |
| copyright-asset-scan.mjs | 版权素材合法性扫描 | 上线前 / 素材更新后 |
| iap-eligibility.mjs | 变现资格判定（软著/版号/流量主闸门） | 规划变现 / 提审前 |
| lib/user-profile.mjs | 用户理解持久化 CLI（--get/--set） | 引导完成 / 画像更新 |
| feedback-capture.mjs | 反馈捕获（没用/过时/被驳回） | 用户表达负面反馈时 |
| evolve.mjs | 学习闭环执行器（生成经验草稿） | 反馈累积 / 用户要求进化 |
| scaffold.mjs | 工程脚手架（空目录→合规骨架） | 进入开发阶段 / 用户要求建项目 |
| build.mjs | 本地构建出包闭环（微信/抖音 CLI 封装；原生离线组装，引擎缺 CLI 降级） | scaffold 后 / 用户要出包 |
| playtest-evidence.mjs | 运行时可玩性证据聚合（截图/日志/清单完整度） | 出包后 / 提审前证据收集 |
| gate-check.mjs | 门控泳道编排（规模路由 light/full；产出 gate-report.md + launch-checklist.md） | qa-gate 后 / 用户要发布门控 |
| balance-check.mjs | 数值平衡量化（drop/economy/difficulty 蒙特卡洛，输入契约校验） | 数值设计评审 / 提审前数值回归 |
| qa-plan.mjs | QA 测试计划骨架生成（按画像裁剪五类） | 进入 QA 阶段 / 用户要测试计划 |
| localize-check.mjs | 出海本地化完整性校验（缺键/空值/未翻译 + 跨语言敏感词预检） | 出海前 i18n 资源评审 / 提审前本地化回归 |
| asset-audit.mjs | 资产规格审计（命名/格式/尺寸 warn + 未授权 IP 硬违规） | 资产入库后 / 提审前资产合规 |
| ci-local.mjs | 本地轻量 CI 等价物（全量语法 + 确定性闸门；不含 link-audit） | 提交/构建前本地校验 |
| release-gate.mjs | 发行复盘清单校验（四节完整性） | 提审前 / 上线后复盘准备 |

---

## 三、自进化闭环（运行时触发）

本层把"越用越懂用户、越用越好用"落成可执行闭环，避免纸面协议：

1. **引导即画像**：onboarding 完成 → `node scripts/lib/user-profile.mjs --set '<json>'` 持久化用户画像（身份/技术栈/阶段/目标平台），跨会话可加载。
2. **负反馈捕获**：用户说"没用/过时/不对/被驳回" → `node scripts/feedback-capture.mjs --signal <invalid|outdated|rejected> --context "<原文>" --source "<模块>"`，写入 feedback-log.json。
3. **学习进化**：反馈累积或用户说"进化/检查知识库" → `node scripts/evolve.mjs` 产出经验规则草稿（**仅草稿，不自动改写知识库**），交付用户确认后落地，以防幻觉。
4. **平台分流**：上述脚本的 --platform 参数与 spec-registry.json 的 platform 字段一致，确保微信/抖音等平台事实不串用。


---

## 二、自动化调用流程

### 流程1：代码修改后自动预览

```
用户修改代码 →
  AI 自动执行：
  1. node scripts/run-game.mjs --project <路径> --json
  2. 等待 2 秒
  3. node scripts/get-logs.mjs --project <路径> --json
  4. 分析日志：
     ├── 无错误 → 告知用户预览成功
     └── 有错误 → 提取错误信息 → 修复 → 回到步骤1（同一错误>5次暂停询问）
```

### 流程2：提审前自动自检

```
用户说"提审"/"能上线了吗" →
  AI 自动执行：
  1. node scripts/readiness-check.mjs --project <路径> --json
  2. node scripts/compliance-scan.mjs --project <路径> --json
  3. node scripts/package-analyzer.mjs --project <路径> --json
  4. 汇总三项结果：
     ├── 全通过 → 告知可以提审，输出提审步骤
     ├── 有阻断项 → 列出阻断项+修复方案，修复后重新自检
     └── 有警告项 → 列出警告项，建议修复后提审
```

### 流程3：性能问题诊断

```
用户报告卡顿/闪退 →
  AI 自动执行：
  1. node scripts/perf-profiler.mjs --project <路径> --mode inject --json
  2. 提示用户运行游戏 1-2 分钟
  3. node scripts/perf-profiler.mjs --project <路径> --mode read --json
  4. 分析性能数据：
     ├── FPS<30 → 建议渲染优化（DrawCall/纹理/合批）
     ├── 内存>256MB → 建议资源释放/对象池
     └── 帧率波动大 → 建议检查GC/复杂计算
  5. node scripts/perf-profiler.mjs --project <路径> --mode revert --json（恢复）
```

### 流程4：发布前全流程

```
用户说"发布"/"上传" →
  AI 自动执行：
  1. 提审前自检（流程2）
  2. 全通过后：
     node scripts/publish.mjs --project <路径> --version <版本> --desc <描述> --json
  3. 上传成功 → 输出后续步骤（提交审核流程）
  4. 上传失败 → 分析错误 → 修复 → 重试
```

### 流程5：构建出包闭环（1.0.7 新增）

```
用户说"构建/出包"/scaffold 完成后要打包 →
  AI 自动执行：
  1. node scripts/build.mjs --platform <平台> --project <路径> --json
  2. 解析结果：
     ├── built:true → 告知出包成功，输出 outputDir（原生项目离线即组装完成）
     ├── built:false 且 cliFound:false → 告知缺引擎 CLI（Cocos/Laya），给安装提示；绝不伪称"构建成功"
     └── preflight.budget.status='over' → 列出超标项与 platforms.json 上限，建议资源裁剪/远程分包
  3. （可选）node scripts/playtest-evidence.mjs --project <路径> --json 聚合运行时证据（none/partial/complete）
  4. node tests/qa-gate.mjs --project <路径> --platform <平台> --json 做发布闸门：
     ├── gate:pass → 可进入提审/发布
     ├── gate:warn → 证据不完整，提示采集截图/日志/清单后重跑（不阻断但标未就绪）
     └── gate:fail（结构/预算违规）→ 列出硬失败项，修复后重跑
```

### 流程6：门控泳道（规模路由，1.0.8 新增）

```
用户说"能上线吗/走门控"/出包后要做发布门控 →
  AI 自动执行：
  1. node scripts/gate-check.mjs --project <路径> --platform <平台> [--scale light|full|auto] --json
  2. 路由判定（--scale auto 默认）：
     ├── 个人 IAA 单平台休闲游戏 → light（单 gate：结构+预算+QA 等价）
     └── 含内购 / 多平台 → full（双 gate：light + concept-prototype + vertical-slice）
  3. 解析结果：
     ├── gate:pass → 产出 production/gate-report.md + launch-checklist.md，进入用户手动上线（真机/上传/提审）
     ├── gate:warn → 证据或原型/切片文档不全，列出缺失项，补齐后重跑（gate 不标 pass）
     └── gate:fail（结构非法/超预算）→ 硬失败，修复后重跑，不可上架
  4. agent 不断言"已上架 / 已通过真机验证"；上架与真机可玩性是用户动作。
```
### 流程7：数值评审与运营复盘（1.0.9 新增）

```
用户说"数值平衡/经济是否合理/做个测试计划/上线后数据怎么看" →
  AI 自动执行：
  1. node scripts/balance-check.mjs --model <drop|economy|difficulty> --in <规格> --json
     → 产出掉落率/通胀紧缩/难度断崖报告，供决策（不自动改数值）
  2. node scripts/qa-plan.mjs --project <路径> --json
     → 按画像生成 tests/qa-plan.md（功能/性能/兼容/合规/回归五类骨架）
  3. 数值规格落 production/balance-spec.json 后：
     node tests/balance-gate.mjs --project <路径> --json
     ├── pass → 数值在阈值内
     └── fail（越阈）→ 列出越阈项，按 economy-balance.md 调整 source/sink 后重跑
  4. 无障碍合规（按需）：
     node tests/accessibility-gate.mjs --project <路径> --json
     ├── pass → 无障碍静态检查通过
     └── warn → 色盲风险/清单缺章节，补齐后重跑（真机验证交用户）
  5. 运营复盘：数据异常（留存跌/崩溃涨）→ 交叉 references/knowledge/operations/analytics-ops.md 诊断，回填项目基准
```

### 流程8：出海与发行闭环（1.1.0 新增）

```
用户说"要出海/做本地化/检查资产授权/发行复盘/CI 跑一遍" →
  AI 自动执行：
  1. 出海本地化（按需）：
     node scripts/localize-check.mjs --project <路径> --json
     → 缺键/空值/疑似未翻译 + 跨语言敏感词预检（命中即人工复核）
     node tests/i18n-gate.mjs --project <路径> --json
     ├── skip → 资源缺失（不假 pass，建议建立 i18n 资源）
     └── warn → 本地化缺口，补齐后重跑（真机/母语审校交用户/专业服务）
  2. 资产规格与授权（按需）：
     node scripts/asset-audit.mjs --project <路径> --json
     → 命名/格式/尺寸 warn；未授权 IP 命中=硬违规
     node tests/asset-gate.mjs --project <路径> --json
     ├── fail（未授权 IP）→ 人工确权授权，禁止未授权商用，不可发布
     ├── warn → 规格问题，不阻断但建议补齐
     └── skip → 资产目录缺失（不假 pass）
  3. 发行复盘清单（提审前）：
     node scripts/release-gate.mjs --project <路径> --json
     → 校验 production/release-checklist.md 四节（上线前/热更/复盘/合规沟通）
     node tests/release-gate.mjs --project <路径> --json
     ├── warn → 缺章节，补齐后重跑
     └── skip → 完整/缺失（绝不标"已通过官方审核"）
  4. 本地 CI 等价物（提交/构建前）：
     node scripts/ci-local.mjs [--project <路径>] --json
     → 全量 .mjs 语法 + 确定性闸门（不含需联网的 link-audit），任一失败 exit 1
```

详见 [references/knowledge/operations/localization.md](references/knowledge/operations/localization.md) / [references/knowledge/art-audio/asset-pipeline.md](references/knowledge/art-audio/asset-pipeline.md) / [references/knowledge/operations/release-ops.md](references/knowledge/operations/release-ops.md)。

---

详见 [references/knowledge/gate-pipeline.md](references/knowledge/gate-pipeline.md)（规模路由定义 + 端到端边界表）。

---

## 三、调用规则

### 规则1：路径确认

调用任何脚本前，必须确认项目路径存在。不能假设路径。

```
✗ 错误：直接用 ./my-game 调用（路径可能不存在）
✓ 正确：先确认路径存在，再调用脚本
```

### 规则2：JSON 优先

所有脚本调用时加 `--json` 参数，便于 AI 解析结果。

```
✓ 正确：node scripts/run-game.mjs --project ./my-game --json
```

### 规则3：如实转达

脚本返回的结果必须如实转达给用户，不能编造或美化。

```
✗ 错误：脚本返回 ok:false，但AI说"预览成功"
✓ 正确：脚本返回 ok:false，AI如实说"预览失败，原因是..."
```

### 规则4：失败不放弃

脚本失败时，分析原因并给出修复建议，不能直接放弃。

```
脚本失败 →
  分析错误类型：
  ├── 路径错误 → 提示正确路径
  ├── CLI 未安装 → 提示安装微信开发者工具
  ├── 超时 → 建议增加 --timeout
  └── 权限问题 → 提示权限设置
```

### 规则5：幂等调用

所有脚本支持重复调用，不会因重复调用产生副作用。

---

## 四、脚本调用语法速查

```bash
# 运行预览
node scripts/run-game.mjs --project <路径> --json

# 获取日志
node scripts/get-logs.mjs --project <路径> --lines 100 --filter "error" --json

# 截图
node scripts/screenshot.mjs --project <路径> --output ./screenshot.png --json

# 真机预览
node scripts/real-device.mjs --project <路径> --qr-format terminal --json

# 上传发布
node scripts/publish.mjs --project <路径> --version 1.0.0 --desc "首次发布" --json

# 就绪度自检
node scripts/readiness-check.mjs --project <路径> --json

# 合规扫描
node scripts/compliance-scan.mjs --project <路径> --json

# 包体分析
node scripts/package-analyzer.mjs --project <路径> --top 20 --json

# 性能打点注入
node scripts/perf-profiler.mjs --project <路径> --mode inject --json

# 性能数据读取
node scripts/perf-profiler.mjs --project <路径> --mode read --json

# 性能打点恢复
node scripts/perf-profiler.mjs --project <路径> --mode revert --json

# 素材版权检查
node scripts/asset-check.mjs --project <路径> --json
```

---

## 五、错误处理优先级

当多个脚本调用失败时，按以下优先级处理：

```
1. 微信开发者工具未安装 → 最高优先级，先解决安装问题
2. 项目路径无效 → 高优先级，确认路径
3. CLI 超时 → 中优先级，可能网络/性能问题
4. 脚本语法错误 → 中优先级，检查 Node.js 版本
5. 权限问题 → 低优先级，提示用户调整
```

---

## 六、与知识层的联动

执行层（脚本）和知识层（references/knowledge/ 与 references/modules/）联动：

| 执行层结果 | 知识层联动 |
|-----------|-----------|
| readiness-check 发现包体超标 | 加载 references/modules/develop.md 的"包体优化"章节 |
| compliance-scan 发现违规分享奖励 | 加载 references/knowledge/compliance-rules.md 的 RULE-008 红线 |
| package-analyzer 发现图片过大 | 加载 references/knowledge/tech-practices/package-optimization.md |
| perf-profiler 发现 FPS 低 | 加载 references/modules/develop.md 的"性能优化清单" |
| asset-check 发现版权风险 | 加载 references/knowledge/legal-finance.md 的"知识产权"章节 |
| scaffold 生成骨架完成 | 交叉 references/knowledge/market-data.md 输出品类可行性提示（参考，非承诺）；cross references/knowledge/scaffold.md 说明 human-in-the-loop 边界 |
| build 出包完成 | project-detector 推断引擎→路由 references/knowledge/tech-practices/engine-expert.md（版本超出训练数据→WebSearch 官方域核实，标 [已核实]/[待核实]）；包体超标→加载 package-optimization.md |
| playtest-evidence 产出完整度 | 证据 partial/none→加载 references/knowledge/tech-practices/engine-expert.md 的"真机调试"章节指引采集；complete→可推进 qa-gate |
| qa-gate 闸门结果 | pass→推进提审；warn→补证据；fail→加载 scaffold.md / package-optimization.md 修复结构/包体 |
| publish 成功 | 加载 references/modules/submission.md 的"提交审核"流程 |
| balance-check 产出报告 | 加载 references/knowledge/game-design/economy-balance.md 校验 source/sink 与付费伦理（防沉迷/版号/IAP 联动） |
| qa-plan 生成骨架 | 加载 references/knowledge/compliance/accessibility.md 补无障碍测试项 |
| balance-gate / accessibility-gate 结果 | pass→推进；warn→补 balance-spec.json / accessibility-checklist.md；fail→按 economy-balance.md / accessibility.md 修复 |
| localize-check 产出报告 | 加载 references/knowledge/operations/localization.md 校验 i18n 闭环与跨语言敏感词预检边界（命中即人工复核） |
| asset-audit 产出报告 | 加载 references/knowledge/art-audio/asset-pipeline.md 校验资产规格与授权声明（未授权 IP 硬违规交人工确权） |
| release-gate 清单结果 | 加载 references/knowledge/operations/release-ops.md 校验四节复盘清单（绝不标"已通过官方审核"） |
| i18n-gate / asset-gate / release-gate 结果 | skip→资源/清单缺失（不假 pass）；warn→补 i18n 资源 / asset-spec.json / release-checklist.md；asset-gate fail（未授权 IP）→按 asset-pipeline.md 人工确权，禁止未授权商用 |

---

## 七、反幻觉约束

执行层的反幻觉核心：**不编造脚本执行结果**。

- 脚本未执行 → 不能说"检查通过了"
- 脚本执行失败 → 不能说"执行成功了"
- 脚本未安装 → 不能假装"已安装"
- 微信开发者工具未安装 → 不能假装"已安装"

详细规则见 [references/engine/anti-hallucination.md](./anti-hallucination.md)。

---

## 八、降级策略（脚本失败后的处理）

当执行层脚本失败时，按以下策略降级，不阻塞用户工作流。

### 降级层级

```
层级1：automator 增强模式（真截图/实时日志）
  ↓ automator 不可用或连接失败
层级2：CLI 基础模式（文件日志/引导截图）
  ↓ CLI 不可用（微信开发者工具未安装）
层级3：纯知识模式（跳过执行层，用知识库回答）
```

### 各脚本的降级方案

| 脚本 | 层级1（增强） | 层级2（基础） | 层级3（纯知识） |
|------|-------------|-------------|---------------|
| run-game.mjs | — | CLI auto-preview | 提供手动预览步骤 |
| get-logs.mjs | automator 实时日志 | 文件日志扫描 | 提供日志排查清单 |
| screenshot.mjs | automator 真截图 | 启动端口+引导手动截图 | 提供截图指引 |
| real-device.mjs | — | CLI auto-preview | 提供真机预览步骤 |
| publish.mjs | — | CLI upload | 提供上传步骤 |
| readiness-check.mjs | — | 本地文件扫描（不降级） | — |
| compliance-scan.mjs | — | 本地代码扫描（不降级） | — |
| package-analyzer.mjs | — | 本地文件分析（不降级） | — |
| perf-profiler.mjs | automator 性能数据 | 注入打点+文件日志 | 提供性能优化清单 |
| asset-check.mjs | — | 本地文件扫描（不降级） | — |
| scaffold.mjs | — | 本地骨架生成（不降级，纯文件写入） | 提供目录结构与 game.json 字段说明 |
| build.mjs | 引擎 CLI 存在→真实构建 | 原生离线组装包；引擎 CLI 缺失→built:false+安装提示（不伪造） | 提供手动构建步骤 |
| playtest-evidence.mjs | — | 文件扫描聚合（不降级，只读） | 提供证据采集清单（截图/日志/清单） |
| gate-check.mjs | — | 编排结构/预算/证据/原型/切片门控，产出报告 | 提供 light/full 路由说明与上线清单模板 |
| balance-check.mjs | — | 纯计算（无 CLI 依赖，不降级） | 提供手动数值评估清单 |
| qa-plan.mjs | — | 纯文件生成（不降级） | 提供测试计划模板 |
| localize-check.mjs | — | 纯文件解析（不降级） | 提供 i18n 资源建立清单 |
| asset-audit.mjs | — | 纯文件扫描（不降级） | 提供资产规格与授权声明清单 |
| ci-local.mjs | — | 纯本地语法+闸门（不降级） | 提供手动跑闸指南 |
| release-gate.mjs | — | 纯文件读取（不降级） | 提供四节复盘清单模板 |

### 连续失败处理

```
同一脚本连续失败 ≥ 3 次：
  → 停止重试
  → 降级到下一层级
  → 告知用户"自动XX暂不可用，已降级为YY模式"
  → 提供修复建议（安装微信开发者工具/安装 automator/检查路径）

同一工作流累计失败 ≥ 5 次：
  → 暂停执行层
  → 切换到纯知识模式
  → 告知用户"执行层暂不可用，我先提供方案建议"
  → 等用户修复环境后恢复执行层
```

### 环境验证前置

首次调用执行层前，建议先运行 `verify-devtool.mjs` 确认环境：

```bash
node scripts/verify-devtool.mjs --project <路径> --json
```

- 验证通过 → 正常使用执行层
- 有警告（automator 未安装） → 执行层可用但部分功能降级
- 有失败（CLI 未安装） → 执行层不可用，直接进入纯知识模式

---

## 九、verify-devtool.mjs 调用时机

| 时机 | 说明 |
|------|------|
| 首次使用执行层 | 确认环境就绪 |
| 脚本连续失败后 | 诊断失败原因 |
| 用户说"环境检查" | 主动触发验证 |
| 用户切换电脑/重装后 | 重新验证 |

---

## 十、阶段切入协议（不强迫用户从头开始）

### 阶段定义与切入关键词

用户说以下关键词可直接进入对应阶段，**不强制从头开始**：

| 阶段 | 关键词 | 入口模块 | 前置条件（仅告知，不阻断） |
|------|--------|----------|--------------------------|
| ① 创意/立项 | "创意/想法/品类/做什么好" | references/modules/market.md + references/modules/design.md | 无 |
| ② 资质合规 | "备案/软著/版号/资质" | references/modules/compliance.md + references/knowledge/sop/ | 无（越早办越好） |
| ③ 技术开发 | "开发/代码/技术/引擎/包体" | references/modules/develop.md | 建议先有游戏设计 |
| ④ 质量保障 | "测试/bug/兼容/卡顿" | references/modules/qa.md | 建议已有可运行版本 |
| ⑤ 提审上架 | "提审/审核/上架/发布" | references/modules/submission.md | 需软著+备案+自审报告 |
| ⑥ 运营变现 | "运营/变现/广告/数据/增长" | references/modules/operations.md + references/modules/growth.md | 需已上线 |
| ⑦ 失败复盘 | "失败/数据差/做不下去/放弃" | references/modules/failure.md | 无 |

### 切入处理流程

```
用户从任意阶段进入 →
  ├── 1. 识别阶段（按关键词匹配，不明确就问一句）
  ├── 2. 加载该阶段入口模块
  ├── 3. 静默检查前置条件
  │   ├── 前置已满足 → 直接干活
  │   └── 前置缺失 → 一句话告知 + 给两条路：
  │       ├── 路线A：先补前置（推荐，给具体步骤）
  │       └── 路线B：直接继续，承担风险（尊重用户选择）
  ├── 4. 记录切入点到 memory（"wechat-minigame project-state"）
  │   格式：entry_point: {stage: "③技术开发", timestamp, prereq_ok: false}
  └── 5. 执行该阶段工作，按需调用执行层脚本
```

### 切入禁止行为

- ❌ 不说"你应该先从创意阶段开始"（用户有权从任意点切入）
- ❌ 不强制加载全流程引导（除非用户说"全流程/从零开始"）
- ❌ 不因前置缺失就拒绝服务（合规红线 RULE-XXX 例外，必须警告但不阻断开发）
- ❌ 不假设用户是新手（除非画像显示零基础）

### 全流程触发条件

仅当用户**主动**表达全流程意愿时才走完整引导：
- "从零开始" / "全流程" / "一步步来" / "我是新手什么都不懂"
- → 加载 references/modules/onboarding.md，按 ①→⑦ 顺序引导

---

## 十一、全程追踪与监察机制

### 追踪数据结构

每次交互后更新到 memory（"wechat-minigame project-state"），结构如下：

```yaml
project_state:
  game_name: "（游戏名称）"
  current_stage: "③技术开发"
  progress_pct: 60
  entry_history:          # 切入点历史，构成全程追踪链
    - { stage: "①创意", time: "2026-08-01" }
    - { stage: "③技术开发", time: "2026-08-03" }
  completed:
    - "市场调研完成"
    - "核心玩法确定"
  blocked:
    - { item: "软著办理中", eta: "2026-09-15" }
  next_step: "完成核心玩法开发"
  risks:                  # 监察发现的风险
    - { type: "package", level: "warn", detail: "主包4.3MB超限" }
  last_interaction: "2026-08-03"
```

### 追踪触发时机

| 时机 | 动作 |
|------|------|
| 每次交互开始 | 读取 project-state，展示进度看板 |
| 每次交互结束 | 更新 project-state（阶段/完成项/阻塞/下一步/风险） |
| 阶段切换时 | 在 entry_history 追加新切入点 |
| 执行层脚本运行后 | 把脚本发现的问题写入 risks |

### 监察巡检清单（后台静默执行）

每次交互时，对照当前项目状态静默巡检，发现问题主动告警：

| 巡检项 | 检查方式 | 告警条件 | 告警动作 |
|--------|----------|----------|----------|
| 包体超标 | 调 package-analyzer.mjs | 主包>4MB / 总包>30MB / 独立分包>4MB | ⚠️ 主动提示+优化方案 |
| 合规红线 | 调 compliance-scan.mjs | 任何 severity=block 的违规 | 🚫 立即警告，拒绝"先上线再说" |
| 资质缺失 | 检查 project-state.blocked | 想提审但软著/备案未办 | ⚠️ 提醒前置依赖+办理入口 |
| 时间线风险 | 检查 blocked.eta | 软著申请>45天未到 | ⚠️ 提醒跟进+查询方式 |
| 数据异常 | 用户上报数据时 | 留存<15% / 次留<25% / DAU持续下滑 | ⚠️ 主动诊断+给方案 |
| 政策变动 | evolution-protocol 触发 | 检测到新规影响当前项目 | 📢 主动告知+调整建议 |
| 环境失效 | 执行层连续失败 | 同一脚本连续失败≥3次 | ⚠️ 降级提示+修复建议 |

### 监察约束

- **只告警有实际风险的**：不刷屏，不告警"一切正常"
- **告警必配方案**：只报问题不给方案 = 失职
- **可关闭**：用户说"别提醒XX了"→ 关闭该项监察（合规红线 RULE-XXX 不可关闭）
- **不阻断**：监察告警只告知，不强制停止用户工作（合规红线例外）
- **留痕**：所有告警记录到 project-state.risks，便于复盘

### 追踪与执行层的联动

```
执行层脚本运行 → 结果写入 project-state.risks →
  下次交互开始时 → 展示进度看板 → 自动展示未解决风险 →
  用户处理风险 → 风险标记为 resolved → 不再告警
```

这一闭环确保：执行层发现的问题不会被遗忘，每次交互都持续追踪直到解决。
