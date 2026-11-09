---
name: large-sqlite-text-extraction
description: 从超大 SQLite / 二进制文件（数百 MB 到 1GB+，常无 sqlite3 CLI）按关键词取回 UTF-8 文本——典型场景是 UI 里被截断、或只存在于应用库中的完整描述：先解析数据目录真实路径（可能被搬迁成 junction）→ 单点用 grep -a 快速取证 → 全量用 32MB 分块 + latin1 字节偏移 + 窗口 UTF-8 解码（整文件 toString 必触发 ERR_STRING_TOO_LONG）→ 用 --filter 锚点过滤「只有名字的清单」类噪声命中 → 命中数 + 不存在关键词负对照验收；含 WAL 未落盘、字符串跨页、递归 grep 超时、MSYS 路径等坑。内置 scripts/scan-binary-text.cjs 可直接运行。触发词：超大 SQLite、main.sqlite、二进制取证、UI 截断文本、取全文、grep 搜不到、ERR_STRING_TOO_LONG、分块扫描、按关键词提取、WAL。不用于：会话归档取证（chat-session-evidence-extraction）、正常规模的 SQL 查询（sqlite3 / dbhub）。
---

# 超大库文本取证

## 什么时候用

- 目标文本在 UI 里被截断（只显示两行），或压根没有导出入口。
- 文件 100MB–1GB+，`sqlite3` CLI 不可用，`grep` 整库慢到超时。
- 只要**文本内容**，不需要结构化查询（要结构化就走 `sqlite3` / `better-sqlite3`，见第 6 节）。

## 1. 先定位真实文件

应用数据目录经常被迁移成 junction / 符号链接，直接按 `%APPDATA%` 走可能读到旧位置或读不到：

```powershell
Get-Item "$env:APPDATA\<产品数据目录>" -Force | Select-Object FullName,LinkType,Target
# 有的产品把真实路径写在 <配置目录>\desktop\storage\stable\location.v1.json
```

同时看 `.sqlite-wal` / `.sqlite-shm`：**最近的写入可能还在 WAL 里**，主库 grep 不到时一起扫。

## 2. 快速单点：`grep -a`

```bash
grep -a -o "关键词.\{0,300\}" <文件> | head -5
```

适合「只命中一两处」的快速确认。缺点：无法限定窗口、输出可能截断在多字节字符中间、大文件上跑得慢。**超时不等于没有**，转第 3 节。

## 3. 全量扫描：分块 + 字节偏移

禁止 `fs.readFileSync(...).toString()`：超过 `0x1fffffe8` 字符直接 `ERR_STRING_TOO_LONG`，而且 800MB 文件读进内存也毫无必要。

```bash
node <技能目录>/scripts/scan-binary-text.cjs "<文件>" "<关键词>" \
  --window 4000 --chunk 32 --max 20 --filter "<描述锚点>"
```

原理：按 32MB 分块读、块间保留 8KB 重叠（防关键词跨块），用 latin1 当字节串做 `indexOf` 拿绝对偏移，再从该偏移读 2–4KB 窗口按 UTF-8 解码。退出码 `0=有命中 / 3=无命中 / 2=参数或文件错误`。

## 4. 过滤噪声命中

同一关键词常先命中**命名空间清单 / 索引表**（只有名字、没有描述）。用 `--filter` 要求窗口内还必须含有描述特征串（如 `create`、某句正文）：

```bash
# 先看全量命中长什么样
node .../scan-binary-text.cjs db.sqlite "某技能名" --window 600 --max 5
# 再锁定带描述的那条
node .../scan-binary-text.cjs db.sqlite "某技能名" --window 3000 --filter "本机两层技能体系"
```

## 5. 可失败验收

1. **正对照**：已知存在的关键词必须命中，且窗口里能看到预期句子。
2. **负对照**：编一个不存在的关键词（如 `zzz-not-exist-<日期>`），必须 `rc=3`。
3. **编码完整性**：解码结果不应出现大量 `�`（U+FFFD）；有则窗口起止落在多字节字符中间，调整偏移或窗口大小。
4. **去重**：同一内容可能在主库与 WAL 各存一份，按偏移/内容去重后再计数。

## 6. 优先考虑结构化查询

装了 `sqlite3` 或 `better-sqlite3` 时，先列表再查表，比暴力扫描快且准：

```bash
sqlite3 -readonly <文件> ".tables"
sqlite3 -readonly <文件> "SELECT ... LIMIT 5"
```

只有在「没有 CLI / 表结构未知 / 内容以 blob 或自由文本存储」时才走分块扫描。**始终只读打开**，不要对正在运行的应用库加写锁。

## 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| `ERR_STRING_TOO_LONG` | 整文件 `toString()`；改分块 |
| `grep` 跑几分钟无输出 | 大文件单线程扫描；改脚本或先用 `-o` 限定 |
| 递归 grep 整个目录超时 | 先定位到单文件再扫 |
| 明明有却搜不到 | 关键词在 WAL、或跨块边界、或大小写/编码不同 |
| 命中一堆只有名字的行 | 命名空间清单；用 `--filter` |
| Git Bash 里 `fsutil` 报错 123 | MSYS 路径转换；用 PowerShell 或 `powershell -NoProfile -Command` 包一层 |
| 输出全是乱码/替换符 | 窗口切在多字节字符中间；从 ASCII 关键词偏移处取整窗口 |

## 安全边界

- 只读打开，不修改应用数据；需要写副本时放临时目录并在收尾清理。
- 不要把库里的凭据、内网地址、个人数据原样贴进汇报或记忆；只摘取任务需要的那段。
- 大文件不要复制到 C 盘做二次处理。

## 产品实例

- Qoder 桌面端「自进化建议」全文：[references/qoder-app-db.md](references/qoder-app-db.md)
