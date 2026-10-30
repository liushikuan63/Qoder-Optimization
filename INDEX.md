# Qoder-Optimization - 0.0.6

## 分享包索引（按需加装）

共 244 条：skill=125 / script=107 / command=10 / agent=2

- 状态：`shipped` 随包可直接装；`external` 只给官方安装方式；`template` 给合并说明。
- 机器可读版：`catalog.json`。文件存在不代表已安装或已装载。

```bash
node scripts/pkg-catalog.cjs register <分享包目录>
node scripts/pkg-catalog.cjs search "<关键词>"
node scripts/pkg-catalog.cjs install <id>
node scripts/pkg-catalog.cjs install <id> --apply
```
