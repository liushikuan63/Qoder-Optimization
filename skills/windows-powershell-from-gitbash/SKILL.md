---
name: windows-powershell-from-gitbash
description: 定位 PowerShell 5.1/7 与 Git Bash/MSYS 之间的参数展开、脚本和输出编码及退出码问题。先核对实际解释器，用自有 argv、明确非零退出和解析失败样例验证边界。不用于提权、服务变更或修改全局环境。
when_to_use: PowerShell 内联命令被展开、中文脚本解析失败、UTF-16输出、退码与错误不一致，或需要验证跨Shell参数传递时。
---

# PowerShell 跨 Shell 边界

先确认实际解释器、原始参数、输入和输出字节以及子进程退出码，再归因。Git Bash、WSL Bash、Windows PowerShell 5.1 与 PowerShell 7 不互换；既有机器的码页和安装路径只作线索。

## 选择当前调用方式

- 从 `$PSVersionTable.PSEdition`、`$PSVersionTable.PSVersion`、`$PSHOME` 和实际启动路径确认解释器。`powershell.exe` 与 `pwsh` 的行为分别验证，不为诊断调整全局 PATH、码页或代理。
- 当前就在 PowerShell 时，优先参数数组、`-LiteralPath` 与文件参数。复杂脚本保存到本任务自有目录，再通过已核对的解释器以 `-File` 调用；不要把数据拼成 `-Command` 代码。
- 从 Git Bash 调用时，先处理 Bash 的变量和命令替换，再验证 PowerShell 收到的参数。单引号 heredoc 可避免生成脚本时被 Bash 展开；`-File` 只能减少一层展开，不能替代实际 argv 验证。

## 已安装 argv 探针

选择本技能会带入 `scripts/shell-boundary-probe.cjs`。它只比较当前 Node 进程收到的参数，不执行参数里的命令、不转储环境或读取凭据，也不是通用命令运行器。

先在自有目录准备一个小型普通 JSON 数组文件，例如 `expected.json` 内容为 `["two words", "/groups"]`，再从待验证的 Shell 调用：

```text
node "<当前已绑定客户端绝对路径>/scripts/shell-boundary-probe.cjs" --expect-file "<自有目录>/expected.json" -- "two words" "/groups"
```

CN、自定义根和迁移库布局均使用这次已绑定客户端的绝对 scripts 路径；不要从技能的物理库位置推算另一客户端。

- 退出 0：当前这一跳的 argv 与期望逐项一致。
- 退出 1：参数内容或数量不符。
- 退出 2：参数格式、期望文件或输入不满足探针要求。

将期望数组故意改错应返回 1；缺少必要选项应返回 2。只用自有的空格、引号、末尾反斜杠、中文、空字符串和斜杠开关样例，不传真实密钥。输出只含索引和摘要，不以打印原始实值作证据。

该探针仅验证进到它自己的 argv；其他 exe、`cmd /c` 或后续包装层需要各自的接收端对照。`shell:false`、参数数组或 `-File` 均不单独证明整条调用链保真。

## 编码和退出码

脚本编码与 stdout/stderr 编码分别核实。Windows PowerShell 5.1 可能按 ANSI 读取无 BOM 的含中文脚本，PowerShell 7 的默认值不同；使用目标解释器支持的明确编码，写后回读原始字节。UTF-8 解码失败不能直接断言 GBK，不将两个流拼接后猜一种编码。

外部程序返回后立即保存 `$LASTEXITCODE`，并核对脚本自身退出码和业务结果。PowerShell 的非终止错误可能仍退 0：必要步骤使用适当的 Stop/try/catch 和明确断言；原生命令如何处理 stderr 应依其契约，不把空 stderr、Error 文本零命中或打印 `EXIT=0` 当成功证明。

新包装器至少验正常输入、明确非零退出、输入或解析失败三态。只在本任务自有目录运行探针，不用注册表、服务、真实用户数据或前台窗口作测试对象。

进一步流程见[边界参考](references/shell-boundaries.md)。本技能不再宣称存在未分发的 `psdiag.cjs` 运行器，也不提供自动解码或任意脚本执行能力。
