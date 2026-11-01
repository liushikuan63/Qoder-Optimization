# Qoder 网页登录专用观测点

> 本机 2026-10-31 实测；路径与接口会随版本变化，执行前以现场网络记录为准。

## 链路

`Qoder 登录页 → Google OAuth → 回调域 → POST /api/v4/login → /api/v4/captcha/challenge → Turnstile → 会话`

## 判读

- Google 授权成功、回调 URL 带 JWT，不代表登录成功。
- `POST /api/v4/login` 返回 400/403 后紧跟 `/api/v4/captcha/challenge` 与 Turnstile 加载 ⇒ 按人机验证链路查，不是账号不存在。
- 隐藏页面 / 无头环境里 Turnstile 不会完成；这种复现只能定性，不能判“登录一定失败”。
- 登录页直连、Google 与回调走代理的跨出口组合会触发风控；统一出口后复现对比。
- 权益/活动面板另有第三方统计资源；若登录成功但面板一直转圈，先量 `main.log` 的 `[Campaign]` 事件与资源耗时，不要混进 OAuth 结论。

## 修复顺序

1. 统一登录页、身份提供方、回调域的出口。
2. 换节点后重走完整链路。
3. 仍失败时用邮箱密码登录，确认账号已绑定邮箱。
