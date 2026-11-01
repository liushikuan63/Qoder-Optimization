#!/usr/bin/env bash
# 职责：检测并部分修复 ~/.qoder/memory（非 CN）与 ~/.qoder-cn/memory（CN）两份记忆目录的漂移。
#
# 为什么需要它：`skills` 与 `scripts` 两侧是 junction，改一处两侧生效；
# 但 **`rules` 与 `memory` 两侧都是实体目录，不能链接** ——
# CN 应用的记忆功能要求路径解析留在配置目录内，junction 会让 realpath 逃出目录、界面报"无法读取记忆"
# （2026-09-18 实测并回退）。于是两侧各写各的，2026-09-19 曾攒出"一条只在 CN 侧、两条只在本侧、
# 四条同名但内容分叉"，且两侧 MEMORY.md 对"是否单一真源"的说法互相矛盾。
#
# 为什么默认只报不改：同名不同内容的文件**必须人来合**（那两条就是两侧各加了一段互不冲突的正文，
# 任何"按 mtime 新覆盖旧"都会抹掉另一侧那段）。所以本脚本只自动做**无损失**的那一半：
# 把"只在一侧存在"的文件补到另一侧；分叉文件一律列出来交给人/agent 合。
#
# 性能硬约束（2026-09-19 重写）：本脚本被 global-config-guard.js 在 SessionStart hook 里以 8s 超时调用，
# 而 Windows Git Bash 每次 spawn 子进程实测 ~320ms —— 旧版逐文件 cmp/grep（84 文件×两侧 ≈200 次）
# 实测 41.5s ⇒ 该检查永远超时、等于没做，还拖慢每次开会话（guard 实测 11s，其中 8s 是等它超时）。
# 现版：目录清单用通配符、MEMORY.md 解析用内置字符串操作（零 spawn），内容比对**每侧只跑一次 md5sum**。
# 选型实测（84 文件 / 229KB）：read -d '' 逐字节读 4.3s（MSYS 下每字节一次 syscall，弃）；$(<f) 0.2s 但
# 会吃掉尾部换行、比 cmp 少一类差异（弃）；md5sum 0.75s 且与旧 cmp 同为字节级（用它）。
# **改这里请保持"极少 spawn"**，否则会再次顶穿 8s 预算与周检的 PERF_BUDGETS。
# 另：md5sum 拿不到内容时宁可报红（见"无法比对"分支），不许静默判一致——量具崩了不能当绿。
#
# 输出协议（调用方按行解析，勿改措辞）：
#   global-config-guard.js 取 /漂移|分叉|only|只在/；rules-weekly-audit.js 取 /分叉|只在|索引不/
#
# 用法：
#   bash sync-memory.sh              # 只报，不改（退出码 0=无漂移，1=有漂移，2=前置不满足）
#   bash sync-memory.sh --copy-missing  # 补"只在一侧"的文件，分叉文件仍然只报不动
set -uo pipefail
shopt -s nullglob
A="$HOME/.qoder/memory"        # 非 CN
B="$HOME/.qoder-cn/memory"     # CN
MODE="${1:-report}"

# 顺序要紧：两侧都没有 = 真的前置不满足（退 2）；只有一侧 = 合法单端（退 0，且绝不建另一侧）。
if [ ! -d "$A" ] && [ ! -d "$B" ]; then
  echo "[memory-sync][前置] 目录不全：两侧记忆目录都不存在（$A / $B）" >&2
  exit 2
fi
# 单端模式（任一方向）：只装了一个客户端 ⇒ 没有"另一侧"可比。
# 措辞要避开调用方取的 /漂移|分叉|only|只在/ 关键词，否则这句本身会被当成分叉报告。
if [ ! -d "$A" ] || [ ! -d "$B" ]; then
  only="$A"; [ -d "$A" ] || only="$B"
  echo "[memory-sync] 单端模式：只发现 $only（另一侧不存在），跳过比对；单端下无需同步。"
  exit 0
fi

same_source=0
[ "$A" -ef "$B" ] && same_source=1
only_b=0   # 只在 CN 侧（B 有、A 无）
only_a=0   # 只在本侧（A 有、B 无）
diverged=0
index_bad=0

# ── 1) 文件清单（通配符，零 spawn）──
files_a=(); for p in "$A"/*.md; do files_a+=("${p##*/}"); done
files_b=(); for p in "$B"/*.md; do files_b+=("${p##*/}"); done

declare -A seen_a=() seen_b=()
for f in "${files_a[@]}"; do seen_a["$f"]=1; done
for f in "${files_b[@]}"; do seen_b["$f"]=1; done

for f in "${files_b[@]}"; do
  [ -n "${seen_a[$f]:-}" ] || { only_b=$((only_b + 1)); echo "  只在 CN 侧: $f"; }
done
for f in "${files_a[@]}"; do
  [ -n "${seen_b[$f]:-}" ] || { only_a=$((only_a + 1)); echo "  只在本侧: $f"; }
done

# ── 2) 内容比对：每侧只跑一次 md5sum（2 次 spawn ≈0.7s），比对在 bash 内 ──
# md5sum 输出 "hash *name"（MSYS 二进制模式带 * 前缀）；</dev/null 防"无 .md 文件"时空转读 stdin
declare -A hash_a=() hash_b=()
while read -r h f; do [ -n "$f" ] && hash_a["${f#\*}"]="$h"; done < <(cd "$A" && md5sum -- *.md </dev/null)
if [ "$same_source" -eq 1 ]; then
  for f in "${!hash_a[@]}"; do hash_b["$f"]="${hash_a[$f]}"; done
else
  while read -r h f; do [ -n "$f" ] && hash_b["${f#\*}"]="$h"; done < <(cd "$B" && md5sum -- *.md </dev/null)
fi

for f in "${files_a[@]}"; do
  [ -n "${seen_b[$f]:-}" ] || continue          # 单边文件上面已报
  ha="${hash_a[$f]:-}"; hb="${hash_b[$f]:-}"
  if [ -z "$ha" ] || [ -z "$hb" ]; then
    diverged=$((diverged + 1)); echo "  无法比对（md5sum 未取到内容，查 PATH 或文件可读性）: $f"
  elif [ "$ha" != "$hb" ]; then
    diverged=$((diverged + 1)); echo "  分叉（两侧都有且内容不同，要人来合）: $f"
  fi
done

# ── 3) --copy-missing：只补单边文件（分叉文件不动）──
if [ "$MODE" = "--copy-missing" ] && [ $((only_a + only_b)) -gt 0 ]; then
  copy_missing() {
    # A failed copy may leave a truncated destination. Keep both files as evidence
    # and stop before clearing drift counts or reporting the directories in sync.
    if ! cp -n -- "$1" "$2"; then
      echo "[memory-sync] COPY-FAIL: $1 -> $2（源和部分目标已保留，请核对后恢复）" >&2
      return 1
    fi
    if ! cmp -s -- "$1" "$2"; then
      echo "[memory-sync] COPY-FAIL: $1 -> $2（复制后字节不一致，或无法完整校验；文件已保留）" >&2
      return 1
    fi
  }
  for f in "${files_a[@]}"; do [ -n "${seen_b[$f]:-}" ] || copy_missing "$A/$f" "$B/$f" || exit 1; done
  for f in "${files_b[@]}"; do [ -n "${seen_a[$f]:-}" ] || copy_missing "$B/$f" "$A/$f" || exit 1; done
  echo "[memory-sync] 已把只在一侧的文件补到另一侧（分叉文件未动）"
  only_a=0; only_b=0
  files_a=(); for p in "$A"/*.md; do files_a+=("${p##*/}"); done
  files_b=(); for p in "$B"/*.md; do files_b+=("${p##*/}"); done
fi

# 索引允许通过 *-index.md 分层；同源目录只验证一次。
sides=("$A"); [ "$same_source" -eq 1 ] || sides+=("$B")
for side in "${sides[@]}"; do
  if [ "$side" = "$A" ]; then files=("${files_a[@]}"); else files=("${files_b[@]}"); fi
  if [ ! -f "$side/MEMORY.md" ]; then
    index_bad=$((index_bad + 1)); echo "  索引不自洽（$side）：MEMORY.md 不存在"; continue
  fi
  declare -A refs=() visited=()
  indexes=("MEMORY.md"); count=0; lines=0; orphans=""; missing=""
  for ((i=0; i<${#indexes[@]}; i++)); do
    idx="${indexes[$i]}"
    [ -n "${visited[$idx]:-}" ] && continue
    visited["$idx"]=1
    while IFS= read -r line || [ -n "$line" ]; do
      [[ "$line" == "- ["* ]] || continue
      rest="$line"
      while [[ "$rest" == *"("*".md)"* ]]; do
        inner="${rest#*"("}"; cand="${inner%%")"*}"; rest="${inner#*")"}"
        [[ "$cand" =~ ^[A-Za-z0-9_.-]+\.md$ ]] || continue
        refs["$cand"]=1; lines=$((lines + 1))
        if [ ! -f "$side/$cand" ]; then missing+="$cand "; continue; fi
        [[ "$cand" == *-index.md ]] && indexes+=("$cand")
      done
    done < "$side/$idx"
  done
  for f in "${files[@]}"; do
    [ "$f" = "MEMORY.md" ] && continue
    count=$((count + 1))
    [ -n "${refs[$f]:-}" ] || orphans+="$f "
  done
  if [ -n "$orphans$missing" ] || [ "$lines" -ne "${#refs[@]}" ]; then
    index_bad=$((index_bad + 1))
    echo "  索引不自洽（$side）：文件 $count 条 / 唯一引用 ${#refs[@]} 条；未进索引：${orphans:-无}；失效引用：${missing:-无}；重复 $((lines-${#refs[@]})) 条"
  fi
done

if [ $((only_a + only_b + diverged + index_bad)) -eq 0 ]; then
  echo "[memory-sync] 两侧一致（${#files_a[@]} 个文件，含 MEMORY.md），索引自洽。"
  exit 0
fi
echo "[memory-sync] 漂移：单边 $((only_a + only_b))、分叉 $diverged、索引问题 $index_bad"
echo "[memory-sync] 单边文件用 --copy-missing 补；分叉文件必须手工合并（脚本不覆盖，避免抹掉另一侧的正文）"
exit 1
