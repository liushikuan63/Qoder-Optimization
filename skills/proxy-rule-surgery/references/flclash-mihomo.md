# FlClash / mihomo 专用细节

> 本机实测于 2026-10-31；版本升级后以现场 schema 为准。

## 路径与真源

- 数据库：`%APPDATA%\com.follow\clash\database.sqlite`。
- 自定义规则在 `rules` 表；`config.yaml` 是生成物，单独改会被覆盖或不重载。
- 备份数据库与 `config.yaml` 后再动手。

## 写入要点

- 先 `PRAGMA table_info(rules)` 看字段；按现有行的默认值补全，不要只写 `id`/`payload`。
- `id` 取 `max(id)+1`。
- 排序字段取比现有最小值更“优先”的值，保证新规则先匹配；具体方向以客户端版本为准。
- 写入后回读新行；必要时同步修改 `config.yaml` 的 `rules` 段，但以数据库为真源。

## 重启与 UI

- 结束 `FlClash.exe` 用精确 PID；按镜像名 `taskkill` 会被风险守卫拦截。
- 内核随 GUI 退出；重启后可能停在“未运行”、7890 不监听。
- Flutter 界面 UIA 只暴露标题栏，只能截图坐标点击“启动”；点击后回读 7890 监听。
- `bring_to_front` 可能被 CUA 守卫拦下；可用 ShowWindow 恢复但不激活窗口。

## 验证

```bash
curl -x 127.0.0.1:7890 https://<目标域名>/cdn-cgi/trace
curl -x 127.0.0.1:7890 https://<未覆盖域名>/cdn-cgi/trace
```

- 出口 IP = 节点 IP ⇒ 代理命中；= 本地宽带 IP ⇒ 直连。
- 未覆盖域名必须保持原路径，作为负对照。
- 重启客户端后再测一次，证明持久化。

## 已知坑

- 规则写进 YAML 后重启被覆盖：真源是数据库。
- 按镜像名杀进程被拦：改精确 PID，并先列候选与负对照。
- 重启后 7890 不监听：UI 点启动，不要以为进程起来就自动代理。
