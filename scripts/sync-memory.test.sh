#!/usr/bin/env bash
# sync-memory.sh 的回归自测（2026-09-19 重写时建立；夹具全在临时目录，HOME 覆盖指向夹具，不动真实记忆）
# 用法：bash ~/.qoder/scripts/sync-memory.test.sh    （全绿退出 0，有 FAIL 退出 1）
# 覆盖：判一致 / 内容分叉 / 单边文件与 --copy-missing / 索引不自洽 / 尾部换行（字节级）/
#       空目录 / 前置不全 / 真实目录冒烟 / guard 端到端（植入分叉必报、干净必静默）/ 量具缺失必报红
set -uo pipefail
S="${SUT:-$HOME/.qoder/scripts/sync-memory.sh}"      # SUT=... 可指定被测脚本
SCRIPTS="$(cd "$(dirname "$S")" && pwd)"
G_JS="${GUARD_SUT:-$SCRIPTS/global-config-guard.js}"
if [ ! -f "$S" ] || [ ! -f "$G_JS" ] || [ ! -f "$SCRIPTS/sync-global-config.sh" ]; then
  echo 'test prerequisites missing: select the repository or a complete installed script set' >&2; exit 2
fi
T="$(mktemp -d)"
pass=0; fail=0

ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; echo "      实际exit=$2 期望exit=$3 期望片段=$4"; echo "$5" | sed 's/^/      | /'; fail=$((fail + 1)); }
chk() { # $1名称 $2期望码 $3期望片段 $4实际码 $5实际输出
  if [ "$4" = "$2" ] && [[ "$5" == *"$3"* ]]; then ok "$1"; else bad "$1" "$4" "$2" "$3" "$5"; fi
}

reset() { # $1=案例根
  rm -rf "$1"; mkdir -p "$1/home/.qoder/memory" "$1/home/.qoder-cn/memory"
  local A="$1/home/.qoder/memory" B="$1/home/.qoder-cn/memory"
  printf 'alpha body\n' > "$A/alpha.md"
  printf 'beta body\n'  > "$A/beta.md"
  printf '%s\n' '# 索引' '- [Alpha](alpha.md) — x' '- [Beta](beta.md) — y' > "$A/MEMORY.md"
  cp "$A/alpha.md" "$A/beta.md" "$A/MEMORY.md" "$B/"
}

echo "== T1 干净：应 exit 0 且判一致"
reset "$T/t1"; out=$(HOME="$T/t1/home" bash "$S"); chk "T1 干净" 0 "两侧一致（3 个文件，含 MEMORY.md），索引自洽" "$?" "$out"

echo "== T2 内容分叉：应 exit 1 且点名 beta.md"
reset "$T/t2"; printf 'beta body changed\n' > "$T/t2/home/.qoder-cn/memory/beta.md"
out=$(HOME="$T/t2/home" bash "$S"); chk "T2 分叉" 1 "分叉（两侧都有且内容不同，要人来合）: beta.md" "$?" "$out"

echo "== T3 单边文件：先只报，再 --copy-missing 补"
reset "$T/t3"
B3="$T/t3/home/.qoder-cn/memory"
printf 'gamma body\n' > "$B3/gamma.md"
printf '%s\n' '- [Gamma](gamma.md) — z' >> "$B3/MEMORY.md"
out=$(HOME="$T/t3/home" bash "$S"); chk "T3a 只报单边" 1 "只在 CN 侧: gamma.md" "$?" "$out"
printf '%s\n' '- [Gamma](gamma.md) — z' >> "$T/t3/home/.qoder/memory/MEMORY.md"
out=$(HOME="$T/t3/home" bash "$S" --copy-missing); chk "T3b 补单边后一致" 0 "已把只在一侧的文件补到另一侧" "$?" "$out"
if cmp -s "$T/t3/home/.qoder/memory/gamma.md" "$B3/gamma.md"; then ok "T3c 拷贝内容一致"; else bad "T3c 拷贝内容一致" "cmp非0" "cmp=0" "" ""; fi

echo "== T3d cp 写到一半失败：必须保留首红和部分文件，不能宣称一致"
mkdir -p "$T/t3d/home/.qoder/memory" "$T/t3d/home/.qoder-cn/memory"
printf '# complete index\n' > "$T/t3d/home/.qoder/memory/MEMORY.md"
out=$(HOME="$T/t3d/home" bash -c 'cp() { while [[ "$1" == -* ]]; do shift; done; target="$2"; [ ! -d "$target" ] || target="$target/${1##*/}"; printf "partial" > "$target"; printf "cp: simulated disk full\n" >&2; return 17; }; export -f cp; exec bash "$1" --copy-missing' -- "$S" 2>&1); rc=$?
if [ "$rc" = 1 ] && [[ "$out" == *"COPY-FAIL"* ]] && [[ "$out" != *"两侧一致"* ]] && [[ "$out" != *"已把只在一侧"* ]]; then
  ok "T3d 部分复制失败不能假绿"
else bad "T3d 部分复制失败不能假绿" "$rc" "1" "COPY-FAIL 且不报一致" "$out"; fi
if [ "$(<"$T/t3d/home/.qoder/memory/MEMORY.md")" = '# complete index' ] && [ "$(<"$T/t3d/home/.qoder-cn/memory/MEMORY.md")" = 'partial' ]; then
  ok "T3e 失败后源和部分目标均保留供核查"
else bad "T3e 失败证据保留" "内容变化" "原样保留" "" ""; fi

echo "== T3f cp 退出0但目标不完整：逐字节复核仍须判红"
mkdir -p "$T/t3f/home/.qoder/memory" "$T/t3f/home/.qoder-cn/memory"
printf '# complete index\n' > "$T/t3f/home/.qoder/memory/MEMORY.md"
out=$(HOME="$T/t3f/home" bash -c 'cp() { while [[ "$1" == -* ]]; do shift; done; target="$2"; [ ! -d "$target" ] || target="$target/${1##*/}"; printf "partial" > "$target"; return 0; }; export -f cp; exec bash "$1" --copy-missing' -- "$S" 2>&1); rc=$?
if [ "$rc" = 1 ] && [[ "$out" == *"COPY-FAIL"* ]] && [[ "$out" != *"两侧一致"* ]]; then
  ok "T3f 复制后的字节复核能判红"
else bad "T3f 复制后字节复核" "$rc" "1" "COPY-FAIL 且不报一致" "$out"; fi

echo "== T4 索引不自洽：A 侧漏掉 Beta 行"
reset "$T/t4"
printf '%s\n' '# 索引' '- [Alpha](alpha.md) — x' > "$T/t4/home/.qoder/memory/MEMORY.md"
out=$(HOME="$T/t4/home" bash "$S"); chk "T4 索引不自洽" 1 "未进索引：beta.md" "$?" "$out"

echo "== T5 尾部换行差异必须被发现（字节级，防假绿）"
reset "$T/t5"; printf 'alpha body' > "$T/t5/home/.qoder-cn/memory/alpha.md"
out=$(HOME="$T/t5/home" bash "$S"); chk "T5 尾换行" 1 "分叉（两侧都有且内容不同，要人来合）: alpha.md" "$?" "$out"

echo "== T6 空目录：应明确报 MEMORY.md 不存在"
rm -rf "$T/t6"; mkdir -p "$T/t6/home/.qoder/memory" "$T/t6/home/.qoder-cn/memory"
out=$(HOME="$T/t6/home" bash "$S"); chk "T6 空目录" 1 "MEMORY.md 不存在" "$?" "$out"

echo "== T7a 单端（只有 ~/.qoder）：合法安装形态，应 exit 0 且明说跳过"
rm -rf "$T/t7"; mkdir -p "$T/t7/home/.qoder/memory"
out=$(HOME="$T/t7/home" bash "$S" 2>&1); chk "T7a 单端" 0 "单端模式" "$?" "$out"

echo "== T7b 真前置不全（连 ~/.qoder 都没有）：应 exit 2"
rm -rf "$T/t7b"; mkdir -p "$T/t7b/home"
out=$(HOME="$T/t7b/home" bash "$S" 2>&1); chk "T7b 前置不全" 2 "目录不全" "$?" "$out"

echo "== T8 独立目录冒烟（不读取现役 HOME）"
reset "$T/t8"
t0=$(date +%s%N); out=$(HOME="$T/t8/home" bash "$S"); rc=$?; t1=$(date +%s%N)
ms=$(( (t1 - t0) / 1000000 ))
echo "      输出: $out   [${ms}ms]"
if [ "$rc" -le 1 ] && [ "$ms" -lt 5000 ]; then ok "T8 真实目录 ${ms}ms（rc=$rc）"; else bad "T8 真实目录" "rc=$rc ms=$ms" "rc≤1 且 <5000ms" "" "$out"; fi

mkfake() { # $1=根；建一套假 HOME（两侧 AGENTS.md/rules 一致 + 空记忆目录 + 真脚本副本）
  local G="$1"
  mkdir -p "$G/.qoder/rules" "$G/.qoder/scripts" "$G/.qoder/memory" "$G/.qoder-cn/rules" "$G/.qoder-cn/memory"
  printf '# 假 AGENTS（无引用）\n' > "$G/.qoder/AGENTS.md"
  cp "$G/.qoder/AGENTS.md" "$G/.qoder-cn/AGENTS.md"
  cp "$S" "$SCRIPTS/sync-global-config.sh" "$G/.qoder/scripts/"
}
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
run_guard() { local fixtureHome; fixtureHome="$(host_path "$1")"; HOME="$fixtureHome" USERPROFILE="$fixtureHome" QODER_HOME="$fixtureHome/.qoder" node "$G_JS" < /dev/null; }

echo "== T9 guard 独立 HOME 冒烟：应 <8s 内正常退出"
mkfake "$T/g9"
t0=$(date +%s%N); out=$(run_guard "$T/g9"); rc=$?; t1=$(date +%s%N)
ms=$(( (t1 - t0) / 1000000 ))
echo "      guard 输出: [$out]   [${ms}ms]"
if [ "$rc" = 0 ] && [ "$ms" -lt 8000 ]; then ok "T9 guard 冒烟 ${ms}ms"; else bad "T9 guard 冒烟" "rc=$rc ms=$ms" "rc=0 且 <8000ms" "" ""; fi

echo "== T10 guard 端到端（假 HOME + 植入记忆分叉）：必须报出来"
mkfake "$T/g10"
printf 'x1\n' > "$T/g10/.qoder/memory/x.md"
printf 'x2\n' > "$T/g10/.qoder-cn/memory/x.md"
printf '%s\n' '# 索引' '- [X](x.md) — x' > "$T/g10/.qoder/memory/MEMORY.md"
cp "$T/g10/.qoder/memory/MEMORY.md" "$T/g10/.qoder-cn/memory/"
out=$(run_guard "$T/g10"); rc=$?
if [ "$rc" = 0 ] && [[ "$out" == *"memory 检查异常"* ]] && [[ "$out" == *"x.md"* ]]; then ok "T10 guard 报出记忆分叉"; else bad "T10 guard 报出记忆分叉" "rc=$rc" "0 且含 memory 检查异常+x.md" "" "$out"; fi

echo "== T11 量具崩了不许假绿：PATH 里没有 md5sum 时必须报「无法比对」"
reset "$T/t11"
BASH_BIN="$(command -v bash)"
out=$(env -i PATH='' HOME="$T/t11/home" "$BASH_BIN" "$S" 2>&1); chk "T11 无 md5sum 报红" 1 "无法比对（md5sum 未取到内容，查 PATH 或文件可读性）: alpha.md" "$?" "$out"

echo "== T12 guard 端到端（假 HOME 全干净）：必须零输出"
mkfake "$T/g12"
printf '%s\n' '# 索引' '- [M](m.md) — m' > "$T/g12/.qoder/memory/MEMORY.md"
printf 'm body\n' > "$T/g12/.qoder/memory/m.md"
cp "$T/g12/.qoder/memory/MEMORY.md" "$T/g12/.qoder/memory/m.md" "$T/g12/.qoder-cn/memory/"
out=$(run_guard "$T/g12"); rc=$?
if [ "$rc" = 0 ] && [ -z "$out" ]; then ok "T12 guard 干净时静默"; else bad "T12 guard 干净时静默" "rc=$rc 输出=$out" "exit 0 且空输出" "" "$out"; fi

rm -rf "$T"
echo "───────────────"
echo "结果：PASS=$pass FAIL=$fail （临时夹具已清理）"
[ "$fail" -eq 0 ]
