'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function run(t, code) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-review-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: path.join(home, 'client'), AUTH_LOCK_CONFIG: path.join(home, 'auth.json'), AUTH_LOCK_STATE_DIR: path.join(home, 'auth'), ATTEMPT_LOCK_CONFIG: path.join(home, 'attempt.json'), ATTEMPT_LOCK_STATE_DIR: path.join(home, 'attempt') };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

for (const exitCode of [0, 1]) {
  test('aggregate result does not reset or increment an unrelated build target: exit ' + exitCode, t => run(t, `
    const assert=require('node:assert/strict'),core=require('./scripts/attempt-lock-core.js');
    const a='npm --prefix /fixture-a run build',b='npm --prefix /fixture-b run build';
    const payload=(command,exitCode)=>({tool_name:'Bash',tool_input:{command},tool_response:{exitCode}});
    core.postRecord(payload(a,1));
    const before=JSON.stringify(core.status().entries);
    assert.equal(core.postRecord(payload(a+'; '+b,${exitCode})).kind,'neutral');
    assert.equal(JSON.stringify(core.status().entries),before);
    core.postRecord(payload(a,0));assert.equal(Object.keys(core.status().entries).length,0);
  `));
}

test('a trailing unrelated command cannot prove that a build succeeded', t => run(t, `
  const assert=require('node:assert/strict'),core=require('./scripts/attempt-lock-core.js');
  const a='npm --prefix /fixture-a run build';
  const p=(command,exitCode)=>({tool_name:'Bash',tool_input:{command},tool_response:{exitCode}});
  core.postRecord(p(a,1));const before=JSON.stringify(core.status().entries);
  assert.equal(core.postRecord(p(a+'; echo done',0)).kind,'neutral');
  assert.equal(JSON.stringify(core.status().entries),before);
`));

test('aggregate SQL rows do not prove authentication of the first database target', t => run(t, `
  const assert=require('node:assert/strict'),core=require('./scripts/auth-lock-core.js');
  const a='psql -h db-a.example -U fixture_a',b='psql -h db-b.example -U fixture_b';
  const payload=(command,response)=>({tool_name:'Bash',tool_input:{command},tool_response:response});
  core.postRecord(payload(a,'password authentication failed'));
  const before=JSON.stringify(core.status().entries);
  assert.equal(core.postRecord(payload(a+'; '+b,{exitCode:0,stdout:'(1 row)'})).kind,'neutral');
  assert.equal(JSON.stringify(core.status().entries),before);
  assert.equal(core.postRecord(payload(a,{exitCode:0,stdout:'(1 row)'})).kind,'ok');
  assert.equal(Object.keys(core.status().entries).length,0);
`));

test('an unqualified aggregate auth error does not blame an arbitrary database target', t => run(t, `
  const assert=require('node:assert/strict'),core=require('./scripts/auth-lock-core.js');
  const p={tool_name:'Bash',tool_input:{command:'psql -h db-a.example -U fixture_a; psql -h db-b.example -U fixture_b'},tool_response:'password authentication failed'};
  assert.equal(core.postRecord(p).kind,'neutral');
  assert.equal(Object.keys(core.status().entries).length,0);
`));

test('an aggregate auth error with one exact response identity can be attributed', t => run(t, `
  const assert=require('node:assert/strict'),core=require('./scripts/auth-lock-core.js');
  const p={tool_name:'Bash',tool_input:{command:'psql -h db-a.example -U fixture_a; psql -h db-b.example -U fixture_b'},tool_response:'password authentication failed for user "fixture_b"'};
  const r=core.postRecord(p);assert.equal(r.kind,'authfail');assert.equal(r.count,1);
  const entries=Object.values(core.status().entries);assert.equal(entries.length,1);assert.equal(entries[0].dims.host,'db-b.example');
`));

test('multiple reported auth identities are not reduced to the first error', t => run(t, `
  const assert=require('node:assert/strict'),core=require('./scripts/auth-lock-core.js');
  for(const separator of ['\\n','; ']) {
    const p={tool_name:'Bash',tool_input:{command:'psql -h db-a.example -U fixture_a; psql -h db-b.example -U fixture_b'},tool_response:'password authentication failed for user "fixture_a"'+separator+'password authentication failed for user "fixture_b"'};
    assert.equal(core.postRecord(p).kind,'neutral');
    assert.equal(Object.keys(core.status().entries).length,0);
  }
`));
