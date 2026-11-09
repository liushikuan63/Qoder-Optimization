---
name: byok-model-retry
description: "模型/BYOK 请求失败诊断与验收：401/403/429、空响应、首包超时、配置/网络/协议/流式终包/代理对照、UA 指纹、输出上限/maxOutputTokens、Qoder CN 保存校验与本地中转。默认只读，鉴权失败不重试，密钥只报掩码；覆盖 outerProvider/customModels、providers.qoder-custom-*、openai-responses、general.maxAttempts、QODER_DISABLE_MODEL_RETRY_PAYLOAD_GUARD、QODER_CONFIG_MODEL_RETRY_AFTER_PAYLOAD。"
---

# 模型访问诊断与 Qoder 版本参考

## 通用诊断入口（先读）

先读取 [通用流程](D:/qoder-data/qoder/tools/model-access-check/workflow.md)，按配置、网络/TLS、HTTP/API、协议、流式终包、代理/客户端分层取证，再判断修复边界。

本地检查器与自测：

```bash
node D:/qoder-data/qoder/tools/model-access-check/model-access-check.cjs --config <已知配置文件>
node D:/qoder-data/qoder/tools/model-access-check/model-access-check.cjs --help
node D:/qoder-data/qoder/tools/model-access-check/model-access-check.test.cjs
```

默认只读配置。访问上游必须明确启用 `--network`，一次可能计费的生成必须明确启用 `--generate`；多 provider 用 `--provider` 选定，不猜 Key、站点、UA 或模型。

增强探针（都要先有对应闸门，逐条只解决一层）：

- `--environment`：零成本只读环境变量层（TLS 校验被关、`NODE_EXTRA_CA_CERTS`、系统代理没排除回环）。只报变量名不回显值。本检查器直连目标不读环境代理——**curl 与它的结果可以合法地不同**，别急着说对方骗人。
- `--generate --repeat 2..5 --client-first-payload-ms`：多次采样出 TTFT p50/p95 与相对客户端首包阈值的余量，p95 达阈值 80% 判 `FIRST_PAYLOAD_MARGIN_LOW`。间歇性"超时"先测这个再改配置。
- `--generate --tool-probe`：强制 `tool_choice` 探针，观察到工具事件才把 `verified.toolRoundTrip` 置真；没观察到只判 warn（模型不遵从 ≠ 端点不支持工具）。
- `--cost-ledger <jsonl> --cooldown-ms`：计费探针台账与冷却窗口，窗口内在出网前就拒绝（`--force-billable` 才放行）。每条 check 带 `cost: free|billable`。
- 终包三态按规范处理：`response.completed` / `response.incomplete` / `response.failed`，`[DONE]` 可选。**incomplete 命中本次 `--max-output-tokens` 预算只判 warn**（链路已通、是我们自己截断的），不要报成上游故障去改配置。鉴权拒绝与限流（含 HTTP 200 流内 `rate_limit_exceeded`）会终止采样，不继续撞阈值。

将 401、HTTP 200 内错误、空响应、HTML、缺终包、断流分别分类；本地 `/_health` 或文件已修改不证明上游/生成/客户端成功。对照成功只能缩小边界，不证明连接池等具体根因。

[Qoder 现场与历史版本参考](D:/qoder-data/qoder/tools/model-access-check/qoder-runtime-reference.md) 保留重试机制、outerProvider/customModels 等专用能力。下方历史内容与并行会话补充原样保留，但旧版本样本、提前响应头、心跳和“已修”字样不能代替本轮真实验收；执行授权与诊断口径以通用流程为准。

新增/编辑 Qoder CN 自定义模型、判断“校验通过”是否有区分力，或接入需要改写 UA/header 的本地中转时，先读 [Qoder CN 自定义模型接入与保存验收](references/qoder-cn-custom-model-onboarding.md)。

## Qoder 专用历史内容（按版本核对）

## 适用范围与边界

**重试机制部分（§4）对官方模型与 BYOK 模型同样适用** —— 那是 AgentLoop 的通用路径，与模型来源无关。实测 168 次 `attempt_failed` 中官方模型占 155 次。

只有 §2（`outerProvider`）是 BYOK 专属。

| 章节 | 适用范围 |
|---|---|
| §1 终止形态分类 | 全部模型 |
| §2 `outerProvider is required` | **仅 BYOK** |
| §3 空响应 | 全部模型（BYOK 上游更易出现） |
| §4 重试机制与改法 | **全部模型** |
| §5 读混淆 bundle | 全部模型 |

- 通用「断言必须能失败、拿不到证据要标注未验证」纪律 → `verify-before-claim`。
- 客户端自身的安装 / 更新 / 迁移 → `disk-junction-migration`。

**前置认知（决定后面所有判断）**：Qoder 的 worker 是一个 **混淆后的单文件 bundle**，客户端大部分行为**没有配置面**，只能读源码常量。以下结论均从 bundle 实测解出，不是推测。

---

## 1. 先分类：五种终止形态

拿到「任务非正常结束」不要直接改配置，**先看日志确定是哪一类**。三类根因完全不同，改法也完全不同。

| 形态 | 日志特征 | 判定 | 适用 |
|---|---|---|---|
| **A. 启动即死** | 7–11 秒后 `process.exiting exit_code=1 reason="fatal_error"`，日志有 `get_model_policy failed ... outerProvider is required` | 客户端缺陷，**配置侧改不掉**（见 §2） | **仅 BYOK** |
| **E. 自伤：provider 全被丢** | 每个 run 若干条 `Custom provider "…" was ignored: … conflicts with an existing catalog model`，选模型即 `FatalRoutingError: … is not available` | 有人在 settings 里写了 `modelConfigs.customModels`（见 §2.4） | **仅 BYOK** |
| **B. 空响应** | HTTP 200 但 `streamEventCount=0`，约 5 秒后 `[ModelTransportError]: Provider returned an empty response` | 上游问题 → 重发可恢复（见 §3） | 全部（BYOK 更易出现） |
| **C. 401 鉴权** | `status=401, retryable=false` → `unauthorized client detected` | Key / 端点不对 → 换 Key 或端点 | BYOK |
| **D. 超时 / 断流** | `[ModelFirstPayloadTimeoutError]` 60s 未出首包、`TypeError: terminated`、`NetworkAttemptError` | 官方模型高发；**有重试预算却不重试**（见 §4） | 全部 |
| **F. 客户端指纹被拒** | 401 `unauthorized client detected, contact support ...`，**换任意 UA 头就 200** | 上游按 User-Agent 白名单拒陌生客户端，**Key 本身有效**（见 §3.5） | BYOK（中转站类上游） |

**D 类容易被误判成 B 类**：两者都是「流没读完」。区分看错误名 —— B 是 `ModelTransportError: Provider returned an empty response`，D 是 `ModelFirstPayloadTimeoutError` 或 `TypeError: terminated`。D 类**不需要改任何配置**，开 §4.4 的重试开关即可。

**日志位置**（两端各自独立，不要混）：
- CN 版：`%QODER_CONFIG_DIR%\logs\runs\<run-id>\qodercli.log`（同目录有 `manifest.json`，含完整 argv）
- 国际版：`~/.qoder/logs/runs/...`
- 目录在客户端运行中可能被 junction 迁到其他盘，**用 `env | grep QODER_CONFIG_DIR` 拿真实路径**，别硬编码盘符。

**manifest.json 是关键**：里面有完整 argv。`--model`、`--session-id`、各 flag 都在，判断调用形态必须看它。

---

## 2. 根因 A：`outerProvider is required`（客户端缺陷，配置侧改不掉）

### 2.1 触发条件（可失败判据）

集中在**轻量调用** —— argv 同时含 `--no-session-persistence` 与 `--max-turns`（后者通常为 1）。

实测（410 个 run 全量统计，CN 版 2026-09-30）：

```
轻量调用 + 报错 : 10 / 10
普通调用 + 报错 :  0 / 10
```

另外 `get_model_policy failed for title` 也会命中（标题生成），**非致命**，会话照常继续。

### 2.2 根因（bundle 实测，解码位 @32198266）

runtime 校验宿主回传的 model policy，判据等价于：

```js
const outer = policy?.parameters?.outerProvider;
if (policy.customModel) { if (outer) throw new Error(...); return; }
if (!outer) {
  const info = catalog.getModelExact(model);
  if (info?.outer_provider !== undefined ||            // catalog 有该模型，且带 outer_provider
      (info === undefined && isExternalKey(model)))     // catalog 没有，但键形如 provider/model
    throw new Error(`outerProvider is required for external provider model "${model}"`);
}
```

两条分支指向**同一个缺失**：调用方拼的 policy 里没有 `parameters.outerProvider`。**catalog 里有没有这个模型都不影响结果** —— 这正是"往 settings 注入模型表"治不了它的原因（2026-09-30 实证：注入生效后 13:34 仍报 `purpose=main` 的同款错误）。

### 2.3 结论：不要用配置绕过，只有两条路

- 没有配置面能补 `parameters.outerProvider`，那是客户端拼装 policy 的代码。
- 可行处置：**① BYOK 会话里避开轻量调用**（子代理 / `create_chat_session` fork / 一次性轻量请求），需要并行探索时临时切官方模型；**② 报给 Qoder 当缺陷**。
- "改 bundle 补上" 不算修法：bundle 只读且会被客户端更新覆盖（见 §6.4）。

### 2.4 ⚠️ 禁止：往 settings.json 写 `modelConfigs.customModels`（会把 BYOK 整个打死）

2026-09-30 我踩出来的事故，**这条曾经被写成"正解"，现在是反面教材**。

机制（bundle `replaceLocalModels` @19056798）：

```js
if (!this.userEntries.has(key) && !ownedByOtherSource && (!exists || sameAsPrev)) accept
else rejected.push(key)
```

`modelConfigs.customModels` 走 `setBYOKCustomModels → addUserModels`，把 `provider/model` 注册成**用户条目**；随后 `providers` 侧投影同一批键时命中 `userEntries.has(key)` 被 reject，而调用方对 reject 的处理是 `clearCustomProviderProjection()` —— **一个键冲突就清掉全部 provider**，全有或全无，不是逐条丢弃。

症状链：每个新 run 9~12 条 `WARN feedback.emitted Custom provider "…" was ignored: … conflicts with an existing catalog model` → catalog 里没有 BYOK 模型 → 选它即 `FatalRoutingError: Custom Provider model '…' is not available` → UI 弹「系统发生异常」。

时间线（`logs/runs` 全量逐 run 精确计数，已排除命令回显）：

| 时段 | run 数 | catalog 冲突 | outerProvider |
|---|---|---|---|
| 09-29 17:07 → 09-30 10:44 | 13 | **0** | 每 run 1 次 |
| 09-30 10:47 → 15:40（注入生效起） | 20 | 每个 run 都有，共 151 条 | **仍继续报** |

即：注入既没修好 A，又把本来能用的普通 BYOK 会话打死了。

### 2.5 已经写进去了怎么清

```bash
node <配置目录>/scripts/byok-modelconfigs-guard.js          # 只查：存在即 exit 1 并列出条目
node <配置目录>/scripts/byok-modelconfigs-guard.js --apply  # 备份后删除顶层 modelConfigs
```

删完**必须重启客户端**：provider 投影态活在进程里，同进程内新起的 run 不会重新投影（实测同一个 pid 下冲突计数不降）。重启后新会话验收：日志里冲突 = 0，选 BYOK 模型能正常出字。

### 2.6 核查 provider 真实参数

`contextWindow` 之类填错不会立刻报错，但会导致压缩阈值失真。直接问上游公开接口核对（不要凭印象）：

```bash
curl -s https://openrouter.ai/api/v1/models | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
d.data.filter(m=>/你的模型名/i.test(m.id)).forEach(m=>console.log(m.id,'ctx='+m.context_length));"
```

---

## 3. 根因 B：空响应（上游问题）

### 3.1 识别

```
status=200, streamEventCount=0, streamReadCompleted=false, isEmptyResponseBody=false
→ [ModelTransportError]: Provider returned an empty response
```

判定必须用**完整行**，不能只 grep 关键词（见 §6 假阳性陷阱）。

### 3.2 与上下文长度无关

实测同一批 run 内，**不到 40 条消息的会话与超过 1000 条消息的会话都复现**，`auto-compact` 全程 `state=below, usage=lt_50%`（远未到压缩阈值）。**不要往「上下文太长 / 该压缩了」方向排查** —— 那是浪费时间。

### 3.3 为什么会直接失败

`max_attempts=11` 但 `will_retry=false`、`retryable=false` —— 有预算却不重试。原因是空 body 落在「未产生 payload」分支，默认不允许重试。开开关可修，见 §4。

### 3.4 处置

上游偶发，**重发即可恢复**。若频繁出现，先开 §4 的重试开关，再考虑换 provider。

### 3.5 F 类：客户端指纹（UA 白名单）导致 401 —— 实测于 AgentRouter `ps.air-outer.com`

**现象**：UI 报「自定义模型认证失败，请检查 API Key 或相关配置是否正确」，日志
`Custom provider request failed: 401 unauthorized client detected, contact support ...`。
容易误判成 Key 失效，**其实 Key 没问题**。

**判定（20 秒可失败实验）**：同一把 Key 只换 `User-Agent` 打 `GET /v1/models`：

```
claude-cli/1.0.60 (external, cli) -> 200
codex_cli_rs/0.20.0               -> 200
Qoder/1.0.0 / axios / openai-node  -> 401 unauthorized client detected
不带 UA / 带 x-api-key / api-key 同样 401
```

**为什么连不带 Key 的请求也 401**：指纹在鉴权之前判，所以「no-auth 也 401」不能当"Key 坏了"的证据，必须做上面的 UA 对照。

**修法**：Qoder 没有自定义请求头配置面（UI 与 settings schema 均无 headers 字段），只能用本机反代改写 UA：

```js
// <本机辅助脚本>/byok-ua-proxy.js —— 127.0.0.1 反代，转发到上游并覆写 user-agent
headers['user-agent'] = 'claude-cli/1.0.60 (external, cli)';
```

然后把 provider 的 `baseUrl` 指向 `http://127.0.0.1:<port>/v1`（运行时允许 http，无 https 强制）。
自启用 Startup 下的 `.vbs` 循环守护（node 退出 10s 后重拉，仿 `CuaDriverServe.vbs` 写法）。
**验收判据**：代理侧 `Qoder/…` UA 请求返回 200；**负控**用错 Key 打代理必须仍 401（证明不是放行一切）。

**连带坑：模型可能不支持 `/v1/chat/completions`**。AgentRouter 的新模型（如 `gpt-6.1-sol`）会返回
`400 ... 请改用 /v1/responses`。此时 provider 的 `protocol` 必须是 `openai-responses`（UI 里的「Responses API」单选项，取值就是该字符串），否则 401 解决了也会立刻 400。

**另一类上游状态**：`rate_limit_exceeded`（如 `Your requests to gpt-6.1-sol ... exceeded token rate limit`）属额度/并发，换模型或等待，不属配置问题。实测与 UA 无关（`claude-cli` / `codex_cli_rs` 同一模型同时段同样返回），别按 UA 池排查。

### 3.6 G 类：60s 首包超时（上游慢，**不是**代理故障）—— 2026-10-26 实测

**现象**：走本机反代后仍频繁失败，容易误判成「代理超时」。

**判定（看代理日志，不看客户端报错）**：
- `outcome=CLIENT_DISCONNECTED elapsed_ms≈59900`，且该 `id` **没有** `REQ ... phase=headers` 行 ⇒ 客户端先放弃首包，代理和上游都没错。
- 客户端错误名为 `ModelFirstPayloadTimeoutError: Model stream timed out before response headers after 60s` 时，是同一件事（见 §4.1）。
- 代理自己的头超时叫 `UPSTREAM_HEADERS_TIMEOUT`（默认 300s，`BYOK_UA_PROXY_TIMEOUT_MS` 可调），**不会**在 60s 触发；把代理超时改小/改大都不影响这个 60s。

**根因**：上游首包常在 40–50s（实测 45s / 49s / 50.2s），撞上客户端 60s 硬阈值就断；该失败又被判定「不重试」（§4.1）。

**修法（代理兜底，已落在 `<本机辅助脚本>/byok-ua-proxy.js`）**：
- 请求带 `accept: text/event-stream` 且上游在 `BYOK_UA_PROXY_EARLY_HEADERS_MS`（默认 50000）内没回头时，代理先回 `200` + `x-byok-proxy-early: 1`，每 `BYOK_UA_PROXY_HEARTBEAT_MS`（默认 5000）写一行 `: byok-proxy keepalive` 保活；上游真头到达后转为正常 pipe。
- **阈值怎么选（2026-10-26 实测）**：客户端窗口 ≈ **早期头阈值 + 60s**（20s 阈值时断开点全是 80000±20ms；50s 阈值后正常请求不再撞 80s）。注释行心跳**不能**延长窗口，只有上游有效数据才会重置计时。阈值必须小于客户端 60s 首包上限，故取 50000（窗口 ≈110s）。
- 上游真头若为非 2xx：状态码已发出无法改，改以 SSE `{"type":"error","error":{"type":"upstream_http_error",...}}` 事件收尾并保留上游原文。
- **上游把错误塞在 200 的 SSE 正文里**（限流、它自己的 `context canceled`），光看状态码查不出来。代理会旁路嗅探前 8KB 并记一行
  `UPSTREAM_ERROR id=… kind=rate_limit|upstream_canceled|unauthorized|error_event`。**看到这行就是上游侧问题，不要再查本机**；正常响应不会记这行。
- 置 `BYOK_UA_PROXY_EARLY_HEADERS_MS=0` 即关闭早期头，退回纯透传（此时断开点回到 60s）。
- 早期头阈值 ≥ `BYOK_UA_PROXY_TIMEOUT_MS` 时**自动收紧到 `TIMEOUT-1`ms**（不再拒绝启动）。此前该组合会直接 `BYOK_PROXY_CONFIG_INVALID` 退出——把总超时调小做冒烟测试等于自建全站断网。生效值可在 `/_health` 的 `earlyHeadersMs` / `timeoutMs` 读到。
- 验收（假慢上游可复现）：头延迟 > 阈值 ⇒ `early=1` 且首包早于阈值；快上游 ⇒ `early=null`（行为不变）；上游 500 ⇒ 变成 error 事件。

**运维两条**：
- 改脚本**不会自动生效**，必须重启 node；用 `/_health` 的 `version` 与磁盘文件 `sha256` 前 12 位比对（实遇「磁盘已是新版、进程仍是旧版」）。
- 守护重复启动会抢端口：代理对 `EADDRINUSE` 保持进程存活并按 `BYOK_UA_PROXY_RETRY_BIND_MS`（默认 30s）重试绑定，前一实例退出后自动接管。

### 3.7 自建中转上游的接入顺序与四段验收

顺序颠倒会把协议问题误判成鉴权问题：

1. 先按 §3.5 做 UA 对照，确认是客户端指纹还是 Key 失效；**不要**把无 Key 请求的 401 当 Key 证据（指纹判定在鉴权之前）。
2. 本机回环反代改写 UA，provider 的 `baseUrl` 指到该端口；密钥留在凭据文件，不入脚本、日志与汇报。
3. 常驻自启属独立变更，需单独批准；进程归属与精确 PID 停启见 `local-reverse-proxy-triage`，不要顺手写 Startup。
4. 按模型切协议（§3.5 连带坑），鉴权与协议两类故障分开判。
5. 四段验收缺一不可：**正例问答 / 错 Key 负控（必须仍 401，证明反代没放行一切）/ 流式（首包与正常终态）/ 工具调用（参数完整、有终态）**。只跑通正例不得报"接入完成"。
6. 核对真实存储：provider 以 `settings.json` 的 `providers` 为准，`uid_customs` 为空是常态，不能据其判"没配上"；UI 编辑态禁选 API 类型是客户端限制，不是配置损坏。**禁止**写 `modelConfigs.customModels`（§2.4）。

### 3.8 "进程活着、接受连接、不转发也不报错"

直连同一请求打上游：直连 200 而经代理长超时 ⇒ 故障在该实例，不在上游。同代码换独占端口起临时实例做 A/B，再看连接表（到上游 0 条 ESTABLISHED + 本地 `CLOSE_WAIT` 堆积）。处置：去掉跨请求共享的 keepAlive 池、补上游超时与 `/_health`；清理断连监听 **`res.on('close')`**——`req.on('close')` 在请求体发完即触发，会把上游请求立刻打死（实测 2–5ms ECONNRESET）。验收覆盖顺序请求、并发流、并发中主动取消三种形态并保留不存在路径的负对照。新实例成功只缩小边界，未复现的根因（如连接池耗尽）按假设标注，不当结论。

代理层侧的超时归属三分类、假慢上游夹具与保活阈值算法以 `local-reverse-proxy-triage` 为真源，本节只保留 Qoder 客户端视角的观察，不在两处各写一套判据。

### 3.9 独立 HTTP/SSE 代理的审查与回归

无 Git 的独立脚本不套基于 diff 的评审：全文独立审阅 + 真实夹具回归。夹具用隔离的可信本地 TLS 上游与独占端口，先跑原版负向对照（原版必须判红），最小修复后跑同套断言。专项覆盖：压缩字节与 `Content-Encoding`、逐跳头剥离、DNS / 响应头 / 空闲超时、上传与响应取消、流中途失败、重定向、日志脱敏；模型 POST 不自动重试。

### 3.10 provider 调用链定位（客户端日志 → 复现 → 负对照）

“加了 provider 但用不了”按下面顺序取证据，不要只看界面回显：

1. 两侧 `settings.json` 逐 provider 导出（字段见 §2.6），`apiKey` 只打 head+len；同时检测**跨 provider 同名 model**（选择器里会重复，容易选错）。
2. 到 `~/.qoder/logs/runs/<ts>/qodercli.log` grep `[qoder-server-request]` 的 `-->` / `<--` 行，拿客户端真实 HTTP 状态与 URL；**界面回显不算证据**。日志时间戳是 UTC、本地 +8，按时间戳归因，不按 id；grep 要排除 `performance snapshot` 噪声。
3. 自己复现同一路径、同一种鉴权头；探针的 `max_output_tokens` 必须 ≥16，否则上游回 400 参数错——而 400 恰是“已过鉴权”的正证据，别读成模型坏了。先做无凭据负对照（如公开 `/models` 可 200），再解释带凭据的 200/401。
4. 按 401 / 403 / 404 / 429 分诊；401 先区分 Key 失效、UA 指纹（§3.5，同 Key 只换 User-Agent 的判别实验）与令牌种类错误（§3.11）。
5. 查 `config.cmd` 的 `BYOK_UA_PROXY_UPSTREAM` 确认代理指向；产出一个只读复验脚本交给用户，不代改配置；认证失败累计 3 次即停手，避免锁号。

### 3.11 凭据形态无损鉴定

不能看明文时，用无泄漏指标判断“是不是对的那类东西”：

- 只打印 `head(4-8)`、`len`、`sha256` 前 12 位、字符类别计数、前缀语义（`sk-` / `user_` / `eyJ…` JWT 段数）、是否含 `:` / 空格 / `\r\n`。
- 所有回显与日志做 `KEY→***` 反向替换。
- 区分 API Key / 登录令牌 / 用户名口令对；面板登录令牌不是 API Key。
- 从配置读取的值先校验 CRLF：尾部 `\r` 会让所有请求表现为“密码错误”。

### 3.12 双客户端配置块同步

同机两个客户端的 provider 配置需要同步时，按 [references/dual-client-config-sync.md](references/dual-client-config-sync.md)：掩码盘点 → 编码/行尾核对 → 备份 → dry-run/`--apply` 深拷贝合并（同 id 冲突不覆盖）→ 逐字段复扫 → 端到端凭据探针 → 安装包特征串确认。

---

## 4. 重试机制：能改什么、不能改什么

### 4.1 影响范围：官方模型同样中招（重要）

这不是 BYOK 专属问题。**AgentLoop 是所有模型共用的请求路径**，重试抑制发生在这一层，与模型来源无关。

实测全量统计（CN 版 397 个含模型的 run，2026-09-30）：

| 错误类型 | 模型来源 | 次数 | 重试耗尽 | **第 1 次即被抑制** |
|---|---|---|---|---|
| `ModelFirstPayloadTimeoutError` | 官方 | 99 | 0 | **99** |
| `ModelTransportError` | 官方 | 42 | 0 | **42** |
| `ModelTransportError` | BYOK | 13 | 0 | **13** |
| `TypeError: terminated` | 官方 | 11 | 0 | **11** |
| `NetworkAttemptError` | BYOK | 1 | 0 | **1** |

**最关键的一行**：168 次 `attempt_failed` 里，**exhausted（重试次数用完）= 0，suppressed（被判定不重试）= 168**。

判据：`attempt >= max_attempts` 才是耗尽。全部样本的 `attempt` 都是 1 或 2，而 `max_attempts=11` —— **一次都没用满就放弃了**。

典型官方模型样本（注意错误名与 BYOK 不同，但抑制行为一样）：

```
Model request attempt 1 failed before first payload, retrying: status=408, streamEventCount=0
  Error [ModelFirstPayloadTimeoutError]: Model stream timed out before response headers after 60s

Model request attempt 1 failed after reasoning-only payload (replay 1/2), retrying:
  status=200, streamEventCount=3  TypeError: terminated
```

**结论**：官方模型的网络超时、连接中断同样被「有预算不重试」吃掉。§4.4 的两个环境变量对官方模型一样有效。

### 4.2 机制全貌（bundle 实测）

**退避公式**（`toe()`）：

```
delay = min(baseDelayMs × 2^(attempt-1), maxBaseDelayMs) × jitter
```

| 参数 | 值 | 可配？ |
|---|---|---|
| `baseDelayMs` | 500 | ❌ 硬编码，无配置项 |
| `maxBaseDelayMs` | 32000 | ❌ 硬编码，无配置项 |
| jitter | 1.0 ~ 1.25 | ❌ 硬编码，无配置项 |
| **最大次数** | 默认 11 | ✅ **`settings.json` 的 `general.maxAttempts`** |

**间隔不可配，但次数可配**（这是最容易误判的一点，勿再当作"全硬编码"）：

```jsonc
// settings.json 顶层
{ "general": { "maxAttempts": 99 } }
```

schema 实测：`label: "Max Chat Model Attempts"`，`category: General`，`default: 11`，
`requiresRestart: false`，描述原文 —— *"Maximum number of attempts for requests to the main chat model. The default allows 10 retries; use 1 to disable retries."*

**读取链路**（bundle 实测）：

```
settings.json general.maxAttempts
  → Config: this.maxAttempts = mtt(A.maxAttempts)   // mtt: clamp(>=1) 否则回落 11
  → getMaxAttempts()
  → AgentLoop: maxAttempts = mtt(telemetryConfig?.getMaxAttempts?.() ?? lgA)
```

**优先级坑（必须知道）**：合并顺序由 `computeMergedSettings()` 决定 ——

```
j8n(user, workspace, isTrusted, local, flag)
  = Bft(Nft, defaults, user, workspace, local, flag)   // 后者覆盖前者
```

**`--settings`（flag）优先级最高，用户 `settings.json` 最低**；普通对象**递归深合并**，标量覆盖。
所以：客户端内联的 `general` 块**不会**整体覆盖你写的 `general.maxAttempts`（实测内联只有 `fileCheckpointing`），但若哪天客户端内联也带上 `maxAttempts`，**你的值会被静默覆盖**。改完务必用日志里的 `max_attempts=` 复验实际生效值，不能只看配置文件。

**次数放大的时间代价**：退避第 7 次起封顶 32s。99 次的最坏累计等待 ≈ **50~63 分钟**（含抖动），而默认 11 次约 3 分钟。想「多试几次」时先算这笔账。

**实际间隔**：第 1~8 次为 0.5s / 1s / 2s / 4s / 8s / 16s / 32s / 32s。

**等待实现**（`Zil()`）：把总 delay 按 30s 切片逐段 `await`，每段发一条 `api_retry` 事件 —— 所以长退避时能在日志里看到多条。

### 4.3 能不能改成 1s→3s→10s→20s→30s

**间隔不能，次数能。**

指数函数 `500 × 2^(n-1)` 在 n=1..5 输出 500/1000/2000/4000/8000，与目标序列逐项不匹配。任何 base 与 factor 的组合都无法产生 1s→3s 这种非等比跳变。base / cap / jitter 三项**没有任何配置入口**（已把 settings schema 与 env 读取点全枚举确认）。

**唯一实现途径**：改 bundle 里的硬编码常量。代价：bundle 在 `Program Files` 下只读、需管理员、**Qoder 更新后被覆盖需重做**。

```bash
# 定位（路径随客户端版本变，别写死）
"<安装目录>/resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-*-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs"
```

改法：把 `toe()` 换成查表（`[1000,3000,10000,20000,30000][attempt-1] ?? 30000`，jitter 置 1）。次数别再改 `lgA` 常量 —— 用 §4.2 的 `general.maxAttempts` 即可。改完**必须**做 `node --check` 语法校验，并保留备份 —— 这个文件决定客户端能否启动。

### 4.4 能改的：放宽重试判定（推荐先做）

两个环境变量，**无需改文件、无需管理员、可逆、Qoder 更新不失效**：

| 变量 | 值 | 作用 |
|---|---|---|
| `QODER_DISABLE_MODEL_RETRY_PAYLOAD_GUARD` | `1` | 让「未产生 payload 的失败」也进入重试 |
| `QODER_CONFIG_MODEL_RETRY_AFTER_PAYLOAD` | `true` | feature gate `model_retry_after_payload`，默认 `false`，同效果 |

```powershell
# 用户级持久化（当前用户 + 后续新进程）
$k='HKCU:\Environment'
Set-ItemProperty -Path $k -Name 'QODER_DISABLE_MODEL_RETRY_PAYLOAD_GUARD' -Value '1' -Type String
Set-ItemProperty -Path $k -Name 'QODER_CONFIG_MODEL_RETRY_AFTER_PAYLOAD'  -Value 'true' -Type String
```

**验证**：读注册表确认值 + 用客户端同款 `Pl()` / `ML()` 布尔解析函数验证；**负控**（`"false"` / `"0"` / 未设）必须为 falsy。

**撤销**：把值设为 `0` / `false`，或 `Remove-ItemProperty`。

### 4.5 为什么 env 变量对 worker 有效（原理）

`config-service` 有**两个互斥 source**，装第二个会抛 `Config source already initialized`（`z2A()`）：

| 装设函数 | 实现 | 数据来源 |
|---|---|---|
| `vL()` | `m2A` 类，`getValue(A) = environment[kWa(A)]` | **`process.env`** |
| `W9s()` | `$Rt` 远程源 | `gateway.qoder.com.cn`，`namespaces: ["qodercli-feature-gates"]` |

**worker（headless）走 `vL()`（env 源）**；`W9s()` 只在主进程 UI 侧用。所以 env 变量对 worker 有效。

键名规则（`kWa()`）：`QODER_CONFIG_` + 驼峰转大写下划线。
例：`model_retry_after_payload` → `QODER_CONFIG_MODEL_RETRY_AFTER_PAYLOAD`。

### 4.6 管不到的一类

`empty_assistant_completion` 类错误（`EmptyAssistantCompletionError`，自带 `retryable=!0`）走**另一条分支**，硬上限 **2 次**，`R9i()` 管不到。判断方法：日志里 `emptyAssistantCompletion.reason` 字段有值即是这一类。

### 4.7 抬 maxOutputTokens 后的行为验收

只把配置数字改大是假绿，按四步验收：

1. **先探上游**：用最小请求确认旧值不是硬限制（如 8192 / 32768 / 65536 各发一次，看是否 200 completed）。
2. **改配置**：`backup-file.js --label` 留快照 → 逐行锚定正则 dry-run 报命中数 + 负对照 → 保 EOL 定点替换；**禁止整文件 JSON 往返**（会改缩进/尾换行）。
3. **配置层复验**：`JSON.parse` 通过、目标值全中且旧值零残留、与备份逐行 diff 只剩预期行、总行数不变。
4. **行为层复验**：发一次真实请求，产出**超过旧上限**的输出（如 `output_tokens=23893 > 8192` 且 `incomplete_details=null`），才算消掉原失败模式。

同一套口径可套到连接池、超时、分页 size：先证明旧值不是硬限制，再改，再用一次跨过旧上限的真实请求收口。

**8192 是客户端固定值时的 A/B 定性**：直连 `max_tokens=8192` 应得 `finish_reason=length`；抬到 65536 应得 `stop`；省略字段不截断 ⇒ 上限来自客户端。修复走本地代理路由表改写时，验收看代理日志 `REWRITE field=… from=8192 to=65536`，且 `/_health` 的 `version` == 磁盘 sha256 前 12 位。`settings.json` 改动用 JSON 往返恒等 + 只允许 1 行 diff 断言，写后看 mtime 是否被运行中客户端回写；改 `baseUrl` 必须重启客户端才生效，本会话无法前台验证时如实声明。另：`/models` 不带 `Authorization` 也回 200 且响应体逐字节相同 ⇒ 公开端点，禁止当密钥有效的证据；端口 `18765/18766/18767` 都要查，可能存在第三实例。

---

## 5. 读混淆 bundle 的探针

客户端行为没有文档，只能从 bundle 取证。**别用 shell grep 硬找**（31MB 单行文件会卡死），用 Node 脚本。

### 5.1 字符串解码（必做第一步）

bundle 里所有面向用户 / 内部的字符串都经过 `_$d()` 混淆：

```js
function deob(b64, key = 'dO6Gd3osas9e') {
  const b = Buffer.from(b64, 'base64');
  const o = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i++) o[i] = b[i] ^ key.charCodeAt(i % key.length);
  return o.toString();
}
// 正则抓 _$d("...") 再 deob
for (const m of s.matchAll(/_\$d\("([A-Za-z0-9+/=]+)"\)/g)) console.log(deob(m[1]));
```

### 5.2 定位技巧

- **按已知字面量反查**：`s.indexOf('outerProvider')`、`s.indexOf('Provider returned an empty response')`（后者是原始英文，未混淆）。
- **按日志原文反查**：日志里 `debug.message [QueryEngine] Query failed:` 这种固定前缀一定在 bundle 里，用它当锚点前后各取几千字符。
- **按常量赋值反查**：`Yil=32e3,jil=3e4,Wil=500` 这种压缩后的声明，`indexOf` 找 `=32e3` 更快。
- **按行为反查**：想知道 maxAttempts，直接找 `max_attempts` 附近 `attempt=` 的组装处。

### 5.3 纪律

- 探针脚本放**临时目录**，用完即删；不要落进技能目录或项目。
- bundle 路径**随版本变**，别写死盘符，用通配或从 `manifest.json` 的 `argv[0]` 推导。
- 解码出的**常量值要交叉验证**：至少两处独立位置对得上再采信。

---

## 6. 陷阱清单

### 6.1 日志假阳性（最容易踩）

日志会**原样回显你自己 Bash 命令的参数**：

```
tool.requested tool_name="Bash" args={"command":"grep -n 'Provider returned an empty response' ..."}
```

直接 `grep 'Provider returned an empty response' log` 会把**自己的命令**当成命中，得出完全错误的结论。

**正确做法**：用带上下文的完整行判定：

```js
const EMPTY = /model\.request\.attempt_failed[^\n]*error_message="Provider returned an empty response"/;
```

### 6.2 逐目录 shell 循环会超时

`for d in */; do grep ... done` 在几百个 run 目录上必然超时（实测卡死后被移到后台）。

**正确做法**：单次 Node 脚本 `readFileSync` 全量读 + 内存聚合。

### 6.3 混淆函数名每次版本可能变

本技能记录的 `toe` / `nol` / `Wil` / `R9i` 等名字来自 2026-09-30 的 CN 版 `0.4.3`。**换版本后先按 §5 重新定位**，不要直接照抄名字。

### 6.4 bundle 只读 + 会被更新覆盖

`Program Files` 下普通用户无写权限。**且 Qoder 自动更新会整个替换** —— 改过的 bundle 会静默失效。每次改完要在文件旁留一个说明文件记录改了什么，方便更新后重做。

### 6.5 环境变量只对新进程生效

写完 `HKCU:\Environment` 后，**已运行的客户端读不到**。必须重启客户端（不是重开会话）。这和你自己记忆里的「npm 缓存迁移后环境变量只对新进程生效」是同一条规律。

---

## 7. 排查执行顺序

1. **拿日志真实路径**：`env | grep QODER_CONFIG_DIR` → `<dir>/logs/runs/`。
2. **定形态**：看最后一个 run 的 `qodercli.log` 尾部 + `manifest.json` 的 argv → 套 §1 表格分类。
3. **A 类（仅 BYOK）** → 按 §2.3：这是客户端缺陷，**不要动配置**；避开轻量调用或报缺陷。若 settings 里已有 `modelConfigs.customModels`，按 §2.5 清掉（它既修不了 A，又会造出 E 类）。
4. **B 类** → 按 §4.4 开重试开关（推荐），或换 provider。
5. **C 类（BYOK）** → 先做 §3.5 的 UA 对照实验（中转站类上游最常见，Key 往往没问题），再做 Key / 端点核对；注意 401 与 403 语义不同。
6. **D 类（全部模型，最常见）** → 直接按 §4.4 开重试开关；不需要改任何配置。
7. **要加重试次数** → 设 `settings.json` 的 `general.maxAttempts`（§4.2），**先按 §4.2 末尾算时间代价**。
8. **要改间隔序列** → 评估 §4.3 的代价（管理员 + 更新失效），多数场景不值得。
9. **重启客户端** → 用新 run 复验（这是唯一能证明生效的方式）。复验看两处：日志 `max_attempts=<你的值>`、以及出现 `retrying` 而非 `not retrying`。
10. **沉淀**：把新版本解出的常量与配置键更新进本技能，并写进记忆。

---

## 8. 收尾自查

- [ ] 改 `settings.json` 前已备份
- [ ] **没有**往 settings 写 `modelConfigs.customModels`（它会把全部 custom provider 清掉，见 §2.4）；已有的按 §2.5 清掉并重启复验
- [ ] schema 校验有负控（能判红）
- [ ] 配置类改动**跑过合并链复验**（复刻五源优先级 + 归一化函数），并含「flag 侧同键会覆盖用户值」的负控
- [ ] 统计类结论给了分子分母（如 168/168 而非「大部分」）
- [ ] 区分了「重试耗尽」与「被抑制」——判据是 `attempt >= max_attempts`，不能只看 `will_retry=false`
- [ ] 结论标注了适用模型范围（BYOK 专属 vs 官方+BYOK 通用）
- [ ] 放大重试次数前算了最坏等待时间
- [ ] 环境变量在 `HKCU` 而非 `HKLM`（免管理员、可逆）
- [ ] 未验证项显式标注「未验证 + 原因」（如「需重启，当前会话仍是旧环境」）
- [ ] 探针脚本已从临时目录删除
- [ ] 密钥未进入源码 / 日志 / 汇报 / 分享包
- [ ] 脱敏门禁跑过（分享包场景：数字可能命中内网网段关键词）
