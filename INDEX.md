# Qoder-Optimization - 0.1.4

## 分享包索引（按需加装）

共 298 条（全部为 `shipped`，可直接安装）：skill=133 / script=152 / command=11 / agent=2

- 状态：`shipped` 随包可直接装；`external` 只给官方安装方式；`template` 给合并说明。`external` / `template` 仅在收录非随包条目时出现，当前计数为 0。
- 检索结果会标「本地未发现 / 与包内一致 / 内容与包内不同」；出现 `NEXT_ACTION` 时必须先询问用户是否安装/更新，未获明确选择不得写盘。
- 机器可读版：`catalog.json`。文件存在不代表已安装或已装载。

```bash
node scripts/pkg-catalog.cjs register <分享包目录>
node scripts/pkg-catalog.cjs search "<关键词>"
node scripts/pkg-catalog.cjs install <id>
node scripts/pkg-catalog.cjs install <id> --apply
node scripts/pkg-catalog.cjs drift
```
