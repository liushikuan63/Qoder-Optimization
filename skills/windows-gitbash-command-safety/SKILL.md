---
name: windows-gitbash-command-safety
description: 定位 Git Bash/MSYS 调 Windows 原生程序时的命令遮蔽、斜杠开关改写、路径、引号与输出编码问题。用自有 argv 正反例核对真实参数，只对当前调用调整转换；不默认码页、不修改全局环境，也不提供通用命令运行器。
---

# Git Bash 到 Windows 原生程序

先核可执行文件身份和实际接收到的参数，再修转换。命令名、`.exe` 后缀、`shell:false` 或参数数组不能单独证明调用正确；Git Bash 和 WSL Bash 也不能互换。

## 1. 核对当前工具

从 `command -v`、实际安装路径和工具自报确认调用对象。Git 自带的 Unix 工具可能遮蔽 System32 同名程序；优先调用已核对的绝对路径。工具身份不明时，先用自有 argv 探针，避免用账号、注册表或服务动作诊断。

## 2. 已安装的 argv 对照

选择本技能会带入 `scripts/shell-boundary-probe.cjs`。在自有目录准备小型普通 JSON 字符串数组 `expected.json`，例如 `["two words", "/groups"]`：

```text
node "<当前已绑定客户端绝对路径>/scripts/shell-boundary-probe.cjs" --expect-file "<自有目录的Windows路径>/expected.json" -- "two words" "/groups"
```

当前这一跳逐项一致退出0，内容/数量不符退出1，参数或期望文件不合法退出2。探针只读取期望数组并比较自己的 argv，不执行输入里的命令、不代查账号、不转储环境或读取凭据；输出索引和摘要，不打印参数实值。

至少加入空格、中文、引号、末尾反斜杠、空字符串、斜杠开关以及故意错误期望。探针通过只证明抵达该 Node 进程的参数正确，后续 exe 或包装层仍需自己的接收端对照。

## 3. 只处理有证据的转换

- MSYS可能在原生子程序启动前转换看起来像路径的参数。正反例确认问题后，对单次调用设置 `MSYS2_ARG_CONV_EXCL`，能限定前缀就限定前缀。
- 需要传给原生程序的路径先用 `cygpath -w` 等转换为该程序所需形态。排除参数转换也可能影响本来需要转换的路径，开关和文件路径都要回验。
- 不全局禁用转换，不普遍把 `/` 改成 `//`，也不靠无依据的 `windowsVerbatimArguments:true` 声称引号免疫。子程序内部设置变量无法修复父层已发生的改写。
- 复杂脚本先保存自有文件，再调用明确解释器。不要把用户文本经多层双引号拼成 `cmd /c`、PowerShell `-Command` 或 Bash 代码。

CN、自定义客户端和迁移库均使用当前已绑定客户端的绝对 scripts 路径，不能从物理技能库位置猜客户端。

## 4. 输出和退出码分别取证

保留stdout/stderr原始字节，核对BOM、程序约定和本轮非ASCII样例；严格UTF-8失败不能直接认定GBK。两个流分开处理，不能先拼接后猜统一编码。

同时核对子程序、包装器的实际退出码和业务结果。明确 `exit 7` 应真实传回7，参数/解析失败也必须非零；打印 `EXIT=7`、空stderr或找不到Error关键词均不是进程成功证据。

PowerShell脚本的编码和非终止错误另按 `windows-powershell-from-gitbash` 的已安装入口处理；未装时先检索或按当前安装选择处理，不假定那个入口已存在。本技能不再宣称随包提供未分发的 `winrun.cjs`、强制解码器或任意命令包装器。
