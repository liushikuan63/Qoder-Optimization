---
name: proxy-rule-surgery
description: 批量、持久地修改 FlClash/mihomo 分流规则并证明生效。触发词：FlClash 规则、mihomo 分流、config.yaml 被覆盖、rules 表、database.sqlite、按进程名杀被拦、出口 IP 对比、cdn-cgi/trace。含备份、按 schema 写入、精确 PID 重启、UI 启动兜底与负对照。不用于本机自建反代（local-reverse-proxy-triage）。
---

# 代理分流规则持久化与生效验证

## 适用

- 要给 FlClash / mihomo / Clash 系客户端新增或修改分流规则，并确保重启后仍生效。
- 改 `config.yaml` 后规则被覆盖、不重载，或重启后代理端口不监听。
- 需要证明某域名真的走了目标节点，而不是只看客户端显示。

产品专用数据库路径、表结构与 UI 兜底见 [references/flclash-mihomo.md](references/flclash-mihomo.md)。

## 1. 先找“源”，再改

- 多数 Clash 系客户端把用户配置存数据库（如 `database.sqlite` 的 `rules` 表），`config.yaml` 只是**生成物**；直接改 YAML 会被下一次生成覆盖或不触发重载。
- 判定真源：改数据库后重启，观察 YAML 是否被重新生成；或查客户端的 profile/配置存储位置。
- 改前备份数据库与 YAML；记录文件 SHA-256。

## 2. 按 schema 写入，不手搓整段 YAML

1. 读表结构（`PRAGMA table_info(rules)`）与现有行，确认字段、默认值、排序字段。
2. 新行 id 取 `max(id)+1`；排序字段按客户端语义取“更优先”的值（常见是更小的数字或更靠前的字符串），不要假设。
3. 同批插入后回读新行，确认字段完整。
4. 若客户端要求同步修改运行时配置/YAML，按它的格式同步；不同步就验证是否只认数据库。

## 3. 重启与启动兜底

- 只按**精确 PID**结束进程：先列候选 PID + 命令行 + 路径，再做一条负对照（同镜像名的无关进程不会被选中），然后结束。按镜像名批量杀会被风险守卫拦截，也可能误伤。
- 内核可能随 GUI 一起退出；重启 GUI 后代理端口未必自动监听，界面可能停在“未运行”。
- 需要点击 UI 启动时：优先 UIA；Flutter 等不暴露控件树的界面只能截图定位坐标点击。截图前确认窗口未锁屏、可见；点击后回读端口监听，不要假设点了就等于启动。
- 端口监听判定：`Get-NetTCPConnection -LocalPort <port> -State Listen` 或等价命令；Git Bash `netstat` 无输出时改用 PowerShell。

## 4. 生效验证：出口 IP + 负对照

1. 选一个应命中新规则的域名，走代理请求出口查询（如 `curl -x 127.0.0.1:<port> https://<host>/cdn-cgi/trace`）。
2. 记录代理出口 IP；与本地宽带 IP 对比：本地 IP = 直连，节点 IP = 代理。
3. 选一个**未被新规则覆盖**的域名做负对照，确认它仍走预期路径（直连或另一节点）。
4. 同时验证规则优先级：与既有规则冲突时，新规则是否真的先匹配；只看“有一条规则存在”不算。
5. 重启客户端后再测一次，证明持久化生效，不是只改了内存。

## 5. 交付判据

- [ ] 真源已确认，数据库与 YAML 已备份。
- [ ] 新行字段完整、id/排序符合 schema，回读一致。
- [ ] 精确 PID 重启，含负对照；端口已监听。
- [ ] 目标域名出口 IP 符合预期，负对照域名不符合。
- [ ] 重启后复测仍生效。

## 边界

- 不修改用户未批准的全局分流策略；只改本轮明确要求的规则。
- 不把节点地址、订阅链接或凭据写进汇报。
- 代理客户端自身更新可能重置数据库结构；升级后重新核对 schema。

## 相关

- 本机自建反代：`local-reverse-proxy-triage`。
- 网络连通性排查：`edge-net-check`（命令）、`agent-client-network-triage`。
