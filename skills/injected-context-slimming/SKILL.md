---
name: injected-context-slimming
description: 每轮注入文件（AGENTS.md / MEMORY.md / 索引领航类长文）的无损瘦身流水线：先量化再动手 → 备份 → 只压叙述不删判据 → 覆盖断言逐条证明没丢 → 双侧同写验收。触发词：阅读压力、上下文太大、AGENTS 太长、MEMORY 超行、规则文件瘦身、压缩规则、注入体积、降 token、超红线转索引。不用于：技能描述瘦身（→skill-description-route-cue-rewrite）、技能降量（→skill-trim-with-capability-transfer）、两侧记忆不一致（→memory-bank-divergence-repair）。
---

# 注入文件无损瘦身

## 适用

每会话/每轮被整份注入的文件需要降体积，但**不能靠"感觉精简"**：手工压缩会静默丢阈值、命令或硬禁止词。本技能的核心是「覆盖断言」——把旧文件的可检验要素抽出来，逐条断言新文件仍在。

红线参考：AGENTS.md 目标 ≤160 行 / 硬线 190；MEMORY.md ≤200 行（超了客户端只加载一部分，条目会静默丢）。判据以本机 `rules-weekly-audit.js` 实测为准。

## 0. 先量化，再决定动不动

```bash
wc -l -c ~/.qoder/AGENTS.md ~/.qoder/memory/MEMORY.md
```

再按节统计体积，找出真正的大户，别平均用力：

```bash
node -e "const t=require('fs').readFileSync(process.argv[1],'utf8');t.split(/^### /m).slice(1).map(s=>[Buffer.byteLength(s),s.split('\n')[0]]).sort((a,b)=>b[0]-a[0]).slice(0,8).forEach(([n,h])=>console.log(n,h))" ~/.qoder/AGENTS.md
```

## 1. 备份

```bash
node ~/.qoder/scripts/backup-file.js <文件>
```

## 2. 四类内容分开处置

| 类型 | 处置 | 判据 |
|---|---|---|
| 叙述（引子 / 历史轶事 / 举例） | 删或压成半句 | 删掉后能否改变任何一次执行决策？不能就删 |
| 重复条款（同一规则出现在多处） | 合并为一处 + 互引 | 每节只保留一个"真源句" |
| 结构性说明（维护口径 / 拓扑 / 操作手册） | 整块迁出成独立文件，主文件留一行指针 | 迁出后信息仍可检索到 |
| 条目描述 | 截首句 + 字数上限（如 46 字）+ `…` | 保留区分性词，否则检索会失准 |
| **判据本身**（阈值 / 命令 / 硬禁止词 / 例外清单） | **一律保留** | 见第 3 步断言 |

顺序遵循文件自身的层级优先级：**最低优先级先转索引**（技能流程与记忆 → 领域细则 → 本文件主题细则只压叙述）。

## 3. 覆盖断言（这一步不能省）

写一个一次性脚本，从**旧文件**提取要素，断言**新文件**仍在：

1. 反引号标识（脚本名 / 路径 / 命令 / 开关）
2. 数字 + 单位（`3 份`、`7 天`、`200 行`、`10GB`、`30 秒`…）
3. 硬词计数（禁止 / 不得 / 绝不 / 一律 / 必须 / 红线）
4. 章节标题集合

```js
const o=fs.readFileSync(OLD,'utf8'), n=fs.readFileSync(NEW,'utf8');
const codes=[...new Set([...o.matchAll(/`([^`\n]{1,80})`/g)].map(m=>m[1]))];
const miss=codes.filter(c=>!n.includes(c));
```

对每个缺失项**逐条归因**：是"该补回的引用"还是"有意删除的轶事/过期数字"，并把归因写进汇报。硬词计数下降必须能解释到具体句子。

## 4. 结构校验（也能失败）

- 标题唯一（复制粘贴时常出现两个同名 H1）
- 粗体成对：每行 `**` 计数为偶数
- 行数 ≤ 红线；无未完成占位标记
- 悬空指针 0：索引里每个 `](x.md)` 都能在磁盘找到
- 指针数不减少：条目数 == 唯一引用数（除非明确说明删了哪条）

## 5. 双侧同写与收口

```bash
cp <新文件> ~/.qoder/<f> && cp <新文件> ~/.qoder-cn/<f>
md5sum ~/.qoder/<f> ~/.qoder-cn/<f>          # 必须相同
bash ~/.qoder/scripts/sync-global-config.sh --check   # AGENTS/rules：IN-SYNC
bash ~/.qoder/scripts/sync-memory.sh                   # 记忆：0 单边 0 分叉
node ~/.qoder/scripts/rules-weekly-audit.js            # 0 告警
```

规则类改动再跑相关自测；`scripts/*.test.js` 全量一遍最稳。

## 坑

- **`node -e` 里写含反斜杠的正则会被 shell 吃掉**：补丁脚本落盘成 `.cjs` 再跑。
- **批量替换 `**…**` 会写出 `**从**最低**…**` 这种坏嵌套**：替换后断言每行 `**` 成对。
- **压缩描述会砍掉路由线索**：整句触发词是检索的强信号，拆成散词就不认；宁可长也不能删。
- **超 200 行是静默故障**：客户端截断后不给任何提示，索引条目会"存在但检索不到"。
- **只做二方 diff 会误判**：有旧版本留底时优先三方比对（旧基线 / 本机 / 新文件）。
