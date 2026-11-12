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

console.log(`\n${pass} PASS / ${fail} FAIL`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail === 0 ? 0 : 1);
