# 四层产物与提示词示例

> 用法：生成前读一遍，对照颗粒度。示例里的版本号只示范格式，落笔时现查并标注日期。
> 带 `<!-- fixture:xxx -->` 的代码块会被校验脚本抽取做正例回归，改示例时别破坏块边界。

## 1. 宪法：AGENTS.md（项目根，200–500 行以内）

<!-- fixture:AGENTS.md -->
````markdown
# 项目：会议室预订

## 30 秒地图
- 入口：`src/main.tsx`（前端）、`server/index.ts`（API，端口 3001）
- 核心领域：`src/features/booking/`
- 持久化：`server/db.ts`（better-sqlite3）
- 禁止：在组件里直接拼 SQL；在应用层绕过 `bookingApi`

## 命令（每次修改前先跑）
- 安装：`pnpm install`
- 类型：`pnpm typecheck`
- 构建：`pnpm build`
- 测试：`pnpm test`；单项：`pnpm vitest run -t "<name>"`
- 提交前：`pnpm lint && pnpm typecheck && pnpm test`

## 硬约束 / 禁区
- 不得跳过测试；失败必须修复或在 IMPLEMENTATION_LOG.md 记录风险
- 预订冲突必须由数据库唯一约束兜底，不能只靠前端检查
- 时间计算一律用 date-fns，禁止手写 Date 运算
- 不引入 UI 组件库；不新增未在 plan.md 中列出的依赖

## 按需阅读
- 功能契约：`spec.md`
- 当前计划：`plan.md` / `tasks.md`
- 失败经验：`DISCOVERIES.md`
- 实施日志：`IMPLEMENTATION_LOG.md`

## 当前会话规则
- 一次只完成 `tasks.md` 中的一个任务
- 先读相关文件，再给 3–7 行变更方案；只输出已变更文件的 diff
- 验收失败：写命令、最后 30 行输出、最小复现，停止，不宣布完成
````

### 跨工具桥接（各工具只留一行入口，不复制长文）

<!-- fixture:CLAUDE.md -->
````markdown
@AGENTS.md

## Claude 专有
- 优先使用只读子代理做代码考古，返回 ≤1500 字摘要
````

- Copilot：直接读目录树最近的 `AGENTS.md`；路径规则用 `applyTo`。
- Gemini CLI：`context.fileName` 配 `AGENTS.md`，或 `GEMINI.md` 里 `@AGENTS.md`。
- Cursor：保留 `AGENTS.md`；`.cursor/rules/*.mdc` 写 `globs` / `alwaysApply`。

## 2. 窄契约：spec.md（默认 6 节，只写 what/why）

<!-- fixture:spec.md -->
````markdown
# 会议室预订（功能契约）

强度: 中
判据: 内网 20 人团队、单人维护、预计使用 3 个月

## 1. 目标与成功画面
内部 Web 工具：员工查看本周会议室占用并自助预订/取消。打开即见本周网格，没有登录页和首页。

## 2. 明确不做
- 不做登录 / 鉴权（用户名从 localStorage 读取）
- 不做审批流、不做跨周预订
- 不做移动端适配（仅 ≥1280px）
- 不做邮件 / IM 通知
- 不做会议室管理后台

## 3. 关键路径
- UC1: 员工打开首页 → 看到本周网格 → 已占用灰、空闲白
- UC2: 员工点空闲格 → 右侧抽屉填主题/时段 → 提交 → 网格即时变灰
- UC3: 员工点自己的预订 → 取消 → 网格恢复空闲
- UC4: 提交时他人已抢占 → 提示"该时段已被预订"并刷新网格

## 4. 数据与行为约束
- 同一会议室同一时段只能有一条有效预订（由数据库唯一约束兜底）
- 时段为 8–20 整点；date 用 `YYYY-MM-DD`，时区固定本地
- 取消后立即释放时段；已过去的时段不可预订
- 不建用户表；owner 只是本地显示名

## 5. 非功能约束
- 网格首屏可交互 < 2s（内网）
- API 失败统一 toast 展示 `error.message`；表单错误显示在字段下方
- 时间计算用 date-fns，禁止手写 Date 运算
- 注释中文，只解释"为什么"

## 6. 验收标准
```bash
pnpm typecheck && pnpm build
```
- [ ] UC1–UC4 手动走通
- [ ] 并发提交同一时段：一个 201、一个 409 CONFLICT
- [ ] 后端停掉时页面显示可重试 toast，不白屏
- [ ] 最终检测审计：`production-readiness-audit` 报告经 `readiness-report-check.cjs` 校验 exit 0（不适用项已写理由，前十问题已处置或已批准延后）
````

## 3. 高配加档（仅 `强度: 大`；小项目不要抄）

<!-- fixture:spec-heavy.md -->
````markdown
# 会议室预订（功能契约）

强度: 大
判据: 跨 3 个团队共用、需长期维护、有对外 API、涉及权限与审计

## 1. 目标与成功画面
员工查看本周会议室占用并自助预订/取消。打开即见本周网格。

## 2. 明确不做
- 不做跨周预订
- 不做移动端适配
- 不做邮件 / IM 通知

## 3. 关键路径
- UC1: 员工打开首页 → 看到本周网格 → 已占用灰、空闲白
- UC2: 员工点空闲格 → 填表单 → 提交 → 网格即时变灰
- UC3: 员工点自己的预订 → 取消 → 网格恢复空闲

## 4. 数据与行为约束
- 同一会议室同一时段只能有一条有效预订
- 取消后立即释放；已过去时段不可预订
- 权限：仅本人可取消自己的预订；管理员可取消任意预订

## 5. 非功能约束
- 首屏可交互 < 1.5s（内网）
- 所有写接口必须带审计日志（who / what / when）
- 失败统一 `{ code, message, requestId }`

## 6. 验收标准
```bash
pnpm typecheck && pnpm test && pnpm build
node ~/.qoder/scripts/readiness-report-check.cjs "<报告路径>/readiness-report.json" --json
```
- [ ] UC1–UC3 手动走通
- [ ] 并发提交：一个 201、一个 409 CONFLICT
- [ ] 非本人取消返回 403，且审计日志有记录
- [ ] 空态 / 加载态 / 错误态 / 成功态各有一条截图
- [ ] 最终检测审计：`production-readiness-audit` 覆盖全部清单 ID，报告校验 exit 0；前十问题按泄露 / 资金 / 中断排序，每条有文件定位与处置结论
- [ ] 权限与审计日志项由人工复核签字（agent 做过 ≠ 有人负责）

## 7. 技术栈与依赖冻结
- Vite / React / TypeScript / Tailwind / Zustand / date-fns（待定：执行者选当前 LTS 并回报，或现查后标注查询日期）
- 禁止：Redux、MUI、antd、dayjs

## 8. 目录与文件边界
```text
src/features/booking/   组件 / store / api
src/types/index.ts      唯一类型定义处
server/routes/booking.ts 预订路由
```

## 9. 字段级数据模型与接口契约
```ts
type Booking = {
  id: string; roomId: string; date: string; startHour: number; endHour: number;
  title: string; owner: string; createdAt: number;
};
```
```text
POST /api/bookings → 409 { code: 'CONFLICT', message, requestId }
DELETE /api/bookings/:id → 403 { code: 'FORBIDDEN', message, requestId }
```

## 10. UI 规格
- 空态：插画 + "预订第一场会议"按钮
- 加载态：网格骨架屏，宽度不跳动
- 错误态：顶部红色 banner + 重试
- 成功态：网格渲染数据，提交后格子即时变灰
````

## 4. 计划：plan.md（≤60 行，获批后执行，不长期维护）

<!-- fixture:plan.md -->
````markdown
# 计划：会议室预订（spec UC1–UC4）

## 改动集合
- 必改（5）：`src/types/index.ts`、`server/db.ts`、`server/routes/booking.ts`、`src/features/booking/api/bookingApi.ts`、`src/features/booking/components/WeekGrid.tsx`
- 可能受影响（2）：`src/App.tsx`、`vite.config.ts`

## 方案
- 首选：Express + better-sqlite3 单表 `bookings`；前端本地状态 + 提交后刷新本周
- 回退：内存数组（不持久化）；代价：重启丢数据

## 技术栈与依赖
- 新增：express、better-sqlite3、date-fns
- 不引入 UI 库；不升级既有依赖

## 验证
- `pnpm typecheck && pnpm build`
- 两条并发 POST 同一时段 → 期望 201 + 409
- 关闭后端 → 页面出现可重试 toast，不白屏

## 回滚
- `git revert <sha>`；删除 `server/data.db`

## 风险
- 并发唯一约束必须靠数据库，不能只靠前端检查
````

## 5. 任务：tasks.md（一卡一验收，300–700 字）

<!-- fixture:tasks.md -->
````markdown
## T-01：数据层与后端

### 只做
- 建立 `bookings` 表与唯一约束（roomId + date + startHour）
- 实现 GET /rooms、GET /bookings、POST /bookings、DELETE /bookings/:id
- POST 冲突返回 409 `{ code: 'CONFLICT', message }`

### 明确不做
- 不做鉴权、不做分页、不做跨周查询
- 不动前端代码

### 入口
`server/routes/booking.ts:1-120`、`server/db.ts:1-60`

### 验证
- `pnpm typecheck`
- 两条并发 POST 同一时段 → 201 / 409
- 删除后同时段可再次预订
````

## 6. 验证日志：IMPLEMENTATION_LOG.md（真实输出，不是自述）

<!-- fixture:IMPLEMENTATION_LOG.md -->
````markdown
# 实施日志

## 2026-10-27 T-01
- `pnpm typecheck` → exit 0
- `pnpm test --filter api` → exit 1
- 失败：并发 POST 第二次返回 500（期望 409）
- 最小复现：同 body 两次 POST，头 `Idempotency-Key: k-1`
- 处理：检查唯一约束捕获分支；未宣布完成
````

## 7. 运行时提示词

**只读研究 → 计划**：

```text
进入只读模式，禁止编辑。目标：实现会议室预订（spec UC1–UC4）。
1. 读 AGENTS.md、spec.md、相关入口；
2. 列出最多 5 个必改文件、3 个可能受影响文件；
3. 给首选方案、回退方案和代价；
4. 识别并发、迁移、缓存风险；
5. 写出验收命令、预期结果、回滚步骤。
计划写入 plan.md，≤60 行；有歧义先问，不擅自选型。
```

**单任务实现（带验证闭环）**：

```text
只实现 tasks.md 中的 T-01，禁止顺手重构其他模块。
锚点：server/routes/booking.ts:1-120。
先给 3–7 行变更方案，再编辑；只输出变更文件的 diff，不回显未改动代码。
完成后运行：pnpm typecheck && pnpm test --filter api -t "booking"。
失败：把命令、最后 30 行输出、最小复现写入 IMPLEMENTATION_LOG.md，停止，不宣布完成。
```

**计划获批后（清空规划上下文）**：

```text
计划已批准。新会话只带：AGENTS.md、spec.md、plan.md、tasks.md 的 T-01。
不要复述之前的探索过程，直接从 T-01 开始。
```

**子 agent 委托（只读、限额、要证据）**：

```text
研究：定位 POST /bookings 的冲突处理与唯一约束。
只读、不改文件；探索预算 10 个文件、5 条命令；返回 ≤1500 字；
必须给 file:line 证据、结论、风险和至少 3 条未决问题；不返回完整文件内容。
```

## 8. 版本与数字的写法

```text
1. 用户给定：React 18.3.1
2. 现查官方：Vite 7.1.x（查于 2026-10-27，npm view vite version）
3. 暂不确定：Zustand 待定：执行者安装当前 LTS 并回报
```

禁止写"用个合适的""最新版即可"——执行者会替你做选择，而你不一定同意。
