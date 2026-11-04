# 产品实例：Word COM / SaveAs2 不返回

> 主线流程见 [../SKILL.md](../SKILL.md)。这里区分历史观察、网上线索与本机已验证结果。

## 现役处理（2026-10-26）

使用 PowerShell 7：`$env:ProgramFiles\PowerShell\7\pwsh.exe`。不改 Windows PowerShell 5.1 的执行策略，不以拆进程代替定位。

- 入口：`encrypted-office-visual-inspection/scripts/fixture-selftest.ps1 -WithWord`，通过 `#requires -Version 7.0` 与 `-PSEdition Core` 限定宿主。
- `Join-Path` 生成的 COM 路径显式声明 `[string]`；读取文件头使用文件流，不使用 PS7 不支持的 `Get-Content -Encoding Byte`。
- 同一 PowerShell 会话先执行 Excel，再以同一 Word 实例打开、保存、导出 PDF、重开并全文比对。
- 进度输出宿主版本、测试目录、Word PID/启动时间和调用阶段；每次独立测试目录，不覆盖旧文件。
- 依次 Close/释放 Range、Document、Documents，随后 Quit/释放 Application；核验本轮进程退出，不批量结束用户进程。

## 本机对照与结论

| 实验 | 结果 | 能说明什么 |
|---|---|---|
| pwsh 7.6.5：同一脚本交错运行原始 Join-Path 与显式 string 路径各 2 次 | 4 次均成功，约 7–8 秒，全文一致且进程退出 | PS7 下未复现路径绑定问题，不能声称强转是本机旧问题的已证实根因 |
| 修复后的完整自测连续 3 次 | 每次 9 项通过、退出 0，约 13–15 秒 | 当前宿主和脚本支持同会话连续操作 |
| 仅修改比对端的预期全文，源文档不变 | 8 PASS、1 FAIL、退出 1 | 断言能抓住内容不一致，不是恒绿 |
| 不带 WithWord 的默认链路 | 4 项通过、退出 0 | 保留原有 Excel 入口 |

旧 PS5 自测曾多次在 SaveAs2 停住；后来隔离的 GC、链式保存/导出、源文件占用、Excel/Word 混用实验均成功。这些结果只说明当时没有重现因果关系，不能称为完全否证，也不能写成「同会话必挂」「分步必过」或「僵尸是唯一原因」。用户要求只用 PS7，本轮未再运行 PS5；历史挂起的底层原因仍未证实。

## 网上线索（不是本机结论）

- [SaveAs 因参数类型挂起的案例](https://stackoverflow.com/questions/42741161/microsoft-word-interop-saveas-hangs-for-some-misterious-argument-types)：作者报告 Join-Path 结果与字面量比较相等且均显示 String，但显式 string 转换解决了该案例；不能仅用 GetType 判断 COM 参数行为一致。
- [SaveAs2 官方签名](https://learn.microsoft.com/en-us/dotnet/api/microsoft.office.interop.word._document.saveas2)：文件名参数是 ref object；显式字符串作为边界输入，不能将 PSObject 包装推测直接写成本机根因。

## 超时与证据

外层设置总超时，保留实时 STEP 日志及真实退出码；不要用管道末端的退出码代表 Word 成功。超时先预览本轮 PID、启动时间、窗口和文档归属，经批准只回收自己创建的测试进程，禁止按 WINWORD 镜像名批量终止。

PDF 文件存在或头部非标准并不证明 PDF 内容正确；需要验证渲染时用授权阅读器实际打开、截图对比。本文自测只证明导出调用返回、产物非空和 Word 文本回读一致，不声称破解 DLP。
