---
name: skill-reference-integrity-audit
description: "技能/文档悬空引用审计与修复决策流程：提取引用清单→存在性核查→会话归档考古判定『从未落盘 vs 丢失』→同域技能功能映射让渡或按真值重建；含并行会话竞态处置（对象消失先查 skills-disabled）。触发词：悬空引用、缺失文件、引用审计、归档考古、技能完整性检查、skills-disabled 竞态。不适用于：代码层面的 import/require 缺失（走静态分析）、文档内部链接失效（走 link-checker）。"
---

# 技能引用完整性审计

审计技能目录的 SKILL.md 引用是否实际存在，判定缺失原因是「从未落盘」还是「写了但丢了」，并给出修复决策。

## 工作流

### Step 0: 侦察前提

确认目标技能目录存在，读取 SKILL.md。

```bash
ls -la <技能目录>/
cat <技能目录>/SKILL.md
```

**并行会话竞态检查**：如果目录不存在或 SKILL.md 读取失败，立即查 `skills-disabled/`：

```bash
ls ~/.qoder/skills-disabled/ | grep <技能名>
```

如果命中 `skills-disabled`，**停写弹窗**——对象已被并行会话停用，继续写入会造成数据分叉。

### Step 1: 提取引用清单

从 SKILL.md 提取所有 `scripts/` 和 `references/` 的引用：

```bash
grep -oE '(scripts|references)/[^ )]+' <技能目录>/SKILL.md | sort -u
```

输出示例：

```
scripts/audit-references.cjs
scripts/derive-ids.cjs
references/archive-archaeology.md
```

### Step 2: 存在性核查

用 `scripts/audit-references.cjs` 扫描：

```bash
node ~/.qoder/skills-library/skill-reference-integrity-audit/scripts/audit-references.cjs <技能目录>
```

输出 JSON：

```json
{
  "existing": ["scripts/audit-references.cjs"],
  "missing": ["references/archive-archaeology.md"]
}
```

退出码：0 = 全存在，1 = 有缺失。

**工具失败替代**：如果 `ls -R` 被 huge-output-guard 拦截，改用 Node 递归清单：

```bash
node -e "const fs=require('fs'),path=require('path');function walk(d){fs.readdirSync(d).forEach(f=>{const p=path.join(d,f);fs.statSync(p).isDirectory()?walk(p):console.log(p)})}walk('<技能目录>')"
```

### Step 3: 缺失项归档考古

对每个缺失文件，扫描 `~/.qoder/chat-sessions/*.jsonl`，判定「从未落盘 vs 写了但丢了」。

方法详见 `references/archive-archaeology.md`。

核心逻辑：

```bash
node -e "
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const targetFile = '<缺失文件的完整路径>';
const sessionsDir = path.join(process.env.HOME, '.qoder/chat-sessions');
const sessions = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));

let hitCount = 0;

(async () => {
  for (const session of sessions) {
    const sessionPath = path.join(sessionsDir, session);
    const rl = readline.createInterface({
      input: fs.createReadStream(sessionPath),
      crlfDelay: Infinity
    });
    
    for await (const line of rl) {
      try {
        const obj = JSON.parse(line);
        if (obj.role === 'assistant' && obj.tools) {
          for (const tool of obj.tools) {
            if (tool.name === 'Write' && tool.input?.file_path === targetFile) {
              hitCount++;
            }
          }
        }
      } catch (e) {
        // 跳过非 JSON 行
      }
    }
  }
  
  if (hitCount === 0) {
    console.log('从未落盘');
    process.exit(0);
  } else {
    console.log('写了但丢了，命中 ' + hitCount + ' 次');
    process.exit(1);
  }
})();
"
```

**性能注意**：12MB 归档约 30 秒，大归档（>50MB）建议分批扫描。

### Step 4: 功能覆盖核实

盘点同域技能，确认缺失引用的功能是否已被覆盖：

```bash
ls ~/.qoder/skills/ | grep <相关关键词>
```

对每个候选技能，读取 SKILL.md 判断功能覆盖：

```bash
cat ~/.qoder/skills/<候选技能>/SKILL.md | grep -A 5 'description:'
```

**判定标准**：
- 如果候选技能的 description 明确包含缺失引用的功能 → 功能已覆盖
- 如果候选技能的 scripts/ 有类似脚本 → 功能已覆盖
- 如果不确定 → 标记为「待人工核实」

### Step 5: 修复决策

根据归档考古和功能覆盖核实结果，三选一：

**A. 功能已覆盖 → 交付引用映射表**

不重建文件，只在 SKILL.md 里标注「此引用已废弃，功能由 `<候选技能>` 提供」。

输出映射表：

```markdown
| 旧引用（悬空） | 现位置 |
|---|---|
| `scripts/old.cjs` | `<候选技能>/scripts/new.cjs` |
```

**B. 功能未覆盖且从未落盘 → 按真值重建**

根据 SKILL.md 的描述和同域技能的实现，重建缺失文件。

重建后必须验证：
- 脚本能正常运行（EXIT=0）
- 输出符合预期
- 引用路径正确

**C. 功能未覆盖且写了但丢了 → 从归档恢复或重建**

优先从归档恢复：

```bash
# 找到写入该文件的会话
grep -l '<缺失文件路径>' ~/.qoder/chat-sessions/*.jsonl

# 从该会话提取文件内容（需人工解析 jsonl）
```

如果归档内容不完整，按方案 B 重建。

## 并行会话竞态处置

**机械判据**：如果在审计过程中发现目标目录或文件突然消失（前一命令可读、后一命令 stat 消失），立即执行：

```bash
ls ~/.qoder/skills-disabled/ | grep <技能名>
```

如果命中 `skills-disabled`：
1. **停写**：不再对该技能目录做任何写入操作
2. **弹窗**：告知用户「对象已被并行会话停用，请确认是否继续」
3. **等待**：用户明确批准后再继续

如果未命中 `skills-disabled`：
1. 检查是否有其他并行会话正在处理该技能
2. 如果是，等待该会话完成后再审计
3. 如果不是，可能是文件系统问题，重新读取确认

## 工具失败替代

### huge-output-guard 拦截

如果 `ls -R` 或 `find` 被 huge-output-guard 拦截，改用 Node 递归清单：

```bash
node -e "
const fs = require('fs');
const path = require('path');

function walk(dir, depth = 0) {
  if (depth > 10) return; // 防止死循环
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        console.log('DIR: ' + fullPath);
        walk(fullPath, depth + 1);
      } else {
        console.log('FILE: ' + fullPath);
      }
    } catch (e) {
      console.log('ERROR: ' + fullPath + ' - ' + e.message);
    }
  }
}

walk('<目标目录>');
"
```

### 目标文件消失

如果 `stat` 发现文件不存在：
1. 先查 `skills-disabled/`
2. 如果未命中，检查是否有并行会话在移动/删除文件
3. 如果是，等待该会话完成后再审计

## 验证

审计完成后，必须验证：

1. **正例**：对文件齐全的技能（如 `contract-requirement-id-derivation`）跑审计，输出 `existing: N, missing: 0`，EXIT=0
2. **负例**：对有缺失的技能（如 `skills-disabled/contract-requirement-testcase-authoring`）跑审计，输出 `existing: M, missing: K`，EXIT=1
3. **归档考古**：扫描来源会话归档，验证缺失文件的 Write 命中数与判定一致
4. **回读核验**：如果做了修复，重新读取 SKILL.md 验证引用路径正确

## 资源

- `scripts/audit-references.cjs` — 悬空引用扫描脚本
- `references/archive-archaeology.md` — 归档考古方法论
