#!/usr/bin/env node
// risky-match-guard 的自测：拦"按匹配动手"的危险形态，放行定点操作（双向都要验）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'risky-match-guard.js');
const SB = path.join(os.tmpdir(), `risky-guard-${Date.now()}`);
fs.mkdirSync(SB, { recursive: true });

let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };
const STATE = path.join(SB, 'state');
fs.mkdirSync(STATE, { recursive: true });
// 本文件的主角是"按匹配动手"的判据，所以默认会话预先标记"已查过记忆"——
// 否则首次风险调用会被记忆门禁顶掉，而老断言只看 blocked，**会拿到假绿**。
const BASE_SESS = 'base-sess';
fs.writeFileSync(path.join(STATE, 'memory-first.json'), JSON.stringify({ [BASE_SESS]: { memSeen: true, warned: {} } }));
const run = (payload) => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(Object.assign({ session_id: BASE_SESS }, payload)), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, RISKY_MATCH_STATE_DIR: STATE, AUTH_LOCK_STATE_DIR: path.join(SB, 'auth-lock'), ATTEMPT_LOCK_STATE_DIR: path.join(SB, 'attempt-lock') },
  });
  let d = {};
  try { d = JSON.parse(r.stdout || '{}'); } catch {}
  return { code: r.status, blocked: d.decision === 'block', reason: d.reason || '', out: (r.stdout || '').slice(0, 120) };
};
const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } });
const sql = (q) => run({ tool_name: 'mcp__dbhub__execute_sql_demo', tool_input: { sql: q } });

// —— 必须拦 ——（每条都额外断言**理由出自本守卫**，防止被记忆门禁顶掉后仍算通过）
const RMG = (r) => r.blocked && /risky-match-guard/.test(r.reason);
check('① rm -rf 带通配 → 拦', RMG(bash('rm -rf build/*')));
check('② find -delete → 拦', RMG(bash('find . -name "*.log" -delete')));
check('③ pkill -f → 拦', RMG(bash('pkill -f java')));
check('④ taskkill /IM → 拦', RMG(bash('taskkill /IM node.exe /F')));
check('⑤ DELETE 无 WHERE → 拦', RMG(sql('DELETE FROM t_config')));
check('⑥ UPDATE 的 WHERE 恒真 → 拦', RMG(sql('UPDATE t SET a=1 WHERE 1=1')));

// —— 必须放行（负对照，防"什么都拦"）——
check('⑦ rm -rf ./build（无通配）→ 放行', !bash('rm -rf ./build').blocked);
check('⑦b rm -f *.tar.gz（非递归清理）→ 放行（宁可窄，不当噪声）', !bash('rm -f 包目录/*.tar.gz').blocked);
check('⑧ rm file.txt → 放行', !bash('rm file.txt').blocked);
check('⑨ pgrep 只读预览 → 放行', !bash('pgrep -af java').blocked);
check('⑩ SELECT 只读 → 放行', !sql('SELECT count(*) FROM t WHERE id = 1').blocked);
check('⑪ DELETE 带明确 WHERE → 放行', !sql('DELETE FROM t WHERE id = 5').blocked);
check('⑫ ls 通配（只读）→ 放行', !bash('ls -la build/*').blocked);
check('⑫a psql -c "DROP TABLE" → 拦', RMG(bash('psql -U app -c "DROP TABLE t_user"')));
check('⑫b mysql -e "TRUNCATE TABLE" → 拦', RMG(bash('mysql -e "TRUNCATE TABLE t_user"')));
check('⑫c psql -c "DELETE FROM"（无 WHERE）→ 拦', RMG(bash('psql -c "DELETE FROM t_user"')));
check('⑫d psql -c "SELECT 1" → 放行', !bash('psql -c "SELECT 1"').blocked);
check('⑫e echo "DROP TABLE"（不是 SQL 客户端）→ 放行', !bash('echo "DROP TABLE t_user"').blocked);
check('⑫f MCP DROP TABLE → 拦', RMG(sql('DROP TABLE t_user')));

// —— 记忆优先门禁（2026-10-21 用户要求：一切操作优先看记忆；无命中/不可用再自行推理）——
const mf = (id, command) => run({ session_id: id, tool_name: 'Bash', tool_input: { command } });
const first = mf('mf-a', 'ssh root@203.0.113.9 "systemctl status some-svc"');
check('⑭ 新会话没读过记忆就要连远端 → 拦，且理由出自 memory-first',
  first.blocked && /memory-first/.test(first.reason) && /优先看记忆/.test(first.reason), first.reason);
const second = mf('mf-a', 'ssh root@203.0.113.9 "uptime"');
check('⑮ 同会话同类第二次 → 放行（只提醒一次，不唠叨）', !second.blocked);
const other = mf('mf-a', 'psql -h 203.0.113.10 -U appuser -c "select 1"');
check('⑯ 同会话换一类风险（数据库）→ 再提醒一次（按类计）', other.blocked && /数据库与中间件/.test(other.reason), other.reason);
run({ session_id: 'mf-b', tool_name: 'Read', tool_input: { file_path: '/home/user/work/memory/MEMORY.md' } });
const afterRead = mf('mf-b', 'plink -l ops 203.0.113.11 hostname');
check('⑰ 该会话读过记忆索引之后 → 风险操作静默放行', !afterRead.blocked, afterRead.reason);
const editHit = run({ session_id: 'mf-c', tool_name: 'Edit', tool_input: { file_path: 'C:/x/t.js', new_string: 'ssh root@192.0.2.1; execute_sql; psql -U u' } });
check('⑱ 负对照：Edit 里**引用**这些关键词不算动手（工具面收窄回归，我改本文件时真被误拦过）', !editHit.blocked, editHit.reason);
const plain = mf('mf-d', 'node --check risky-match-guard.js && ls -la');
check('⑲ 负对照：普通本地命令新会话也不拦', !plain.blocked);
// 2026-10-27：文档正文里提到 curl 不等于要发请求；只读 GET 也不该按"对外动作"拦
const heredoc = mf('mf-e', "cat >> ~/.qoder/scripts/README.md <<'EOF'\n排查时用 curl -s https://example.com 看返回\nEOF");
check('⑲b 负对照：heredoc 正文里提到 curl 不拦（真机误拦过）', !heredoc.blocked, heredoc.reason);
const getOnly = mf('mf-f', 'curl -s https://example.com/health');
check('⑲c 负对照：只读 GET 的 curl 不拦', !getOnly.blocked, getOnly.reason);
const postCurl = mf('mf-g', 'curl -X POST https://example.com/api -d "a=1"');
check('⑲d 正例：状态变更的 curl 仍提醒一次', postCurl.blocked && /对外与部署/.test(postCurl.reason), postCurl.reason);
const quotedSsh = mf('mf-h', 'echo "ssh root@203.0.113.9 uptime" > /dev/null');
check('⑲e 负对照：引号里引用 ssh 命令不拦', !quotedSsh.blocked, quotedSsh.reason);
const rmShadow = mf('mf-e', 'rm -rf build/*');
check('⑳ 记忆门禁不吞既有职责：rm -rf 通配仍由 risky-match-guard 自己拦',
  rmShadow.blocked && /risky-match-guard/.test(rmShadow.reason), rmShadow.reason);
// 单独开关：memoryFirst:false 只关这一格，rm -rf 等既有判据必须仍在
fs.mkdirSync(path.join(SB, 'homeoff', '.qoder'), { recursive: true });
fs.writeFileSync(path.join(SB, 'homeoff', '.qoder', 'risky-match-guard.json'), JSON.stringify({ memoryFirst: false }));
const memOff = spawnSync(process.execPath, [SCRIPT], {
  input: JSON.stringify({ session_id: 'mf-off', tool_name: 'Bash', tool_input: { command: 'ssh root@203.0.113.9 uptime' } }),
  encoding: 'utf8', timeout: 15000,
  env: { ...process.env, RISKY_MATCH_STATE_DIR: path.join(SB, 'state-off'), AUTH_LOCK_STATE_DIR: path.join(SB, 'al-off'), USERPROFILE: path.join(SB, 'homeoff'), HOME: path.join(SB, 'homeoff') },
});
check('㉑ memoryFirst:false 只关记忆门禁（ssh 放行）', memOff.status === 0 && !/memory-first/.test(memOff.stdout || ''), (memOff.stdout || '').slice(0, 90));
const rmStill = spawnSync(process.execPath, [SCRIPT], {
  input: JSON.stringify({ session_id: 'mf-off', tool_name: 'Bash', tool_input: { command: 'rm -rf y/*' } }),
  encoding: 'utf8', timeout: 15000,
  env: { ...process.env, RISKY_MATCH_STATE_DIR: path.join(SB, 'state-off'), AUTH_LOCK_STATE_DIR: path.join(SB, 'al-off'), USERPROFILE: path.join(SB, 'homeoff'), HOME: path.join(SB, 'homeoff') },
});
check('㉒ 同配置下 rm -rf 通配仍拦（关一格不能把整个守卫关掉）', /risky-match-guard/.test(rmStill.stdout || ''), (rmStill.stdout || '').slice(0, 90));

// —— 开关 ——（配置路径是 <HOME>/.qoder/risky-match-guard.json，别漏 .qoder 这层）
fs.mkdirSync(path.join(SB, '.qoder'), { recursive: true });
fs.writeFileSync(path.join(SB, '.qoder', 'risky-match-guard.json'), JSON.stringify({ disabled: true }));
const off = spawnSync(process.execPath, [SCRIPT], {
  input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf x/*' } }), encoding: 'utf8', timeout: 15000,
  env: { ...process.env, RISKY_MATCH_STATE_DIR: path.join(SB, 'state'), USERPROFILE: SB, HOME: SB },
});
check('⑬ disabled 开关生效（配置在 HOME 下）', off.status === 0 && !/block/.test(off.stdout || ''));

try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n${fail} 项失败` : '\nALL PASS');
process.exit(fail ? 1 : 0);
