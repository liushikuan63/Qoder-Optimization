# Codex 能力与 Qoder 包承接图

盘点日期：2026-11-06。此图将本机实际存在的个人方法、当前会话暴露的工具类别与 Qoder 可分发实现分开记录；不是对任意机器、账号或模型可用性的承诺。

## 能力分层

| 层次 | 本次看到的能力 | Qoder 的承接方式 |
| --- | --- | --- |
| 本地执行与工程工具 | 文件读取/补丁、Shell 子进程、Git 与工作树、工具输出和进程状态核对 | 可分发 Node/Git 工具及操作规则；安装后从准确客户端入口执行 |
| 编排与验证方法 | 任务相关技能发现、只读与写入边界、依赖分析、独立验收、真实退出码和首红证据 | 已有路由、完整工作流、并行计划/写入核验、交付技能；按缺口补强，不重复造同域入口 |
| 个人专项方法 | 15 个个人技能目录，覆盖 API、浏览器、数据库、无障碍、性能、Rust、Spring、CI、技能维护、跨 Shell、接续、自进化与交付 | 下表逐项映射；个人技能数量不是 Codex 全部能力数量 |
| 当前宿主工具类别 | 浏览/搜索、图像生成、文档/表格/演示、后台电脑控制、持久 REPL、应用连接器、文档查询及安全扫描等注册入口 | 可移植选择与验证方法；连接器、原生服务、账号和具体工具仍是独立前置。注册存在不证明已连接账户或完成调用 |
| 会话与权限机制 | 原生会话、代理调度、审批/沙箱、记忆、自动化与应用管理的运行时 | 使用目标宿主真实支持的机制。不得靠复制配置、删除锁或长期运行另一个宿主服务冒充接续或授权 |

会话管理、自动化及原生服务的具体入口必须在本次宿主重新发现。当前盘点没有取得原生创建/归档聊天或自动化管理工具的调用证明；这里记录宿主能力边界，不将旧工具名或文件说明当作当前已接通接口。

## 15 个个人技能的对应关系

| Codex 个人技能 | Qoder 当前承接 | 状态与独有边界 |
| --- | --- | --- |
| `local-api-contracts` | [同名技能](../../local-api-contracts/SKILL.md) | 正文已覆盖；按项目实际接口和版本执行 |
| `local-browser-e2e` | [同名技能](../../local-browser-e2e/SKILL.md) | 基本流程已覆盖；已补入动效/主题的可观察验收，避免只看 class、动画数或静态截图 |
| `local-db-migrations` | [同名技能](../../local-db-migrations/SKILL.md) | 正文已覆盖；迁移、数据与环境授权另核 |
| `local-frontend-a11y` | [同名技能](../../local-frontend-a11y/SKILL.md) | 正文已覆盖；随受影响交互检查，不扩成所有前端任务的固定审计 |
| `local-performance-evidence` | [同名技能](../../local-performance-evidence/SKILL.md) | 正文已覆盖；基线、瓶颈、对照和停止条件随真实任务确定 |
| `local-rust-engineering` | [同名技能](../../local-rust-engineering/SKILL.md) | 正文已覆盖；沿项目锁定工具链与运行边界 |
| `local-spring-mybatis` | [同名技能](../../local-spring-mybatis/SKILL.md) | 正文已覆盖；不以通用建议覆盖仓库 JDK/Spring 版本 |
| `local-parallel-write` | [parallel-orchestration](../../parallel-orchestration/SKILL.md) 及包内计划、上下文和写入工具 | 已有可执行承接；基线/ownedPaths/依赖、共享 Git 配置、逐提交范围和真实集成验收都须保留；worktree 不是安全沙箱 |
| `local-skill-quality` | [引用审计](../../skill-reference-integrity-audit/SKILL.md)、[描述路由](../../skill-description-route-cue-rewrite/SKILL.md)、[能力让渡](../../skill-trim-with-capability-transfer/SKILL.md)及落地闭环 | 方法已有分工；已增强引用覆盖及错误分类，保留嵌套/中文/多扩展名、递归终止和读取失败边界 |
| `windows-project-workflow` | 现有 Windows Shell 技能、完整工作流规则 | 已补入实际 argv 对照、解释器/编码/退出码诊断；多栈预检方法由完整工作流与现有专项技能承接。不得统一全机工具链或执行 setup/build 猜版本 |
| `local-development-delivery` | [verify-before-claim](../../verify-before-claim/SKILL.md)、[分享包发布](../../share-package-release/SKILL.md)、[仓库文档](../../write-repowiki/SKILL.md) | 已补入通用开发交付参考：行为→可分享实现→依赖→接线→真实触发→结果，以及干净安装/旧环境增量与独立实装 |
| `github-ci-evidence` | [CI 定性](../../diagnose-github-actions-quota/SKILL.md)、[成本审计](../../audit-ci-cost-levers/SKILL.md) | 已有同域入口；零步骤/404/短运行时间只作线索，必须核对真实 job/step/annotations 与可比成功 run；费率和额度现查 |
| `self-evolution` | [同名技能](../../self-evolution/SKILL.md)与 Node 记录/暂停/快照/回退工具 | 方法和可执行机制已有承接；不搬 Python 状态库或个人历史。经验门槛、暂停、当前授权与回退后置摘要都要保留 |
| `local-chat-continuation` | [接续审计](../../continuation-state-audit/SKILL.md)、[目标执行](../../goal-driven-execution/SKILL.md)、checkpoint/队列检查 | 通用交接方法已有；Codex 原生线程/写入者验收器不能当 Qoder 原生适配。用目标宿主入口证明实际继续，创建 ID 或保存文件不算接续完成 |
| `local-native-computer-use` | 现有桌面自动化、UI 取证与 CUA 守卫 | 方法可提炼；Codex 原生包、REPL 模块与服务端点属于宿主。先后台接口，再合适的电脑控制；每次输入绑定准确窗口并读回结果，未知状态不盲目重放 |

本机七个 `local-*` 专项技能去掉元数据后，有六个正文已经相同；浏览器技能新增的动效/主题参考是此次发现的实质差异。不同 description 不自动等于功能缺失。

## 安装与使用闭环

1. 核对当前客户端已装能力、可信旧包和本地定制。可追溯且未修改的旧副本才能安全更新；定制与来源不明项保留审查。
2. 缺失的通用或明确偏好能力才询问安装，无关专业项跳过。当前明确选择的依赖闭包随选择处理，不把一次回答静默写成长期偏好。
3. 已安装且相关的能力进入提示与真实加载入口；当前明确选用或必要调用直接执行。只读载入不代替能力内部外部写入或费用动作所需的授权。
4. 新能力须从实际分发包安装，检查准确入口/依赖/注册接线，执行正例、失败例与正常放行对照。缺少宿主工具或账号时明确前置，文件存在不算能力已生效。

## 来源与改写

本次基于个人技能正文和公开支持实现作能力映射，沿用已在包内承接的同域技能；不分发用户配置、账号、凭据、聊天、记忆或服务状态。新增方法独立整理，第三方技能已有许可与来源文件继续保留。Shell 与技能质量方法的上游未见独立明确许可时，只提炼不变量并独立实现，不把整份第三方脚本改名搬入。动效/主题方法沿原参考保留来源说明；平台与工具接口须以本次实际文档和运行结果为准。

## 官方资料与安装边界

OpenAI 的技能机制采用按需披露，名称/描述用于选择，正文与资源按任务加载；本图将方法适配到 Qoder 自己的发现与安装入口。会话、权限、连接器及服务由目标宿主提供，不随本包获得。参考 [Build skills](https://learn.chatgpt.com/docs/build-skills) 与 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。

表内链接指向分享包内的来源地图，并不代表每个可选技能已经安装。实际调用先从当前客户端检索已安装入口；按需技能单独安装不自动带入全部地图条目。
