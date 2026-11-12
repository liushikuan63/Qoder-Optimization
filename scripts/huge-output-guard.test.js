#!/usr/bin/env node
// huge-output-guard 的自测：把每条判据的**正例与反例**都跑一遍。
// 为什么要正例：守卫最容易的坏法不是"不拦"，而是"拦得太多"——那样每一轮都在和它打架，
// 结果是我把它关掉，比没有它还糟。所以"该放行的必须放行"与"该拦的必须拦"是同等强度的判据。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.join(__dirname, 'huge-output-guard.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hog-test-'));
const BIG = path.join(TMP, 'big.md');
const SMALL = path.join(TMP, 'small.md');
fs.writeFileSync(BIG, Array.from({ length: 1500 }, (_, i) => `第 ${i} 行：一些足够长的中文内容，用来把文件撑到 40KB 以上。`).join('\n'));
fs.writeFileSync(SMALL, '短文件\n两行\n');

let pass = 0;
let fail = 0;
function check(name, payload, expect, env = {}) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, HUGE_OUTPUT_GUARD_STATE_DIR: path.join(TMP, 'state'), ...env },
  });
  const out = (r.stdout || '').trim();
  let decision = 'allow';
  let reason = '';
  if (out) {
    try {
      const j = JSON.parse(out).hookSpecificOutput || {};
      decision = j.permissionDecision || 'allow';
      reason = j.permissionDecisionReason || '';
    } catch (e) { decision = 'PARSE_FAIL: ' + out.slice(0, 80); }
  }
  // 守卫崩掉时 stdout 也是空的 —— 只看「输出空＝allow」会让**全部 allow 侧负对照恒绿**
  // （实测：把 GUARD 换成 exit 1 + stderr 的死脚本，旧断言仍有 23 条 PASS）。
  // 所以退出码与 stderr 必须一起断言：守卫必须活着、且没报错，判定才算数。
  const alive = r.status === 0 && !(r.stderr || '').trim();
  const ok = alive && decision === expect && (expect !== 'deny' || reason.length > 20);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → ${decision}${alive ? '' : '  「守卫异常 exit=' + r.status + ' stderr=' + (r.stderr || '').trim().slice(0, 40) + '」'}${reason ? '  「' + reason.slice(0, 48) + '…」' : ''}`);
  ok ? pass++ : fail++;
}

const pre = (tool, input) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: TMP });

// 2026-10-27：只读查询类改为"自动追加 | head -100 后执行"，断言决策是 allow 且命令确实被改写
function rewriteCheck(name, payload, env = {}) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, HUGE_OUTPUT_GUARD_STATE_DIR: path.join(TMP, 'state'), ...env },
  });
  const j = (() => { try { return JSON.parse((r.stdout || '{}').trim()).hookSpecificOutput || {}; } catch (e) { return {}; } })();
  const cmd = (j.updatedInput || {}).command || '';
  const ok = j.permissionDecision === 'allow' && /\| head -100\s*$/.test(cmd);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  → ${j.permissionDecision || 'allow'}  「${cmd.slice(0, 60)}」`);
  ok ? pass++ : fail++;
}

console.log('— Read —');
check('整读 60KB+ 的文件：拦', pre('Read', { file_path: BIG }), 'deny');
check('同一文件带 limit 的局部读：放行', pre('Read', { file_path: BIG, offset: 1, limit: 200 }), 'allow');
check('小文件整读：放行', pre('Read', { file_path: SMALL }), 'allow');
check('不存在的文件：放行（让 Read 自己报错，比守卫猜错好）', pre('Read', { file_path: path.join(TMP, 'nope.md') }), 'allow');
check('不存在的大图：放行（让 Read 自己报错）', pre('Read', { file_path: path.join(TMP, 'x.png') }), 'allow');
// 2026-10-27 补：图片 base64 膨胀口径
const BIGIMG = path.join(TMP, 'big.png');
const SMALLIMG = path.join(TMP, 'small.png');
fs.writeFileSync(BIGIMG, Buffer.alloc(2 * 1024 * 1024));
fs.writeFileSync(SMALLIMG, Buffer.alloc(200 * 1024));
check('整张读取 2MB 图片：拦（base64 还会再放大 1/3）', pre('Read', { file_path: BIGIMG }), 'deny');
check('200KB 图片：放行', pre('Read', { file_path: SMALLIMG }), 'allow');

console.log('— Bash —');
rewriteCheck('cat 整个文件：自动追加 head 后执行', pre('Bash', { command: 'cat 收口清单.md' }));
check('cat | head：放行', pre('Bash', { command: 'cat 收口清单.md | head -40' }), 'allow');
rewriteCheck('grep 不加限流：自动追加 head 后执行', pre('Bash', { command: 'grep -rn "foo" server/' }));
check('grep -l：放行', pre('Bash', { command: 'grep -rl "foo" server/' }), 'allow');
check('grep -c：放行', pre('Bash', { command: 'grep -c "foo" a.txt' }), 'allow');
rewriteCheck('git log 裸跑：自动追加 head 后执行', pre('Bash', { command: 'git log' }));
check('git log --oneline -20：放行', pre('Bash', { command: 'git log --oneline -20' }), 'allow');
check('mvn test 不重定向：仍拦（管道 head 会 SIGPIPE 掐断构建）', pre('Bash', { command: 'mvn -f server/pom.xml test' }), 'deny');
check('mvn test 重定向到文件：放行', pre('Bash', { command: 'mvn test > /tmp/x.log 2>&1; tail -5 /tmp/x.log' }), 'allow');
rewriteCheck('find 裸跑：自动追加 head 后执行', pre('Bash', { command: 'find .' }));
rewriteCheck('find 带 -name 也要限流：自动追加 head 后执行', pre('Bash', { command: 'find . -name "*.ts"' }));
check('find | head：放行', pre('Bash', { command: 'find . -name "*.ts" | head -30' }), 'allow');
rewriteCheck('ls -R：自动追加 head 后执行', pre('Bash', { command: 'ls -R client' }));
// 复合命令不自动改写（改写只会作用到最后一段，语义会变） → 保持拦截
check('复合命令（grep; ls）：仍拦', pre('Bash', { command: 'grep -rn x server/; ls' }), 'deny');
check('hogMode:deny 关闭自动改写（对照组）', pre('Bash', { command: 'grep -rn "foo" server/' }), 'deny', { HOG_MODE: 'deny' });
check('普通小命令（ls 一层 / pwd / echo）：放行',
  pre('Bash', { command: 'ls client/assets/scripts | head -5' }), 'allow');
check('npm test：拦', pre('Bash', { command: 'npm test' }), 'deny');
check('node --test 重定向：放行', pre('Bash', { command: 'node --test build-test/tests/ > /tmp/t.log 2>&1' }), 'allow');

// C11：限流器只认"存在"不认"上界"时，`head -c 999999` ≈ 1MB 照样进上下文。
// 这一组是 T-20 的判据，**每条都要能失败**：上界有效的必须放行，实质无界的必须拦。
console.log('— C11 限流上界 —');
check('Read limit=999999（实质无界）：拦', pre('Read', { file_path: BIG, limit: 999999 }), 'deny');
check('Read offset=0 + limit=999999：拦', pre('Read', { file_path: BIG, offset: 0, limit: 999999 }), 'deny');
check('head -c 999999：拦', pre('Bash', { command: 'head -c 999999 收口清单.md' }), 'deny');
check('head -n 999999：拦（通用 /-n\\s*\\d+/ 不得救回放行）', pre('Bash', { command: 'head -n 999999 收口清单.md' }), 'deny');
check('head -n999999（无空格）：拦', pre('Bash', { command: 'head -n999999 收口清单.md' }), 'deny');
check('tail -n 999999：拦', pre('Bash', { command: 'tail -n 999999 收口清单.md' }), 'deny');
check('head --lines=999999：拦（与 -n 形式同判）', pre('Bash', { command: 'head --lines=999999 收口清单.md' }), 'deny');
check('head -c 2000：放行（上界有效）', pre('Bash', { command: 'head -c 2000 收口清单.md' }), 'allow');
check('head -n 20：放行（上界有效）', pre('Bash', { command: 'head -n 20 收口清单.md' }), 'allow');
check('git log -n 20：放行（非 head/tail，判据不外扩）', pre('Bash', { command: 'git log -n 20' }), 'allow');
check('cat 大文件 > out.txt：放行（重定向是契约内限流器）', pre('Bash', { command: 'cat 收口清单.md > /tmp/out.txt' }), 'allow');
check('cat 大文件 | wc -l：放行（管道是限流器）', pre('Bash', { command: 'cat 收口清单.md | wc -l' }), 'allow');

// C11 第二轮（修一处扫一片）：上界判据的四个残留缺口，每条都先跑出过红。
// ① 管道/末段：失效上界在**最后一段**时，`|` 不能救回放行；② 旧式 `head -<数>`；
// ③ `tail -n +K`（输出到末尾，实质无界）；④ `-c700` 与 `-c 700` 必须同判。
console.log('— C11 上界判据的残留缺口 —');
check('cat 大文件 | head -n 999999：拦（末段失效，管道救不回）',
  pre('Bash', { command: 'cat 收口清单.md | head -n 999999' }), 'deny', { HOG_MODE: 'deny' });
check('head -n 999999 | grep foo：拦（末段无界）',
  pre('Bash', { command: 'head -n 999999 收口清单.md | grep foo' }), 'deny', { HOG_MODE: 'deny' });
check('head -999999（旧式无字母选项）：拦', pre('Bash', { command: 'head -999999 收口清单.md' }), 'deny');
check('tail -999999（旧式）：拦', pre('Bash', { command: 'tail -999999 收口清单.md' }), 'deny');
check('tail -n +1（从头输出到末尾）：拦', pre('Bash', { command: 'tail -n +1 收口清单.md' }), 'deny');
check('tail -n +999999：拦', pre('Bash', { command: 'tail -n +999999 收口清单.md' }), 'deny');
check('head -c700（无空格）：放行（700 字节，与 -c 700 同判）', pre('Bash', { command: 'head -c700 收口清单.md' }), 'allow');
check('head -c 700：放行（上一条的负对照，两者必须同结果）', pre('Bash', { command: 'head -c 700 收口清单.md' }), 'allow');
check('head -n 999999 | wc -l：放行（末段真的限住了输出）', pre('Bash', { command: 'head -n 999999 收口清单.md | wc -l' }), 'allow');
check('cat | head -n 999999 | head -20：放行（末段上界有效）', pre('Bash', { command: 'cat 收口清单.md | head -n 999999 | head -20' }), 'allow');
check('head -n 999999 > 文件：放行（重定向的输出不进上下文）', pre('Bash', { command: 'head -n 999999 收口清单.md > /tmp/out.txt' }), 'allow');
check('tail -n +2 | head -20：放行（跳表头后仍被限流）', pre('Bash', { command: 'tail -n +2 收口清单.md | head -20' }), 'allow');
check('head -601（旧式刚过阈值）：拦', pre('Bash', { command: 'head -601 收口清单.md' }), 'deny');
check('head -600（旧式边界）：放行', pre('Bash', { command: 'head -600 收口清单.md' }), 'allow');

console.log('— 内联脚本里的反引号（会被 bash 先执行） —');
check('node -e "…" 里带反引号：拦（那串会被当命令跑）',
  pre('Bash', { command: 'node -e "const s = 1 // 跑 scripts/build.sh 之前先看 `date`"' }), 'deny');
check('node -e 双引号里**没有**反引号：放行（不是这条管的范围）',
  pre('Bash', { command: 'node -e "console.log(1)"' }), 'allow');
check('node -e 用单引号包住、里面有反引号：放行（bash 不做命令替换）',
  pre('Bash', { command: "node -e 'console.log(`date`)', 安全" }), 'allow');
check('双引号里有反引号但不是内联解释器：这条不管（范围只圈 node/python -e 这类）',
  pre('Bash', { command: 'echo "hello"' }), 'allow');
check('python -c 里带反引号：拦',
  pre('Bash', { command: 'python -c "print(`id`)"' }), 'deny');
check('反引号只出现在**带引号的 heredoc 正文**里：放行（bash 在那里不做替换，这是安全写法本身）',
  pre('Bash', { command: "cat > /tmp/x.cjs <<'EOF'\n// 文档里写 node -e \"跑 `date`\"\nEOF" }), 'allow');

console.log('— Agent —');
{
  const payload = pre('Agent', { description: 'x', prompt: '查一下 Y' });
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload), encoding: 'utf8',
    env: { ...process.env, HUGE_OUTPUT_GUARD_STATE_DIR: path.join(TMP, 'state') },
  });
  const j = JSON.parse((r.stdout || '{}').trim() || '{}').hookSpecificOutput || {};
  const ok = j.permissionDecision === 'allow'
    && typeof j.updatedInput.prompt === 'string'
    && j.updatedInput.prompt.includes('回报硬约束');
  console.log(`${ok ? 'PASS' : 'FAIL'}  子代理提示词被追加"只回结论 ≤300 字"的硬约束`);
  ok ? pass++ : fail++;
}

console.log('— 其它事件不该被这条守卫管 —');
check('非 PreToolUse 事件：静默放行', { hook_event_name: 'Stop', tool_name: 'Read', tool_input: { file_path: BIG } }, 'allow');

// ---- F73-F75 ----
// 2026-11-12 第七段通读实测出的三处漏判（probe-f73-75-hog.cjs 修前 12 条红、19 条负对照绿）。
// 每处都配"该放行的必须放行"的负对照：守卫拦得太多，我会把它关掉，那比没有它还糟。
console.log('— F73 单行大文件（只数 \\n 会把 300KB 算成 0 行） —');
const ONELINE = path.join(TMP, 'oneline-300k.txt');
const ONELINE_NL = path.join(TMP, 'oneline-300k-nl.txt');
fs.writeFileSync(ONELINE, 'a'.repeat(300 * 1024));            // 无结尾换行
fs.writeFileSync(ONELINE_NL, 'a'.repeat(300 * 1024) + '\n');  // 有结尾换行
check('整读 300KB 单行无换行文件：拦', pre('Read', { file_path: ONELINE }), 'deny');
check('同体积但带一个换行：拦（对照，证明差别只在换行）', pre('Read', { file_path: ONELINE_NL }), 'deny');
check('单行大文件 limit=999999（实质无界）：拦', pre('Read', { file_path: ONELINE, limit: 999999 }), 'deny');
check('负对照：小文件整读放行', pre('Read', { file_path: SMALL }), 'allow');
// 2026-11-12 第八段：这里原来写着「单行大文件带 limit=100 / 只带 offset 放行」两条负对照——
// **它们是错的**：limit 按行数限流，300KB 单行文件的 limit=100 与 offset=1 实际都读进整份 300KB。
// 错的负对照把 F80 那个洞钉成了绿（修前 88 PASS / 0 FAIL 就是这么来的）。换成真正有界的读：
check('负对照：小文件带 limit=100（真的只有两行）放行', pre('Read', { file_path: SMALL, limit: 100 }), 'allow');
check('负对照：多行大文件 offset=1495（余 6 行，字节很小）放行', pre('Read', { file_path: BIG, offset: 1495 }), 'allow');

console.log('— F74 head/tail 的 +K 形与 K/M 后缀 —');
check('tail -c +1（从第 1 字节到末尾）：拦', pre('Bash', { command: 'tail -c +1 big.log' }), 'deny');
check('tail --bytes=+1：拦', pre('Bash', { command: 'tail --bytes=+1 big.log' }), 'deny');
check('head -c 5M（1024 进制 ≈5MB）：拦', pre('Bash', { command: 'head -c 5M big.log' }), 'deny');
check('head -c 5MB（1000 进制 ≈5MB）：拦', pre('Bash', { command: 'head -c 5MB big.log' }), 'deny');
check('head -n 2K（2048 行 > 600）：拦', pre('Bash', { command: 'head -n 2K big.log' }), 'deny');
check('head -n 1K（1024 行 > 600）：拦', pre('Bash', { command: 'head -n 1K big.log' }), 'deny');
check('head -c 5X（认不出的后缀按无界处理）：拦', pre('Bash', { command: 'head -c 5X big.log' }), 'deny');
check('对照：head -c 5000000 同语义：拦', pre('Bash', { command: 'head -c 5000000 big.log' }), 'deny');
check('对照：tail -n +1：拦', pre('Bash', { command: 'tail -n +1 big.log' }), 'deny');
check('负对照：head -c 100 放行', pre('Bash', { command: 'head -c 100 big.log' }), 'allow');
check('负对照：tail -c 2K（2048 字节）放行', pre('Bash', { command: 'tail -c 2K big.log' }), 'allow');
check('负对照：head -n 512（512 行 ≤ 600）放行', pre('Bash', { command: 'head -n 512 big.log' }), 'allow');
check('负对照：head -c 5M … | wc -l（末段真限流）放行', pre('Bash', { command: 'head -c 5M big.log | wc -l' }), 'allow');
check('负对照：tail -c +1 … | head -5（末段真限流）放行', pre('Bash', { command: 'tail -c +1 big.log | head -5' }), 'allow');
check('负对照：head -c 5M … > 文件（输出不进上下文）放行', pre('Bash', { command: 'head -c 5M big.log > /tmp/out.txt' }), 'allow');

console.log('— F75 heredoc 豁免只覆盖正文 + shell -c 也是内联解释器 —');
check('node -e "…`date`…" 后挂 <<\'EOF\'：拦（豁免不能被整条命令借走）',
  pre('Bash', { command: 'node -e "console.log(`date`)" <<\'EOF\'\n无关正文\nEOF' }), 'deny');
check('heredoc 正文安全、正文之外另有内联反引号：拦',
  pre('Bash', { command: 'node -e "console.log(`date`)"; cat > /tmp/y.cjs <<\'EOF\'\n// `safe`\nEOF' }), 'deny');
check('bash -c "echo `date`"：拦', pre('Bash', { command: 'bash -c "echo `date`"' }), 'deny');
check('sh -c "echo `date`"：拦', pre('Bash', { command: 'sh -c "echo `date`"' }), 'deny');
check('对照：不带引号的 heredoc（bash 会替换）+ 内联反引号：拦',
  pre('Bash', { command: 'node -e "console.log(`date`)" <<EOF\n无关正文\nEOF' }), 'deny');
check('负对照：反引号只在带引号 heredoc 正文里：放行（安全写法本身）',
  pre('Bash', { command: 'cat > /tmp/x.cjs <<\'EOF\'\n// 文档里写 node -e "跑 `date`"\nEOF' }), 'allow');
check('负对照：<<- 缩进结束标记的 heredoc 正文里有反引号：放行',
  pre('Bash', { command: 'cat > /tmp/x.cjs <<-\'EOF\'\n\t// node -e "跑 `date`"\n\tEOF' }), 'allow');
check('负对照：bash -c 单引号里有反引号：放行', pre('Bash', { command: "bash -c 'echo `date`'" }), 'allow');
check('负对照：bash -c 双引号里没有反引号：放行', pre('Bash', { command: 'bash -c "echo hello"' }), 'allow');
check('负对照：node -e 双引号里没有反引号：放行', pre('Bash', { command: 'node -e "console.log(1)"' }), 'allow');

// ---- F80 / F86 ----
// 2026-11-12 第八段通读（probe-f80-86.cjs 修前 14 条红、18 条负对照/回归绿）。
// F80：显式 offset/limit 曾**早退**，跳过字节投影 ⇒ 单行大文件配 limit/offset 照样灌满上下文。
// F86：`2>&1` 是 fd 复制（输出仍进上下文），旧 REDIRECT_LIMITER 把它当成「重定向到文件」。
console.log('— F80 显式 offset/limit 不得跳过字节投影 —');
const TWOFAT = path.join(TMP, 'two-fat-lines.txt');
const MANY = path.join(TMP, 'many-short-lines.txt');
fs.writeFileSync(TWOFAT, 'b'.repeat(100 * 1024) + '\n' + 'c'.repeat(100 * 1024) + '\n');
fs.writeFileSync(MANY, Array.from({ length: 5000 }, (_, i) => `line ${i} padpadpad`).join('\n'));
check('单行 300KB + limit=100（一行就是 300KB）：拦', pre('Read', { file_path: ONELINE, limit: 100 }), 'deny');
check('单行 300KB + 只带 offset=1（读到 EOF＝整份）：拦', pre('Read', { file_path: ONELINE, offset: 1 }), 'deny');
check('单行 300KB（带结尾换行）+ limit=100：拦', pre('Read', { file_path: ONELINE_NL, limit: 100 }), 'deny');
check('单行 300KB + offset=1&limit=100：拦', pre('Read', { file_path: ONELINE, offset: 1, limit: 100 }), 'deny');
check('单行 300KB + limit=1（一行仍 300KB）：拦', pre('Read', { file_path: ONELINE, limit: 1 }), 'deny');
check('两行各 100KB + limit=1（100KB > 40KB）：拦', pre('Read', { file_path: TWOFAT, limit: 1 }), 'deny');
check('两行各 100KB + offset=2（余 1 行 100KB）：拦', pre('Read', { file_path: TWOFAT, offset: 2 }), 'deny');
check('5000 短行 + offset=1（余量≈100KB）：拦', pre('Read', { file_path: MANY, offset: 1 }), 'deny');
check('负对照：小文件 + limit=100 放行', pre('Read', { file_path: SMALL, limit: 100 }), 'allow');
check('负对照：60KB 多行 + offset=1&limit=200（≈16KB）放行', pre('Read', { file_path: BIG, offset: 1, limit: 200 }), 'allow');
check('负对照：5000 短行 + limit=600（≈12KB）放行', pre('Read', { file_path: MANY, limit: 600 }), 'allow');
check('负对照：5000 短行 + offset=4990（余 11 行）放行', pre('Read', { file_path: MANY, offset: 4990 }), 'allow');
check('负对照：offset 超出 EOF（读不到东西）放行', pre('Read', { file_path: BIG, offset: 99999 }), 'allow');

console.log('— F86 `2>&1` 是 fd 复制，不是「输出不进上下文」 —');
check('node --test scripts/ 2>&1：拦', pre('Bash', { command: 'node --test scripts/ 2>&1' }), 'deny');
check('git log 2>&1：拦', pre('Bash', { command: 'git log 2>&1' }), 'deny');
check('cat big.md 2>&1：拦', pre('Bash', { command: 'cat big.md 2>&1' }), 'deny');
check('grep -r foo . 2>&1：拦', pre('Bash', { command: 'grep -r foo . 2>&1' }), 'deny');
check('find . 1>&2：拦', pre('Bash', { command: 'find . 1>&2' }), 'deny');
check('node --test x 2>>&1（append 形 fd 复制）：拦', pre('Bash', { command: 'node --test x 2>>&1' }), 'deny');
check('负对照：mvn test > /tmp/x.log 2>&1; tail -5 放行', pre('Bash', { command: 'mvn test > /tmp/x.log 2>&1; tail -5 /tmp/x.log' }), 'allow');
check('负对照：node --test … > /tmp/t.log 2>&1 放行', pre('Bash', { command: 'node --test build-test/tests/ > /tmp/t.log 2>&1' }), 'allow');
check('负对照：git log --oneline 2>&1（--oneline 真限流）放行', pre('Bash', { command: 'git log --oneline 2>&1' }), 'allow');
check('负对照：cat big.md > /dev/null 2>&1（真丢弃）放行', pre('Bash', { command: 'cat big.md > /dev/null 2>&1' }), 'allow');
check('负对照：node --test x >> /tmp/t.log 2>&1（append 真重定向）放行', pre('Bash', { command: 'node --test x >> /tmp/t.log 2>&1' }), 'allow');
check('负对照：git log | head -20 放行', pre('Bash', { command: 'git log | head -20' }), 'allow');

console.log(`\n${pass} PASS / ${fail} FAIL`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail === 0 ? 0 : 1);
