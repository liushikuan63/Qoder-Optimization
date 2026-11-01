'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { encodeTar, archiveEntries } = require('../scripts/archive-entries.cjs');
const source = path.resolve(__dirname, '..');

function fixture(body) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-test-'));
  const home = path.join(base, 'home'), client = path.join(home, '.qoder');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: client, TEMP: base, TMP: base, TMPDIR: base, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'Local') };
  const run = (script, args) => spawnSync(process.execPath, [path.join(source, 'scripts', script), ...args], { env, encoding: 'utf8', timeout: 60000 });
  const archive = (entries, name = 'memory.tar.gz') => {
    const file = path.join(base, name);
    fs.writeFileSync(file, zlib.gzipSync(encodeTar(entries.map(([name, text]) => ({ name, data: Buffer.from(text) })))));
    return file;
  };
  try { body({ base, home, client, env, run, archive }); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

for (const prefix of ['', 'qoder-memory-export-demo/']) {
  test('memory import supports root layout ' + (prefix || 'flat') + ' without implicit writes', () => fixture(f => {
    const file = f.archive([[prefix + 'MEMORY.md', '- [A](a.md)'], [prefix + 'a.md', 'approved memory']]);
    assert.equal(f.run('import-memory.cjs', [file]).status, 0);
    assert.equal(fs.existsSync(f.client), false);
    const r = f.run('import-memory.cjs', [file, '--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(f.client, 'memory/a.md'), 'utf8'), 'approved memory');
    assert.equal(f.run('import-memory.cjs', [file, '--apply']).status, 0);
  }));
}

test('memory conflict rejects the entire import, including new files', () => fixture(f => {
  const file = f.archive([['MEMORY.md', 'new index'], ['a.md', 'new memory']]);
  fs.mkdirSync(path.join(f.client, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(f.client, 'memory/MEMORY.md'), 'existing index');
  const r = f.run('import-memory.cjs', [file, '--apply']);
  assert.equal(r.status, 2);
  assert.equal(fs.readFileSync(path.join(f.client, 'memory/MEMORY.md'), 'utf8'), 'existing index');
  assert.equal(fs.existsSync(path.join(f.client, 'memory/a.md')), false);
}));

test('archive path traversal and corrupted headers are rejected before import', () => fixture(f => {
  assert.throws(() => encodeTar([{ name: '../escape.md', data: Buffer.from('x') }]), /unsafe/);
  const data = encodeTar([{ name: 'MEMORY.md', data: Buffer.from('x') }]);
  data[0] ^= 1;
  const file = path.join(f.base, 'bad.tar.gz');
  fs.writeFileSync(file, zlib.gzipSync(data));
  assert.equal(f.run('import-memory.cjs', [file, '--apply']).status, 2);
  assert.equal(fs.existsSync(f.client), false);
}));

test('archive encoder roundtrip preserves independent input bytes', () => {
  const entries = [{ name: 'MEMORY.md', data: Buffer.from('index') }, { name: 'a.md', data: Buffer.from([0, 127, 255]) }];
  assert.deepEqual(archiveEntries('test.tar.gz', zlib.gzipSync(encodeTar(entries))), entries);
});

test('disk read-only mode never writes a heartbeat and rejects write flags', () => fixture(f => {
  const empty = path.join(f.base, 'empty'); fs.mkdirSync(empty);
  const args = ['--root', empty, '--extra-root', empty, '--simulate-free', String(100 * 1024 ** 3), '--json'];
  let r = f.run('disk-sweeper.js', [...args, '--read-only']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(f.client), false);
  assert.equal(f.run('disk-sweeper.js', [...args, '--read-only', '--apply']).status, 2);
  r = f.run('disk-sweeper.js', args);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(f.client, 'tmp/disk-sweeper/heartbeat.log')), true);
}));

test('weekly read-only mode propagates to child checks and does not write history', () => fixture(f => {
  const scripts = path.join(f.client, 'scripts'); fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['sync-memory.sh', 'sync-global-config.sh']) fs.writeFileSync(path.join(scripts, name), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(scripts, 'stop-gate.js'), "console.log('empty report')");
  for (const file of ['tmp-sweeper.js', 'client-root.js']) fs.copyFileSync(path.join(source, 'scripts', file), path.join(scripts, file));
  fs.writeFileSync(path.join(scripts, 'disk-sweeper.js'), "if (!process.argv.includes('--read-only')) process.exit(7); console.log(JSON.stringify({freeGb:100,level:'ok',tier1Files:0,tier1Bytes:0,extraFiles:0,extraBytes:0}));");
  for (const flag of ['--read-only', '--no-fix']) {
    const r = f.run('rules-weekly-audit.js', [flag]);
    assert.ok(r.status === 0 || r.status === 1, r.stdout + r.stderr);
    assert.equal(r.stdout.includes('disk-sweeper.js --json 未能执行'), false);
    assert.equal(r.stdout.includes('tmp-sweeper.js 未能执行'), false);
    assert.equal(fs.existsSync(path.join(f.client, 'tmp')), false);
  }
  f.run('rules-weekly-audit.js', []);
  assert.equal(fs.existsSync(path.join(f.client, 'tmp/rules-audit/history.log')), true);
}));

test('memory merge guidance retains deletion conflicts and rejects size-based winners', () => {
  const text = fs.readFileSync(path.join(source, 'skills/memory-bank-divergence-repair/SKILL.md'), 'utf8');
  for (const required of ['共同基线', '主动删除', '删除/修改冲突', '无基线', 'mtime']) assert.ok(text.includes(required));
  assert.equal(text.includes('直接 `cp` 超集'), false);
  const slim = fs.readFileSync(path.join(source, 'skills/injected-context-slimming/SKILL.md'), 'utf8');
  assert.ok(slim.includes('许可反转') && slim.includes('删除反例'));
  assert.equal(slim.includes('截首句 + 字数上限'), false);
});

function runMcp(f) {
  const stub = path.join(f.base, 'no-processes.cjs');
  fs.writeFileSync(stub, "require('child_process').spawnSync=()=>{throw new Error('Unexpected subprocess');};require('https').get=()=>{throw new Error('Unexpected network');};");
  return spawnSync(process.execPath, ['--require', stub, path.join(source, 'mcp/install-mcp.cjs'), '--config-dir', f.client, '--yes', '--skip-cua', '--skip-dbhub'], {
    env: f.env, encoding: 'utf8', timeout: 15000,
  });
}

for (const value of ['{"mcpServers":', 'null', '[]', '{"mcpServers":[]}']) {
  test('invalid MCP configuration stays unchanged: ' + value, () => fixture(f => {
    fs.mkdirSync(f.client, { recursive: true });
    const file = path.join(f.client, 'settings.json');
    fs.writeFileSync(file, value);
    const r = runMcp(f);
    assert.notEqual(r.status, null, r.stderr);
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(fs.readFileSync(file, 'utf8'), value);
    assert.equal(fs.existsSync(path.join(f.client, '.backups')), false);
  }));
}

test('valid MCP configuration preserves unrelated values', () => fixture(f => {
  fs.mkdirSync(f.client, { recursive: true });
  const existing = { unknown: { keep: true }, mcpServers: { custom: { command: 'fixture', args: [] } } };
  fs.writeFileSync(path.join(f.client, 'settings.json'), JSON.stringify(existing));
  const r = runMcp(f);
  assert.equal(r.status, 0, r.stderr);
  const actual = JSON.parse(fs.readFileSync(path.join(f.client, 'settings.json'), 'utf8'));
  assert.deepEqual(actual.unknown, existing.unknown);
  assert.deepEqual(actual.mcpServers.custom, existing.mcpServers.custom);
  assert.equal(actual.mcpServers.context7.type, 'http');
}));

for (const side of ['.qoder', '.qoder-cn']) {
  for (const invalid of [false, true]) {
    test('single-client doctor preserves topology: ' + side + ' invalid=' + invalid, () => fixture(f => {
      delete f.env.QODER_HOME;
      const skill = path.join(f.home, side, 'skills', 'audit-fixture');
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: audit-fixture\ndescription: ' + (invalid ? 'x'.repeat(301) : 'fixture') + '\n---\nFixture.\n');
      const r = f.run('skills-doctor.cjs', []);
      assert.equal(r.status, invalid ? 1 : 0, r.stdout + r.stderr);
      assert.equal(fs.existsSync(path.join(f.home, side === '.qoder' ? '.qoder-cn' : '.qoder')), false);
    }));
  }
}

for (const name of ['byok-model-retry', 'dsh-session-format-debug', 'redis-observability', 'setup-windows-selfhosted-runner']) {
  test('quoted skill description is a valid scalar: ' + name, () => {
    const text = fs.readFileSync(path.join(source, 'skills', name, 'SKILL.md'), 'utf8');
    const value = text.match(/^description: (.+)$/m)?.[1];
    assert.ok(value && value.startsWith('"'));
    assert.equal(typeof JSON.parse(value), 'string');
  });
}

const guidanceSection = (start, end) => {
  const text = fs.readFileSync(path.join(source, 'Qoder-AI编码通用规则.md'), 'utf8');
  const from = text.indexOf(start), to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return text.slice(from, to);
};
test('desktop maintenance stays inside approved scope', () => {
  const text = guidanceSection('### 桌面自动化', '### 数据库');
  assert.ok(text.includes('升级限于已获批准的维护任务'));
  assert.equal(text.includes('发现新版即升级'), false);
  assert.ok(text.includes('不能证明归属时停止该动作'));
  assert.equal(text.includes('否则用 `taskkill /PID`'), false);
});
test('documentation collaboration preserves a single writer', () => {
  const text = guidanceSection('### 文档体系', '### 外部 jar');
  assert.ok(text.includes('主会话串行落盘'));
  assert.equal(text.includes('多写手并行'), false);
  assert.equal(text.includes('多代理并行写长文'), false);
});

test('standalone session-start guard installation contains its sync resources', () => fixture(f => {
  const r = f.run('pkg-catalog.cjs', ['install', 'script:global-config-guard.js', '--catalog', path.join(source, 'catalog.json'), '--apply']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const file of ['sync-global-config.sh', 'sync-memory.sh']) {
    const installed = path.join(f.client, 'scripts', file);
    assert.ok(fs.existsSync(installed), file);
    assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(path.join(source, 'scripts', file)));
  }
  fs.mkdirSync(path.join(f.client, 'memory'));
  const invoked = spawnSync(process.execPath, [path.join(f.client, 'scripts/global-config-guard.js')], {
    env: f.env, input: '{}', encoding: 'utf8', timeout: 20000,
  });
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(invoked.stdout.trim(), '', invoked.stdout);
  assert.equal(fs.existsSync(path.join(f.home, '.qoder-cn')), false);
}));

for (const options of [
  ['--skip-cua', '--skip-dbhub'],
  ['--cua', 'skip', '--dbhub', 'skip'],
  ['--cua', 'register', '--dbhub', 'skip', '--dry-run'],
  ['--cua', 'offline', '--dbhub', 'skip', '--dry-run'],
  ['--cua', 'skip', '--dbhub', 'online', '--dry-run'],
]) {
  test('MCP skipped or previewed components never execute: ' + options.join(' '), () => fixture(f => {
    fs.mkdirSync(f.client, { recursive: true });
    const settings = path.join(f.client, 'settings.json');
    const before = '{"preserved":true}';
    fs.writeFileSync(settings, before);
    const install = path.join(f.base, 'driver');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, 'cua-driver.exe'), 'never execute this fixture');
    const stub = path.join(f.base, 'forbid-execution.cjs');
    fs.writeFileSync(stub, "require('child_process').spawnSync=()=>{throw new Error('Unexpected subprocess');};require('https').get=()=>{throw new Error('Unexpected network');};");
    const r = spawnSync(process.execPath, ['--require', stub, path.join(source, 'mcp/install-mcp.cjs'), '--yes', '--config-dir', f.client, '--install-dir', install, ...options], { env: f.env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    if (options.includes('--dry-run')) {
      assert.equal(fs.readFileSync(settings, 'utf8'), before);
      assert.equal(fs.existsSync(path.join(f.client, '.backups')), false);
    } else assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).preserved, true);
  }));
}

for (const options of [['--cua', 'unknown'], ['--dbhub', 'unknown'], ['--config-dir'], ['--not-a-real-option']]) {
  test('MCP invalid options stop before effects: ' + options.join(' '), () => fixture(f => {
    const stub = path.join(f.base, 'no-effects.cjs');
    fs.writeFileSync(stub, "require('child_process').spawnSync=()=>{throw new Error('Unexpected subprocess');};require('https').get=()=>{throw new Error('Unexpected network');};");
    const r = spawnSync(process.execPath, ['--require', stub, path.join(source, 'mcp/install-mcp.cjs'), '--yes', ...options], { env: f.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.ok(r.stderr.includes('无效参数'));
    assert.equal(fs.existsSync(f.client), false);
  }));
}

for (const dry of [false, true]) for (const archiveState of ['missing', 'no-checksum', 'corrupt', 'valid']) {
  test('explicit dbhub tgz is verified without a shell: ' + archiveState + ' dry=' + dry, () => fixture(f => {
    const kit = path.join(f.base, 'kit & space');
    const offline = path.join(kit, 'offline');
    fs.mkdirSync(offline, { recursive: true });
    fs.copyFileSync(path.join(source, 'mcp/install-mcp.cjs'), path.join(kit, 'install-mcp.cjs'));
    fs.mkdirSync(f.client, { recursive: true });
    const settings = path.join(f.client, 'settings.json');
    const before = '{"preserved":true}';
    fs.writeFileSync(settings, before);
    const archive = path.join(offline, 'bytebase-dbhub-1.2.5.tgz');
    const bytes = Buffer.from('fixture archive, never executed');
    if (archiveState !== 'missing') fs.writeFileSync(archive, bytes);
    if (['valid', 'corrupt'].includes(archiveState)) {
      const digest = archiveState === 'valid' ? require('crypto').createHash('sha256').update(bytes).digest('hex') : '0'.repeat(64);
      fs.writeFileSync(path.join(offline, 'SHA256SUMS'), digest + '  ' + path.basename(archive) + '\n');
    }
    const calls = path.join(f.base, 'npm-calls.jsonl');
    const globalRoot = path.join(f.base, 'global modules');
    const stub = path.join(f.base, 'npm-stub.cjs');
    fs.writeFileSync(stub, [
      "const fs=require('fs'),path=require('path');",
      "require('https').get=()=>{throw new Error('Network forbidden');};",
      "require('child_process').spawnSync=(file,args,opts)=>{",
      "const normalized=args[0]&&args[0].endsWith('npm-cli.js')?args.slice(1):args;",
      "fs.appendFileSync(process.env.AUDIT_CALLS,JSON.stringify({file,args,shell:Boolean(opts&&opts.shell)})+'\\n');",
      "if(normalized.join(' ')==='root -g')return {status:0,stdout:process.env.AUDIT_NPM_ROOT,stderr:''};",
      "if(normalized[0]==='install'){const e=path.join(process.env.AUDIT_NPM_ROOT,'@bytebase/dbhub/dist/index.js');fs.mkdirSync(path.dirname(e),{recursive:true});fs.writeFileSync(e,'');return {status:0,stdout:'',stderr:''};}",
      "throw new Error('Unexpected command');};",
    ].join('\n'));
    const r = spawnSync(process.execPath, ['--require', stub, path.join(kit, 'install-mcp.cjs'), '--yes', '--skip-cua', '--dbhub', 'tgz', '--config-dir', f.client, ...(dry ? ['--dry-run'] : [])], { env: { ...f.env, AUDIT_CALLS: calls, AUDIT_NPM_ROOT: globalRoot }, encoding: 'utf8', timeout: 15000 });
    const recorded = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const installs = recorded.filter(c => c.args.includes('install'));
    if (dry) {
      assert.equal(recorded.length, 0);
      assert.equal(fs.readFileSync(settings, 'utf8'), before);
      assert.equal(r.status, archiveState === 'valid' ? 0 : 1, r.stdout + r.stderr);
    } else if (archiveState === 'valid') {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(installs.length, 1);
      assert.equal(installs[0].file, process.execPath);
      assert.equal(installs[0].shell, false);
      assert.ok(installs[0].args[0].endsWith('npm-cli.js'));
      assert.ok(installs[0].args.includes(archive));
    } else {
      assert.notEqual(r.status, null);
      assert.notEqual(r.status, 0, r.stdout);
      assert.equal(installs.length, 0);
      assert.equal(fs.readFileSync(settings, 'utf8'), before);
    }
  }));
}

for (const installState of ['failed', 'missing-entry', 'directory-entry', 'valid']) {
  test('dbhub registers only a successful installation with a file entry: ' + installState, () => fixture(f => {
    fs.mkdirSync(f.client, { recursive: true });
    const settings = path.join(f.client, 'settings.json');
    const before = '{"preserved":true}';
    fs.writeFileSync(settings, before);
    const globalRoot = path.join(f.base, 'global modules');
    const entry = path.join(globalRoot, '@bytebase/dbhub/dist/index.js');
    const stub = path.join(f.base, 'npm-outcome.cjs');
    fs.writeFileSync(stub, [
      "const fs=require('fs'),path=require('path');",
      "require('https').get=()=>{throw new Error('Network forbidden');};",
      "require('child_process').spawnSync=(file,args,opts)=>{",
      "if(file!==process.execPath||!args[0].endsWith('npm-cli.js')||opts.shell)throw new Error('Unexpected command');",
      "if(args.slice(1).join(' ')==='root -g')return {status:0,stdout:process.env.AUDIT_NPM_ROOT};",
      "if(args[1]!=='install')throw new Error('Unexpected npm arguments');",
      "const state=process.env.AUDIT_INSTALL_STATE,e=path.join(process.env.AUDIT_NPM_ROOT,'@bytebase/dbhub/dist/index.js');",
      "if(state==='valid'){fs.mkdirSync(path.dirname(e),{recursive:true});fs.writeFileSync(e,'fixture');}",
      "if(state==='directory-entry')fs.mkdirSync(e,{recursive:true});",
      "return {status:state==='failed'?1:0,stdout:'',stderr:''};};",
    ].join('\n'));
    const r = spawnSync(process.execPath, ['--require', stub, path.join(source, 'mcp/install-mcp.cjs'), '--yes', '--skip-cua', '--dbhub', 'online', '--config-dir', f.client], {
      env: { ...f.env, AUDIT_NPM_ROOT: globalRoot, AUDIT_INSTALL_STATE: installState }, encoding: 'utf8', timeout: 15000,
    });
    if (installState === 'valid') {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const config = JSON.parse(fs.readFileSync(settings, 'utf8'));
      assert.equal(config.preserved, true);
      assert.deepEqual(config.mcpServers.dbhub.args, [entry, '--transport', 'stdio', '--config=' + path.join(f.client, 'dbhub.toml')]);
      assert.ok(fs.existsSync(path.join(f.client, 'dbhub.toml')));
    } else {
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(fs.readFileSync(settings, 'utf8'), before);
      assert.equal(fs.existsSync(path.join(f.client, 'dbhub.toml')), false);
      assert.equal(fs.existsSync(path.join(f.client, '.backups')), false);
    }
  }));
}

for (const side of ['.qoder', '.qoder-cn']) {
  test('crash guard self-test uses bundled code and an isolated log: ' + side, () => fixture(f => {
    const installed = path.join(f.home, side, 'scripts');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'hook-crash-guard.js'), "throw new Error('Installed guard must not be loaded by self-test');");
    const existingLog = path.join(installed, 'hooks-crash.log');
    const externalLog = path.join(f.base, 'external-crash.log');
    fs.writeFileSync(existingLog, 'existing client log\n');
    fs.writeFileSync(externalLog, 'existing external log\n');
    const beforeEntries = fs.readdirSync(f.base).sort();
    f.env.HOOK_CRASH_LOG = externalLog;
    const r = f.run('hook-crash-guard.test.js', []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /6 通过 \/ 0 失败/);
    assert.equal(fs.readFileSync(existingLog, 'utf8'), 'existing client log\n');
    assert.equal(fs.readFileSync(externalLog, 'utf8'), 'existing external log\n');
    assert.deepEqual(fs.readdirSync(f.base).sort(), beforeEntries);
    assert.equal(fs.existsSync(path.join(f.home, side === '.qoder' ? '.qoder-cn' : '.qoder')), false);
  }));
}

function authFixture(body) {
  return fixture(f => {
    const state = path.join(f.base, 'auth-state');
    const risky = path.join(f.base, 'risky-state');
    fs.mkdirSync(risky);
    fs.writeFileSync(path.join(risky, 'memory-first.json'), JSON.stringify({ 'audit-auth': { memSeen: true, warned: {} } }));
    Object.assign(f.env, { AUTH_LOCK_STATE_DIR: state, AUTH_LOCK_CONFIG: path.join(f.base, 'auth-config.json'), RISKY_MATCH_STATE_DIR: risky, ATTEMPT_LOCK_STATE_DIR: path.join(f.base, 'attempt-state'), HOOK_CRASH_LOG: path.join(f.base, 'unexpected-crash.log') });
    const invoke = (event, call, response) => {
      const payload = { hook_event_name: event, session_id: 'audit-auth', ...call };
      if (event === 'PostToolUse') payload.tool_response = response;
      const r = spawnSync(process.execPath, [path.join(source, 'scripts', event === 'PreToolUse' ? 'risky-match-guard.js' : 'auth-lock-guard.js')], { env: f.env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(fs.existsSync(f.env.HOOK_CRASH_LOG), false, r.stderr);
      const result = JSON.parse(r.stdout || '{}');
      return result.decision === 'block' && /^\[auth-lock\]/.test(result.reason || '');
    };
    const read = () => JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
    const write = value => { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify(value)); };
    const mcp = srv => ({ tool_name: 'mcp_call', tool_input: { toolName: 'mcp__dbhub__execute_sql_' + srv, arguments: { sql: 'SELECT 1' } } });
    const shell = command => ({ tool_name: 'Bash', tool_input: { command } });
    const cli = args => spawnSync(process.execPath, [path.join(source, 'scripts/auth-lock-guard.js'), ...args], { env: f.env, encoding: 'utf8', timeout: 15000 });
    body({ ...f, read, write, mcp, shell, cli, post: (call, response) => invoke('PostToolUse', call, response), pre: call => invoke('PreToolUse', call), error: 'FATAL: password authentication failed for user "auth_probe"' });
  });
}

test('authentication failure count survives MCP to shell to MCP', () => authFixture(f => {
  const command = f.shell('psql -h 203.0.113.20 -U auth_probe -c "select 1"');
  assert.equal(f.post(f.mcp('audit_a'), f.error), false);
  assert.equal(f.post(command, f.error), false);
  assert.equal(f.post(f.mcp('audit_a'), f.error), true);
  assert.equal(f.pre(f.mcp('audit_a')), true);
  assert.equal(f.pre(command), true);
}));

test('authentication failures retain service aliases learned from responses', () => authFixture(f => {
  f.post(f.mcp('audit_a'), f.error);
  f.post(f.mcp('audit_b'), f.error);
  assert.equal(f.post(f.mcp('audit_c'), f.error), true);
  for (const srv of ['audit_a', 'audit_b', 'audit_c']) assert.equal(f.pre(f.mcp(srv)), true, srv);
  assert.equal(f.pre(f.mcp('unrelated')), false);
}));

for (const response of [{ error: 'connection timed out' }, '{"error":"ETIMEDOUT"}', { error: 'unknown transport failure' }, null, '']) {
  test('non-authentication response does not reset failures: ' + JSON.stringify(response), () => authFixture(f => {
    f.post(f.mcp('audit_a'), f.error);
    f.post(f.mcp('audit_a'), f.error);
    assert.equal(f.post(f.mcp('audit_a'), response), false);
    assert.equal(f.post(f.mcp('audit_a'), f.error), true);
  }));
}

for (const locked of [false, true]) {
  test('blocked authentication state does not expire automatically: locked=' + locked, () => authFixture(f => {
    const call = f.mcp('audit_a');
    if (locked) f.post(call, 'ORA-28000: account is locked');
    else for (let i = 0; i < 3; i++) f.post(call, f.error);
    const state = f.read();
    for (const entry of Object.values(state.entries)) entry.at = Date.now() - 48 * 3600 * 1000;
    f.write(state);
    assert.equal(f.pre(call), true);
  }));
}

for (const command of [
  "echo 'psql -h 203.0.113.20 -U auth_probe'",
  'echo psql -h 203.0.113.20 -U auth_probe',
  "printf '%s' 'psql -h 203.0.113.20 -U auth_probe'",
  "cat <<'EOF'\npsql -h 203.0.113.20 -U auth_probe\nEOF",
  '# psql -h 203.0.113.20 -U auth_probe\nprintf done',
]) {
  test('authentication guard ignores quoted or documented commands: ' + command, () => authFixture(f => {
    for (let i = 0; i < 3; i++) f.post(f.mcp('audit_a'), f.error);
    assert.equal(f.pre(f.shell(command)), false);
  }));
}

test('authentication guard checks later commands and quoted executable paths', () => authFixture(f => {
  for (let i = 0; i < 3; i++) f.post(f.mcp('audit_a'), f.error);
  for (const command of [
    'psql -h 203.0.113.21 -U unrelated -c "select 1"; psql -h 203.0.113.20 -U auth_probe -c "select 1"',
    '"C:/Program Files/PostgreSQL/bin/psql.exe" -h "203.0.113.20" -U "auth_probe" -c "select 1"',
    "printf done; bash -c 'psql -h 203.0.113.20 -U auth_probe -c \"select 1\"'",
    'printf "%s" "$(psql -h 203.0.113.20 -U auth_probe -c \'select 1\')"',
    "bash <<'EOF'\npsql -h 203.0.113.20 -U auth_probe -c 'select 1'\nEOF",
  ]) assert.equal(f.pre(f.shell(command)), true, command);
}));

test('legacy authentication state retains the service identity in its key', () => authFixture(f => {
  f.write({ entries: { 'audit_a/-/-': { dims: { host: '203.0.113.20', user: 'auth_probe' }, count: 3, blocked: true, at: Date.now() } } });
  assert.equal(f.pre(f.mcp('audit_a')), true);
}));

test('authenticated row data is not an authentication error signature', () => authFixture(f => {
  for (const response of [{ rows: [{ message: f.error }] }, { content: [{ type: 'text', text: JSON.stringify({ rows: [{ message: f.error }] }) }] }]) {
    f.post(f.mcp('audit_a'), f.error);
    f.post(f.mcp('audit_a'), f.error);
    assert.equal(f.post(f.mcp('audit_a'), response), false);
    assert.deepEqual(f.read().entries, {});
  }
}));

test('authentication state does not retain password text from tool errors', () => authFixture(f => {
  f.post(f.mcp('audit_a'), f.error + ' password="private-fixture-value"');
  assert.equal(JSON.stringify(f.read()).includes('private-fixture-value'), false);
  f.post(f.mcp('audit_a'), 'authentication failed: postgresql://auth_probe:fixture-password@203.0.113.20/db');
  assert.equal(JSON.stringify(f.read()).includes('fixture-password'), false);
}));

for (const args of [['--clear'], ['--clear', '--force']]) {
  test('authentication clear requires an explicit target: ' + args.join(' '), () => authFixture(f => {
    f.post(f.mcp('audit_a'), 'ORA-28000: account is locked');
    const before = f.read();
    assert.equal(f.cli(args).status, 2);
    assert.deepEqual(f.read(), before);
  }));
}

test('authentication clear removes only an exact key or explicit ALL', () => authFixture(f => {
  f.post(f.mcp('audit_a'), f.error);
  f.post(f.mcp('audit_b'), 'password authentication failed for user "other_probe"');
  const before = f.read();
  assert.equal(f.cli(['--clear', '/user/']).status, 0);
  assert.deepEqual(f.read(), before);
  const key = Object.keys(before.entries)[0];
  assert.equal(f.cli(['--clear', key]).status, 0);
  assert.equal(Object.keys(f.read().entries).length, 1);
  assert.equal(f.cli(['--clear', 'ALL']).status, 0);
  assert.deepEqual(f.read().entries, {});
}));

for (const username of ['x', '123user', 'probe@example.test']) {
  test('authentication identity preserves complete quoted usernames: ' + username, () => authFixture(f => {
    const error = 'password authentication failed for user "' + username + '"';
    f.post(f.mcp('audit_a'), error);
    f.post(f.shell('psql -h 203.0.113.20 -U "' + username + '" -c "select 1"'), error);
    assert.equal(f.post(f.mcp('audit_a'), error), true);
  }));
}

test('email-shaped usernames do not create a shared host identity', () => authFixture(f => {
  f.post(f.mcp('audit_a'), 'password authentication failed for user "probe@example.test"');
  f.post(f.mcp('audit_b'), 'password authentication failed for user "other@example.test"');
  assert.equal(Object.keys(f.read().entries).length, 2);
}));

test('SQL text is not an authentication target identity', () => authFixture(f => {
  for (let i = 0; i < 3; i++) f.post(f.mcp('audit_a'), f.error);
  const call = f.mcp('unrelated');
  call.tool_input.arguments.sql = "SELECT 'for user auth_probe'";
  assert.equal(f.pre(call), false);
}));

for (const config of [null, { threshold: 99 }, { disabled: 'false' }, { dims: ['unsupported'] }]) {
  test('authentication configuration cannot disable the three-failure limit accidentally: ' + JSON.stringify(config), () => authFixture(f => {
    fs.writeFileSync(f.env.AUTH_LOCK_CONFIG, JSON.stringify(config));
    f.post(f.mcp('audit_a'), f.error);
    f.post(f.mcp('audit_a'), f.error);
    assert.equal(f.post(f.mcp('audit_a'), f.error), true);
  }));
}

test('memory update guidance requires explicit authorization before backups', () => {
  const text = fs.readFileSync(path.join(source, 'skills/memory-entry-update/SKILL.md'), 'utf8');
  const gate = text.indexOf('用户明确要求新增、更新或删除');
  assert.ok(gate >= 0 && gate < text.indexOf('**备份两个载体**'));
  assert.ok(text.includes('只读审阅不备份、不编辑'));
  assert.ok(text.includes('无关告警不作为本次更新的完成前置'));
  assert.equal(text.includes('才新增或删除；普通重试'), false);
});

test('inbound package guidance preserves review and package-only scope', () => {
  const text = fs.readFileSync(path.join(source, 'skills/merge-inbound-qoder-package/SKILL.md'), 'utf8');
  const gate = text.indexOf('只读审阅不解压落盘、不备份、不写入');
  assert.ok(gate >= 0 && gate < text.indexOf('把包解压'));
  assert.ok(text.includes('只改包内时，落点仅为获准仓库或包目录'));
  assert.ok(text.includes('不能自动扩展为本机现役配置'));
  assert.ok(text.includes('不自动提交、推送、安装或发布'));
});

test('scoped guidance is searchable after isolated installation without query writes', () => fixture(f => {
  for (const name of ['memory-entry-update', 'merge-inbound-qoder-package']) {
    const r = f.run('pkg-catalog.cjs', ['install', 'skill:' + name, '--catalog', path.join(source, 'catalog.json'), '--apply']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const installed = path.join(f.client, 'skills-library', name, 'SKILL.md');
    assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(path.join(source, 'skills', name, 'SKILL.md')));
  }
  const built = f.run('build-skills-index.cjs', []);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const index = path.join(f.client, 'skills-index.json');
  const before = fs.readFileSync(index);
  for (const [query, name] of [['更新记忆', 'memory-entry-update'], ['只改包内', 'merge-inbound-qoder-package']]) {
    const r = f.run('skill-load.cjs', [query]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(name), r.stdout);
  }
  assert.equal(f.run('skill-load.cjs', ['zqxvforbiddenlookup']).status, 3);
  assert.deepEqual(fs.readFileSync(index), before);
  assert.equal(fs.existsSync(path.join(f.home, '.qoder-cn')), false);
}));

for (const shape of ['object', 'json-string', 'mcp-text']) {
  test('structured authentication errors retain the actual username: ' + shape, () => authFixture(f => {
    const response = shape === 'object' ? { error: f.error } : shape === 'json-string' ? JSON.stringify({ error: f.error }) : { isError: true, content: [{ type: 'text', text: f.error }] };
    for (let i = 0; i < 3; i++) f.post(f.mcp('audit_a'), response);
    assert.equal(f.pre(f.shell('psql -h 203.0.113.20 -U auth_probe -c "select 1"')), true);
    assert.ok(Object.values(f.read().entries).some(entry => entry.dims.user === 'auth_probe'));
  }));
}

for (const prefix of ['env bash', 'env AUDIT_MODE=1 bash', 'command bash']) {
  test('authentication guard recognizes wrapped shell heredocs: ' + prefix, () => authFixture(f => {
    for (let i = 0; i < 3; i++) f.post(f.mcp('audit_a'), f.error);
    assert.equal(f.pre(f.shell(prefix + " <<'EOF'\npsql -h 203.0.113.20 -U auth_probe -c 'select 1'\nEOF")), true);
  }));
}

test('psql result value 1045 is data rather than an authentication error', () => authFixture(f => {
  const call = f.shell('psql -h 203.0.113.20 -U auth_probe -c "select 1045"');
  f.post(call, f.error);
  f.post(call, f.error);
  assert.equal(f.post(call, ' value\n-------\n  1045\n(1 row)\n'), false);
  assert.deepEqual(f.read().entries, {});
}));

test('bare numeric output does not imply either authentication failure or success', () => authFixture(f => {
  const call = f.shell('psql -h 203.0.113.20 -U auth_probe -c "select 1045"');
  f.post(call, f.error);
  f.post(call, f.error);
  assert.equal(f.post(call, '1045'), false);
  assert.equal(f.post(call, f.error), true);
}));

test('explicit MySQL error 1045 still reaches the authentication threshold', () => authFixture(f => {
  const call = f.shell('mysql -h 203.0.113.20 -u auth_probe -e "select 1"');
  f.post(call, 'ERROR 1045 (28000)');
  f.post(call, 'ERROR 1045 (28000)');
  assert.equal(f.post(call, 'ERROR 1045 (28000)'), true);
}));

test('mixed result rows and authentication errors do not clear failures', () => authFixture(f => {
  f.post(f.mcp('audit_a'), f.error);
  f.post(f.mcp('audit_a'), f.error);
  const response = { content: [{ type: 'text', text: '{"rows":[{"n":1}]}' }, { type: 'text', text: f.error }] };
  assert.equal(f.post(f.mcp('audit_a'), response), true);
}));

for (const scenario of ['missing-archive', 'corrupt-archive', 'register-missing', 'failed-version', 'unknown-version', 'mismatched-version', 'missing-entry', 'nonempty-destination', 'missing-directory', 'system-directory-preview', 'unsupported-platform', 'online-failure', 'valid']) {
  test('Cua installation preserves boundaries: ' + scenario, () => fixture(f => {
    const kit = path.join(f.base, "cua kit & 'quote'");
    const offline = path.join(kit, 'offline');
    fs.mkdirSync(offline, { recursive: true });
    fs.copyFileSync(path.join(source, 'mcp/install-mcp.cjs'), path.join(kit, 'install-mcp.cjs'));
    fs.mkdirSync(f.client, { recursive: true });
    const settings = path.join(f.client, 'settings.json');
    const before = '{"preserved":true}';
    fs.writeFileSync(settings, before);
    const install = path.join(f.base, 'driver');
    const entry = path.join(install, 'cua-driver.exe');
    const zipName = 'cua-driver-rs-0.38.0-windows-x86_64.zip';
    const bytes = Buffer.from('fixture zip; extraction is simulated');
    if (scenario !== 'missing-archive') {
      fs.writeFileSync(path.join(offline, zipName), bytes);
      const digest = scenario === 'corrupt-archive' ? '0'.repeat(64) : require('crypto').createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(path.join(offline, 'SHA256SUMS'), digest + '  ' + zipName + '\n');
    }
    if (['failed-version', 'unknown-version', 'nonempty-destination'].includes(scenario)) {
      fs.mkdirSync(install);
      fs.writeFileSync(scenario === 'nonempty-destination' ? path.join(install, 'keep.txt') : entry, 'existing fixture');
    }
    const stub = path.join(f.base, 'cua-stub.cjs');
    const calls = path.join(f.base, 'cua-calls.jsonl');
    fs.writeFileSync(stub, [
      "const fs=require('fs'),path=require('path');",
      "const scenario=process.env.AUDIT_CUA_SCENARIO;",
      "Object.defineProperty(process,'platform',{value:scenario==='unsupported-platform'?'linux':'win32'});Object.defineProperty(process,'arch',{value:'x64'});",
      "const record=o=>fs.appendFileSync(process.env.AUDIT_CUA_CALLS,JSON.stringify(o)+'\\n');",
      "require('https').get=()=>{record({kind:'network'});throw new Error('Fixture network failure');};",
      "const extract=dest=>{const inner=path.join(dest,'cua-driver-rs-0.38.0-windows-x86_64');fs.mkdirSync(inner,{recursive:true});fs.writeFileSync(path.join(inner,'LICENSE'),'fixture');if(scenario!=='missing-entry')fs.writeFileSync(path.join(inner,'cua-driver.exe'),'fixture executable');};",
      "require('child_process').spawnSync=(file,args,opts={})=>{",
      "record({file,args,timeout:opts.timeout});",
      "if(path.basename(file)==='cua-driver.exe')return {status:scenario==='failed-version'?1:0,stdout:scenario==='unknown-version'?'not a version':'cua-driver '+(scenario==='mismatched-version'?'0.37.0':'0.38.0'),stderr:''};",
      "if(file==='tar'){extract(args[args.indexOf('-C')+1]);return {status:0,stdout:'',stderr:''};}",
      "if(/^powershell(?:\\.exe)?$/i.test(path.basename(file))){const text=args.at(-1);const m=text.match(/ExtractToDirectory\\('(?:[^']|'')*',\\s*'((?:[^']|'')*)'\\)/)||text.match(/-DestinationPath '((?:[^']|'')*)'/);if(!m)throw new Error('Unexpected archive command');extract(m[1].replace(/''/g,\"'\"));return {status:0,stdout:'',stderr:''};}",
      "throw new Error('Unexpected subprocess');};",
    ].join('\n'));
    const mode = ['register-missing', 'failed-version', 'unknown-version'].includes(scenario) ? 'register' : scenario === 'online-failure' ? 'online' : 'offline';
    const options = ['--yes', '--config-dir', f.client, '--skip-dbhub', '--cua', mode];
    if (scenario !== 'missing-directory') options.push('--install-dir', scenario === 'system-directory-preview' ? 'C:/Qoder-Forbidden-' + path.basename(f.base) : install);
    if (scenario === 'system-directory-preview') options.push('--dry-run');
    const r = spawnSync(process.execPath, ['--require', stub, path.join(kit, 'install-mcp.cjs'), ...options], { env: { ...f.env, SystemDrive: 'C:', AUDIT_CUA_SCENARIO: scenario, AUDIT_CUA_CALLS: calls }, encoding: 'utf8', timeout: 15000 });
    const recorded = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    if (scenario === 'valid') {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(fs.readFileSync(entry, 'utf8'), 'fixture executable');
      assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).mcpServers['cua-computer-use'].command, entry);
      const probes = recorded.filter(call => call.file && path.basename(call.file) === 'cua-driver.exe');
      assert.ok(probes.length > 0 && probes.every(call => call.timeout > 0), 'Version probes need finite timeouts');
      assert.equal(fs.readdirSync(f.base, { withFileTypes: true }).some(item => item.isDirectory() && /^\.?cua-/.test(item.name)), false);
    } else {
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(fs.readFileSync(settings, 'utf8'), before);
      assert.equal(fs.existsSync(path.join(f.client, '.backups')), false);
      if (['unsupported-platform', 'system-directory-preview', 'missing-directory'].includes(scenario)) assert.equal(recorded.length, 0);
      if (scenario === 'nonempty-destination') assert.deepEqual(fs.readdirSync(install), ['keep.txt']);
      if (['missing-entry', 'mismatched-version'].includes(scenario)) assert.equal(fs.existsSync(install), false);
    }
  }));
}

test('Cua preview reports platform limits without installing on unsupported hosts', () => fixture(f => {
  fs.mkdirSync(f.client, { recursive: true });
  const settings = path.join(f.client, 'settings.json');
  const before = '{"preserved":true}';
  fs.writeFileSync(settings, before);
  const install = path.join(f.base, 'driver');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'cua-driver.exe'), 'fixture');
  const stub = path.join(f.base, 'nonwindows.cjs');
  fs.writeFileSync(stub, "Object.defineProperty(process,'platform',{value:'linux'});Object.defineProperty(process,'arch',{value:'x64'});require('child_process').spawnSync=()=>{throw new Error('Unexpected subprocess');};require('https').get=()=>{throw new Error('Network forbidden');};");
  const r = spawnSync(process.execPath, ['--require', stub, path.join(source, 'mcp/install-mcp.cjs'), '--yes', '--skip-dbhub', '--cua', 'offline', '--install-dir', install, '--dry-run'], { env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /不是 Windows x64/);
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.client, '.backups')), false);
}));

test('Cua installation still refuses unsupported hosts before effects', () => fixture(f => {
  fs.mkdirSync(f.client, { recursive: true });
  const settings = path.join(f.client, 'settings.json');
  const before = '{"preserved":true}';
  fs.writeFileSync(settings, before);
  const install = path.join(f.base, 'driver');
  fs.mkdirSync(install);
  const stub = path.join(f.base, 'nonwindows-apply.cjs');
  fs.writeFileSync(stub, "Object.defineProperty(process,'platform',{value:'linux'});Object.defineProperty(process,'arch',{value:'x64'});require('child_process').spawnSync=()=>{throw new Error('Unexpected subprocess');};require('https').get=()=>{throw new Error('Network forbidden');};");
  const r = spawnSync(process.execPath, ['--require', stub, path.join(source, 'mcp/install-mcp.cjs'), '--yes', '--skip-dbhub', '--cua', 'offline', '--install-dir', install], { env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /仅支持 Windows x64/);
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.client, '.backups')), false);
}));

const mechanizeScripts = path.join(source, 'skills/mechanize-rule-into-hook-guard/scripts');
const failStreakGuard = path.join(mechanizeScripts, 'fail-streak-guard.js');
const failStreakInstaller = require(path.join(mechanizeScripts, 'install-fail-streak.cjs'));

function failStreakEnv(f) {
  return { ...f.env, QODER_HOME: '', FAIL_STREAK_STATE_DIR: path.join(f.base, 'fs-state'), FAIL_STREAK_CONFIG: path.join(f.base, 'fs-config.json'), HOOK_CRASH_LOG: path.join(f.base, 'fs-crash.log') };
}

test('fail-streak treats non-object configuration as defaults', () => fixture(f => {
  fs.writeFileSync(path.join(f.base, 'fs-config.json'), 'null');
  const env = failStreakEnv(f);
  const r = spawnSync(process.execPath, [failStreakGuard], {
    env, input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'curl -sS http://198.51.100.77/x' }, tool_response: 'curl: (7) Failed to connect to 198.51.100.77 port 80: Connection refused' }),
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(env.FAIL_STREAK_STATE_DIR, 'decisions.log'), 'utf8'), /streak-new\|198\.51\.100\.77/);
  assert.equal(fs.existsSync(env.HOOK_CRASH_LOG), false);
}));

test('fail-streak blocked entries survive beyond the retry TTL', () => fixture(f => {
  const env = failStreakEnv(f), stateDir = env.FAIL_STREAK_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  const old = Date.now() - 48 * 3600 * 1000;
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ entries: { '198.51.100.77:-': { dims: { host: '198.51.100.77' }, means: { 'curl|x|': { at: old, count: 1 } }, at: old, blocked: true, samples: [] } } }));
  const r = spawnSync(process.execPath, [failStreakGuard, '--status'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).entries['198.51.100.77:-']);
}));

test('fail-streak clear requires an explicit target or ALL', () => fixture(f => {
  const env = failStreakEnv(f), stateDir = env.FAIL_STREAK_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ entries: { '198.51.100.77:-': { dims: { host: '198.51.100.77' }, means: {}, at: Date.now(), blocked: true } } }));
  const before = fs.readFileSync(file);
  for (const args of [['--clear'], ['--clear', '--force']]) {
    const r = spawnSync(process.execPath, [failStreakGuard, ...args], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.deepEqual(fs.readFileSync(file), before);
  }
  const r = spawnSync(process.execPath, [failStreakGuard, '--clear', 'ALL'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).cleared, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).entries, {});
}));

test('fail-streak chooses the existing CN client when installed side by side', () => fixture(f => {
  const home = path.join(f.base, 'cn-home'), scripts = path.join(home, '.qoder-cn', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['fail-streak-core.js', 'fail-streak-guard.js']) fs.copyFileSync(path.join(mechanizeScripts, name), path.join(scripts, name));
  fs.copyFileSync(path.join(source, 'scripts/hook-crash-guard.js'), path.join(scripts, 'hook-crash-guard.js'));
  fs.copyFileSync(path.join(source, 'scripts/client-root.js'), path.join(scripts, 'client-root.js'));
  const env = { ...f.env, HOME: home, USERPROFILE: home, QODER_HOME: '' };
  delete env.FAIL_STREAK_STATE_DIR;
  delete env.FAIL_STREAK_CONFIG;
  const r = spawnSync(process.execPath, [path.join(scripts, 'fail-streak-guard.js'), '--paths'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  const paths = JSON.parse(r.stdout);
  assert.ok(paths.STATE_DIR.toLowerCase().startsWith(path.join(home, '.qoder-cn').toLowerCase()), paths.STATE_DIR);
  assert.equal(fs.existsSync(path.join(home, '.qoder')), false);
}));

test('fail-streak installer rejects incomplete delegation markers', () => fixture(f => {
  const root = path.join(f.base, 'install-root');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const host = path.join(root, 'scripts', 'risky-match-guard.js');
  fs.writeFileSync(host, 'const x = 1;\n// <fail-streak-delegation>\n');
  assert.equal(failStreakInstaller.hostPlan(root).action, 'abort');
  fs.writeFileSync(host, "const x = 1;\n// <fail-streak-delegation>\ntry { const fst = require('./fail-streak-core.js').preCheck(input); } catch (e) {}\n// </fail-streak-delegation>\n");
  assert.equal(failStreakInstaller.hostPlan(root).action, 'skip');
}));

test('fail-streak installer validates existing entries and quotes paths', () => fixture(f => {
  const root = path.join(f.base, 'install-root 2');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const settings = path.join(root, 'settings.json');
  const opts = { node: 'C:/Program Files/nodejs/node.exe', matcher: '^Bash$|mcp_call', timeout: 10, backup: path.join(f.base, 'no-backup.js') };
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: '"C:/other/fail-streak-guard.js"', timeout: 5 }] }] } }));
  assert.equal(failStreakInstaller.settingsPlan(root, opts).action, 'abort');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [] } }));
  const plan = failStreakInstaller.settingsPlan(root, opts);
  assert.equal(plan.action, 'append');
  assert.ok(plan.command.startsWith('"C:/Program Files/nodejs/node.exe" "'), plan.command);
  fs.writeFileSync(settings, plan.after);
  assert.equal(failStreakInstaller.settingsPlan(root, opts).action, 'skip');
}));

test('fail-streak installer rejects a different executable, extra argv and non-command hooks', () => fixture(f => {
  const root = path.join(f.base, 'install-root exact command');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const settings = path.join(root, 'settings.json');
  const opts = { node: process.execPath, matcher: '^Bash$|mcp_call', timeout: 10 };
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [] } }));
  const next = JSON.parse(failStreakInstaller.settingsPlan(root, opts).after);
  const expected = next.hooks.PostToolUse[0].hooks[0];
  const wrongNode = path.join(f.base, 'missing node', 'node.exe').replace(/\\/g, '/');
  const variants = [
    { ...expected, command: expected.command.replace(/^"[^"]+"/, '"' + wrongNode + '"') },
    { ...expected, command: expected.command + ' --clear ALL' },
    { ...expected, command: 'echo ' + expected.command },
    { ...expected, command: expected.command + ' && echo ignored' },
    { ...expected, type: 'prompt' },
    { ...expected, type: undefined },
  ];
  for (const hook of variants) {
    next.hooks.PostToolUse[0].hooks[0] = hook;
    fs.writeFileSync(settings, JSON.stringify(next));
    const before = fs.readFileSync(settings);
    assert.equal(failStreakInstaller.settingsPlan(root, opts).action, 'abort', JSON.stringify(hook));
    assert.deepEqual(fs.readFileSync(settings), before);
  }
}));

test('fail-streak installer compares full command paths using platform semantics', () => fixture(f => {
  const root = path.join(f.base, 'install-root command paths');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const settings = path.join(root, 'settings.json');
  const opts = { node: process.execPath, matcher: '^Bash$|mcp_call', timeout: 10 };
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [] } }));
  const next = JSON.parse(failStreakInstaller.settingsPlan(root, opts).after);
  const hook = next.hooks.PostToolUse[0].hooks[0];
  if (process.platform === 'win32') hook.command = hook.command.toUpperCase().replace(/\//g, '\\');
  fs.writeFileSync(settings, JSON.stringify(next));
  assert.equal(failStreakInstaller.settingsPlan(root, opts).action, 'skip');
  if (process.platform !== 'win32') {
    hook.command = hook.command.toUpperCase();
    fs.writeFileSync(settings, JSON.stringify(next));
    assert.equal(failStreakInstaller.settingsPlan(root, opts).action, 'abort');
  }
}));

for (const args of [
  ['--apply', '--home'], ['--apply', '--second'], ['--apply', '--node'], ['--apply', '--matcher'],
  ['--apply', '--timeout'], ['--apply', '--backup'], ['--apply', '--home', '--selftest'],
  ['--apply', '--unknown'], ['--apply', 'unexpected'], ['--apply', '--timeout', '0'],
  ['--apply', '--timeout', '-1'], ['--apply', '--timeout', 'NaN'], ['--apply', '--timeout', 'Infinity'],
]) {
  test('fail-streak installer rejects invalid arguments before default-client writes: ' + args.join(' '), () => fixture(f => {
    const scripts = path.join(f.client, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(path.join(source, 'scripts/risky-match-guard.js'), path.join(scripts, 'risky-match-guard.js'));
    const settings = path.join(f.client, 'settings.json');
    fs.writeFileSync(settings, '{}\n');
    const before = fs.readFileSync(settings);
    const r = spawnSync(process.execPath, [path.join(mechanizeScripts, 'install-fail-streak.cjs'), ...args], { env: f.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /无效参数/);
    assert.deepEqual(fs.readFileSync(settings), before);
    assert.deepEqual(fs.readdirSync(scripts), ['risky-match-guard.js']);
  }));
}

test('fail-streak installer accepts explicit paths with spaces and positive fractional timeouts', () => fixture(f => {
  const root = path.join(f.base, 'selected client');
  const args = ['--home', root, '--node', process.execPath, '--backup', path.join(f.base, 'backup with spaces.js'), '--matcher', '^Bash$|mcp_call', '--timeout', '2.5'];
  const r = spawnSync(process.execPath, [path.join(mechanizeScripts, 'install-fail-streak.cjs'), ...args], { env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(root));
  assert.match(r.stdout, /timeout=2\.5/);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(f.client), false);
}));

test('fail-streak installer refuses unverified backup and stops after failure', () => fixture(f => {
  const root = path.join(f.base, 'install-root 3');
  fs.mkdirSync(root);
  const target = path.join(root, 'host.js');
  fs.writeFileSync(target, 'const old = 1;\n');
  const fake = path.join(f.base, 'fake-backup.cjs');
  fs.writeFileSync(fake, "console.log('[备份] ' + require('path').join(__dirname, 'missing.bak'));");
  const opts = { node: process.execPath, matcher: 'test', timeout: 10, backup: fake };
  const first = failStreakInstaller.applyPlan({ root, rows: [], aborts: [], writes: [{ target, action: 'overwrite', after: 'const fresh = 2;\n' }] }, opts);
  assert.equal(first.errors.length, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'const old = 1;\n');
  const second = path.join(root, 'second.txt');
  const stopped = failStreakInstaller.applyPlan({ root, rows: [], aborts: [], writes: [{ target: path.join(root, 'broken.js'), action: 'create', after: 'function {\n' }, { target: second, action: 'create', after: 'should-not-exist' }] }, { ...opts, backup: path.join(root, 'none.js') });
  assert.equal(stopped.errors.length, 1);
  assert.equal(fs.existsSync(second), false);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.fail-streak-tmp-')), false);
}));

test('disk-sweeper purge refuses a manifest copied outside its archive', () => fixture(f => {
  const archive = path.join(f.base, 'archive-copy');
  fs.mkdirSync(archive);
  const original = path.join(f.base, 'original-archive', 'payload.bin');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, 'payload');
  const target = path.join(f.base, 'restore-target.bin');
  fs.writeFileSync(path.join(archive, 'manifest.json'), JSON.stringify({ kind: 'qoder-disk-archive', schema: 1, moved: [{ from: target, to: original, bytes: 7 }] }));
  const r = f.run('disk-sweeper.js', ['--restore', path.join(archive, 'manifest.json'), '--purge']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(fs.existsSync(archive));
  assert.ok(fs.existsSync(original));
}));

test('disk-sweeper purge keeps the archive when any restore fails', () => fixture(f => {
  const archive = path.join(f.base, '2026-11-01T04-00-00');
  fs.mkdirSync(archive);
  const present = path.join(archive, 'a.bin');
  fs.writeFileSync(present, 'a');
  const missing = path.join(archive, 'missing.bin');
  const fromA = path.join(f.base, 'restored-a.bin'), fromB = path.join(f.base, 'restored-b.bin');
  fs.writeFileSync(path.join(archive, 'manifest.json'), JSON.stringify({ kind: 'qoder-disk-archive', schema: 1, moved: [{ from: fromA, to: present, bytes: 1 }, { from: fromB, to: missing, bytes: 1 }] }));
  const r = f.run('disk-sweeper.js', ['--restore', path.join(archive, 'manifest.json'), '--purge']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(fs.existsSync(archive));
  assert.ok(fs.existsSync(present));
  assert.ok(fs.existsSync(fromA));
  assert.equal(fs.existsSync(fromB), false);
}));

test('disk-sweeper purge still removes a coherent archive after full restore', () => fixture(f => {
  const archive = path.join(f.base, '2026-11-01T04-00-01');
  fs.mkdirSync(archive);
  const present = path.join(archive, 'a.bin');
  fs.writeFileSync(present, 'a');
  const restored = path.join(f.base, 'restored-final.bin');
  fs.writeFileSync(path.join(archive, 'manifest.json'), JSON.stringify({ kind: 'qoder-disk-archive', schema: 1, moved: [{ from: restored, to: present, bytes: 1 }] }));
  const r = f.run('disk-sweeper.js', ['--restore', path.join(archive, 'manifest.json'), '--purge']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(archive), false);
  assert.equal(fs.readFileSync(restored, 'utf8'), 'a');
}));

test('cua-wait does not overwrite the read-only $PID variable', () => {
  const text = fs.readFileSync(path.join(source, 'scripts/cua-wait.ps1'), 'utf8');
  assert.equal(/\$pid\s*=/.test(text), false);
  assert.ok(text.includes('$procId'));
});

test('migration undo covers every allowed drive and has no nonexistent option', () => {
  const text = fs.readFileSync(path.join(source, 'scripts/migrate-qoder-data.ps1'), 'utf8');
  assert.ok(text.includes("$allowedDrives = @('D', 'E', 'F', 'G', 'H', 'I')"));
  assert.ok(text.includes('foreach ($d in $allowedDrives)'));
  assert.equal(text.includes('-Cleanup'), false);
});

test('skill safety guidance keeps approval and TLS boundaries', () => {
  const elevated = fs.readFileSync(path.join(source, 'skills/windows-elevated-changes-from-git-bash/SKILL.md'), 'utf8');
  assert.equal(elevated.includes("Stop-Service -Name '<Service Name>' -Force"), false);
  assert.ok(elevated.includes('不得自动再弹 UAC'));
  assert.ok(elevated.includes('不要用 `-Force` 停服务'));
  const deliver = fs.readFileSync(path.join(source, 'skills/deliver-prd/SKILL.md'), 'utf8');
  assert.equal(deliver.includes('in which case append and echo'), false);
  assert.ok(deliver.includes('not a substitute'));
  const runner = fs.readFileSync(path.join(source, 'skills/setup-windows-selfhosted-runner/SKILL.md'), 'utf8');
  assert.equal(runner.includes('curl -k'), false);
  assert.equal(runner.includes('Stop-Process -Force'), false);
  assert.ok(runner.includes('不要用 `-k`'));
  const rabbit = fs.readFileSync(path.join(source, 'skills/rabbitmq-expert/SKILL.md'), 'utf8');
  assert.equal(rabbit.includes('while retries < 5'), false);
  assert.ok(rabbit.includes('ProbableAuthenticationError'));
  assert.ok(rabbit.includes('basic_consume'));
});

test('skill guidance avoids unsupported forensic and scope claims', () => {
  const read = (file) => fs.readFileSync(path.join(source, file), 'utf8');
  const migration = read('skills/disk-junction-migration/SKILL.md');
  assert.ok(migration.includes('仅在用户已授权本轮清理时'));
  const spinner = read('skills/electron-app-stuck-spinner-triage/SKILL.md');
  assert.equal(spinner.includes('方向全部作废'), false);
  assert.ok(spinner.includes('不能排除'));
  const asar = read('skills/electron-asar-code-forensics/SKILL.md');
  assert.equal(asar.includes('出厂二进制未被改动，缺陷不在'), false);
  assert.ok(asar.includes('不能单独证明出厂原版'));
  const shipped = read('skills/shipped-app-js-patch-hygiene/SKILL.md');
  assert.ok(shipped.includes('官方安装包/发布哈希'));
  assert.ok(shipped.includes('不能单凭它认定原版'));
  const pause = read('skills/pause-writer-before-shared-file-edit/SKILL.md');
  assert.ok(pause.includes('只恢复本轮由本技能亲自暂停'));
  assert.ok(pause.includes('不能单独证明改动归属'));
  const oracle = read('skills/oracledb/SKILL.md');
  assert.ok(oracle.includes('## Prerequisites'));
  assert.ok(oracle.includes('Never print passwords'));
  const dataviz = read('skills/python-dataviz/SKILL.md');
  assert.equal(dataviz.includes('FastAPI'), false);
  assert.ok(dataviz.includes('数据可视化'));
  const closure = read('skills/skill-authoring-closure/references/qoder-evolution-panel.md');
  assert.ok(closure.includes('`processed: [{id, name, at, skill}]`'));
  assert.ok(closure.includes('先按 id'));
  const smoke = read('skills/global-config-smoke-runner/SKILL.md');
  assert.ok(smoke.includes('不等于"零写入"'));
  const office = read('skills/encrypted-office-visual-inspection/SKILL.md');
  assert.ok(office.includes('不得用这一步绕过平台'));
});
