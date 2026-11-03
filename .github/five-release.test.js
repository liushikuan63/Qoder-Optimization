'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'five-release-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: path.join(home, '.qoder'), AUTH_LOCK_STATE_DIR: path.join(home, 'auth'), AUTH_LOCK_CONFIG: path.join(home, 'auth.json'), ATTEMPT_LOCK_STATE_DIR: path.join(home, 'attempt'), ATTEMPT_LOCK_CONFIG: path.join(home, 'attempt.json') };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = code => {
    const r = spawnSync(process.execPath, ['-e', code], { env, cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };
  return { home, env, run };
}

test('Bash dir_path keeps distinct project retry budgets', t => {
  const f = fixture(t);
  f.run(`const assert=require('node:assert/strict'),core=require('./scripts/attempt-lock-core.js');
    const payload=dir=>({tool_name:'Bash',tool_input:{command:'npm run build',dir_path:dir},tool_response:{exitCode:1}});
    const a=payload('/project-a'),b=payload('/project-b');
    for(let i=0;i<3;i++)core.postRecord(a);
    assert.ok(core.preCheck(a));assert.equal(core.preCheck(b),null);
    assert.equal(core.postRecord(b).count,1);`);
});

test('every command target is checked before a compound Bash call', t => {
  const f = fixture(t);
  f.run(`const assert=require('node:assert/strict'),core=require('./scripts/attempt-lock-core.js');
    const target={tool_name:'Bash',tool_input:{command:'npm --prefix /blocked-project run build'},tool_response:{exitCode:1}};
    for(let i=0;i<3;i++)core.postRecord(target);
    for(const command of ['npm --prefix /other-project run test; npm --prefix /blocked-project run build','npm --prefix /other-project run build; npm --prefix /blocked-project run build'])
      assert.ok(core.preCheck({tool_name:'Bash',tool_input:{command}}),command);`);
});

for (const shape of ['payload', 'envelope', 'mcp-content']) {
  test('explicit tool errors cannot use row-shaped text to clear auth failures: ' + shape, t => {
    const f = fixture(t);
    f.run(`const assert=require('node:assert/strict'),core=require('./scripts/auth-lock-core.js');
      const p={tool_name:'Bash',tool_input:{command:'psql -h db.example -U test_user'},tool_response:'password authentication failed'};
      assert.equal(core.postRecord(p).count,1);
      const response=${JSON.stringify(shape)}==='mcp-content'?{isError:true,content:[{type:'text',text:'{"rows":[]}'}]}:{is_error:true,stdout:'(1 row)',rows:[]};
      const next={...p,tool_response:response};if(${JSON.stringify(shape)}==='payload'){next.is_error=true;next.tool_response={stdout:'(1 row)',rows:[]};}
      assert.notEqual(core.postRecord(next).kind,'ok');assert.equal(Object.values(core.status().entries)[0].count,1);`);
  });
}

test('structured errors arrays cannot hide authentication failures behind rows', t => {
  const f = fixture(t);
  f.run(`const assert=require('node:assert/strict'),core=require('./scripts/auth-lock-core.js');
    const p={tool_name:'Bash',tool_input:{command:'psql -h db.example -U test_user'},tool_response:'password authentication failed'};
    assert.equal(core.postRecord(p).count,1);
    const next={...p,tool_response:{errors:[{message:'password authentication failed'}],rows:[]}};
    const result=core.postRecord(next);assert.equal(result.kind,'authfail');assert.equal(result.count,2);`);
});

test('candidate reports require independent qualified tasks and preserve scopes', t => {
  const f = fixture(t);
  const records = path.join(f.env.QODER_HOME, 'evolution/records');
  fs.mkdirSync(records, { recursive: true });
  const write = (id, topic, scope, task, session, source = 'user') => fs.writeFileSync(path.join(records, id + '.json'), JSON.stringify({ id, type: 'observation', topic, scope, summary: 'fixture', created_at: new Date().toISOString(), verified: false, explicit: false, evidence: { task_id: task, session_id: session, source, detail: 'fixture' } }));
  for (let i = 0; i < 3; i++) {
    write('duplicate-' + i, 'duplicate', 'project-a', 'task-a', 'session-' + i);
    write('external-' + i, 'external', 'project-a', 'task-' + i, 'session-' + i, 'external');
    write('scope-' + i, 'different-scopes', 'project-' + i, 'task-' + i, 'session-' + i);
    write('qualified-' + i, 'qualified', 'global', 'task-' + i, 'session-' + i);
  }
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/evolution-candidates.cjs'), '--json'], { env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const candidates = JSON.parse(r.stdout).candidates;
  assert.equal(candidates.some(c => ['duplicate', 'external', 'different-scopes'].includes(c.title) && c.kind === 'promote-global'), false);
  assert.equal(candidates.find(c => c.title === 'qualified').kind, 'promote-global');
  assert.equal(candidates.filter(c => c.title === 'different-scopes').length, 3);
});

const read = file => fs.readFileSync(path.join(root, file), 'utf8');
test('reverse junction conversion restores and verifies full data before unlinking', () => {
  const section = read('skills/disk-junction-migration/SKILL.md').split('## 步骤 5b')[1].split('## 步骤 6')[0];
  assert.match(section, /复制[\s\S]*SHA-?256[\s\S]*断链/);
  assert.doesNotMatch(section, /原地 `New-Item -ItemType Directory` 建真实目录/);
});
test('evolution panel forensics never requires patching the host worker', () => {
  assert.doesNotMatch(read('skills/skill-authoring-closure/references/qoder-evolution-panel.md'), /需临时在 worker 运行时顶部插 stdout/);
});
test('live proxy maintenance is manual and sandbox process cleanup stays scoped', () => {
  const text = read('skills/local-reverse-proxy-triage/SKILL.md');
  assert.match(text, /现役[\s\S]*用户本人[\s\S]*隔离测试/);
  assert.doesNotMatch(text, /必须 `taskkill \/PID <pid> \/T` 连父链/);
});
test('credential negative controls exclude shared production accounts', () => {
  assert.match(read('skills/byok-model-retry/references/dual-client-config-sync.md'), /生产[\s\S]*共享账号[\s\S]*不得/);
});
test('temporary debugging findings are not routed to lasting memory', () => {
  assert.doesNotMatch(read('Qoder-AI编码通用规则.md'), /一次性环境事实 \/ 排错结论 → 记忆/);
});
