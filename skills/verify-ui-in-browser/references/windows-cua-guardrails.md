# Windows CUA 真机验收坑与替代路径

> 适用于 Chromium / Electron 窗口的 CUA 点击、输入与截图验收。通用验收流程见 SKILL.md。

## 坐标

- `click` 的 `x,y` 是**窗口内坐标**，驱动会自动加窗口原点；不要当成屏幕绝对坐标再手动偏移。
- `bring_to_front` / `foreground_fallback` 默认被 `cua-cursor-guard` 拦；不要靠它抢焦点。

## 键盘与输入

- 键盘类输入先确认“后台送达不可用”，再显式申请前台；被守卫拒绝时不要换个工具绕过，按守卫提示处理。
- UIA `set_value` 写入 React 受控输入**不会同步 state**，按钮点了也可能发不出去。要么走真实键盘输入，要么改验收判据（读日志/截图），不要以“值已写入”当成功。
- 锁屏时窗口激活与合成输入全废；先确认桌面已解锁。

## 截图

- 普通窗口用 CUA 截图；CEF / 自绘窗口 `PrintWindow` 可能失败，改用 `capture-window.ps1` 做屏幕抓取（按 Hwnd）。
- 截图后放大到 1:1 目视核对，不只看“窗口出现了”。

## 降级验收

无法模拟输入时，用应用自身日志 + 窗口截图证明结果；汇报里写清“未做交互验证 + 原因”，不要把截图当成交互成功。

## 相关

- 桌面自动化选型与守卫：`rules/cua-automation.md`。
- 窗口截图取证：记忆 `tooling-windows-window-capture`。
