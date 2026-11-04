'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'scripts/continuity.cjs');
const installer = path.join(root, 'scripts/install-continuity.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-continuity-review-'));
  const client = path.join(dir, 'client'), store = path.join(dir, 'store'), cwd = path.join(dir, 'workspace');
  fs.mkdirSync(client); fs.mkdirSync(store); fs.mkdirSync(cwd);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, QODER_HOME: client, CONTINUITY_STORE: store };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (code, args = []) => spawnSync(process.execPath, ['-e', code, ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  return { dir, client, store, cwd, env, run, session: 'continuity-review-session-001' };
}

test('malformed truthy enabled values never authorize collection or hook capture', t => {
  const f = fixture(t);
  const r = f.run(`const c=require(${JSON.stringify(runtime)}),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const o=${JSON.stringify({ store: f.store, cwd: f.cwd, session: f.session })};
    c.enable({...o,task:'strict-enabled'});
    const file=path.join(c.location(o).dir,'scope.json');
    for(const value of ['false','true',1,{}]) {
      const scope=JSON.parse(fs.readFileSync(file,'utf8'));scope.enabled=value;fs.writeFileSync(file,JSON.stringify(scope));
      assert.equal(c.capture(o).status,'NOT_ENABLED');
      assert.equal(c.hook({hook_event_name:'UserPromptSubmit',cwd:o.cwd,session_id:o.session},{store:o.store}),'');
      assert.equal(fs.existsSync(c.databasePath(c.location(o))),false);
    }`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('disable before the first hook persists the explicit session choice', t => {
  const f = fixture(t);
  const r = f.run(`const c=require(${JSON.stringify(runtime)}),fs=require('node:fs'),path=require('node:path');
    const o=${JSON.stringify({ store: f.store, cwd: f.cwd, session: f.session })};
    fs.writeFileSync(path.join(o.store,'auto-bind.json'),JSON.stringify({schema:1,enabled:true}));
    c.disable(o);c.hook({hook_event_name:'UserPromptSubmit',cwd:o.cwd,session_id:o.session},{store:o.store});
    console.log(fs.readFileSync(path.join(c.location(o).dir,'scope.json'),'utf8'));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).enabled, false);
});

test('manual enable can assign a task after disabling an unbound session', t => {
  const f = fixture(t);
  const r = f.run(`const c=require(${JSON.stringify(runtime)}),fs=require('node:fs'),path=require('node:path');
    const o=${JSON.stringify({ store: f.store, cwd: f.cwd, session: f.session })};
    c.disable(o);c.enable({...o,task:'manually-selected-task'});
    console.log(fs.readFileSync(path.join(c.location(o).dir,'scope.json'),'utf8'));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).task, 'manually-selected-task');
  assert.equal(JSON.parse(r.stdout).enabled, true);
});

test('a late auto-bind attempt never re-enables an already disabled scope', t => {
  const f = fixture(t);
  const r = f.run(`const c=require(${JSON.stringify(runtime)}),fs=require('node:fs'),path=require('node:path');
    const o=${JSON.stringify({ store: f.store, cwd: f.cwd, session: f.session })};
    fs.writeFileSync(path.join(o.store,'auto-bind.json'),JSON.stringify({schema:1,enabled:true}));
    c.hook({hook_event_name:'UserPromptSubmit',cwd:o.cwd,session_id:o.session},{store:o.store});
    c.disable(o);c.autoBind(c.location(o));
    console.log(fs.readFileSync(path.join(c.location(o).dir,'scope.json'),'utf8'));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).enabled, false);
});

test('continuity CLI rejects a flag or whitespace as an option value without creating a store', t => {
  const f = fixture(t);
  for (const args of [ ['enable','--cwd',f.cwd,'--session',f.session,'--task','--history'], ['enable','--cwd',f.cwd,'--session',f.session,'--task','x','--store','   '] ]) {
    const r = spawnSync(process.execPath, [runtime, ...args], { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(r.status, 0, JSON.stringify(args) + '\n' + r.stdout);
  }
  assert.deepEqual(fs.readdirSync(f.store), []);
  assert.deepEqual(fs.readdirSync(f.cwd), []);
});

for (const kind of ['script', 'settings', 'policy']) {
  for (const prior of [false, true]) {
    test(`installer preserves a concurrent ${kind} writer during publication: prior=${prior}`, t => {
      const f = fixture(t);
      fs.mkdirSync(path.join(f.client, 'scripts'));
      const target = kind === 'script' ? path.join(f.client, 'scripts/continuity.cjs') : kind === 'settings' ? path.join(f.client, 'settings.json') : path.join(f.store, 'auto-bind.json');
      const old = kind === 'script' ? 'prior fixture script' : kind === 'settings' ? '{"hooks":{}}' : '{"schema":99,"enabled":true}';
      const concurrent = kind === 'policy' ? '{"schema":1,"enabled":false}' : kind === 'settings' ? '{"owner":"concurrent settings writer"}' : 'concurrent script writer';
      if (prior) fs.writeFileSync(target, old);
      const preload = path.join(f.dir, 'publication-race.cjs');
      fs.writeFileSync(preload, `const fs=require('node:fs'),rename=fs.renameSync,link=fs.linkSync;
        const target=${JSON.stringify(target)};let fired=false;
        function race(from,to){if(!fired&&((to===target&&String(from).includes('.tmp-'))||from===target)){fired=true;fs.writeFileSync(target,${JSON.stringify(concurrent)});}}
        fs.renameSync=function(from,to){race(from,to);return rename.call(this,from,to);};
        fs.linkSync=function(from,to){race(from,to);return link.call(this,from,to);};`);
      const r = spawnSync(process.execPath, ['--require', preload, installer, '--client-root', f.client, '--yes'], { env: f.env, encoding: 'utf8', timeout: 30000 });
      assert.equal(fs.readFileSync(target, 'utf8'), concurrent, r.stdout + r.stderr);
      if (kind !== 'policy') assert.notEqual(r.status, 0, r.stdout + r.stderr);
      else assert.match(r.stdout, /写入失败/);
    });
  }
}

for (const kind of ['script', 'settings', 'policy']) {
  test(`a concurrent ${kind} creator after detachment keeps both objects`, t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.client, 'scripts'));
    const target = kind === 'script' ? path.join(f.client, 'scripts/continuity.cjs') : kind === 'settings' ? path.join(f.client, 'settings.json') : path.join(f.store, 'auto-bind.json');
    const prior = kind === 'script' ? 'prior script' : kind === 'settings' ? '{"hooks":{}}' : '{"schema":99,"enabled":true}';
    const concurrent = kind === 'policy' ? '{"schema":1,"enabled":false}' : 'concurrent creator';
    fs.writeFileSync(target, prior);
    const preload = path.join(f.dir, 'creator-after-move.cjs');
    fs.writeFileSync(preload, `const fs=require('node:fs'),link=fs.linkSync;const target=${JSON.stringify(target)};let fired=false;
      fs.linkSync=function(from,to){if(!fired&&to===target&&String(from).includes('.tmp-')){fired=true;fs.writeFileSync(target,${JSON.stringify(concurrent)});}return link.call(this,from,to);};`);
    const r = spawnSync(process.execPath, ['--require', preload, installer, '--client-root', f.client, '--yes'], { env: f.env, encoding: 'utf8', timeout: 30000 });
    assert.equal(fs.readFileSync(target, 'utf8'), concurrent, r.stdout + r.stderr);
    const previous = fs.readdirSync(path.dirname(target)).filter(name => name.startsWith(path.basename(target) + '.previous-'));
    assert.equal(previous.length, 1, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(path.dirname(target), previous[0]), 'utf8'), prior);
  });
}

test('rewriting a malformed auto-bind policy retains its original bytes in a backup', t => {
  const f = fixture(t), file = path.join(f.store, 'auto-bind.json');
  fs.writeFileSync(file, '{malformed-policy');
  const r = spawnSync(process.execPath, [installer, '--client-root', f.client, '--yes'], { env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const backups = fs.readdirSync(f.store).filter(name => name.startsWith('auto-bind.json.bak'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(f.store, backups[0]), 'utf8'), '{malformed-policy');
});

test('an explicit installer skip needs no SQLite capability and writes nothing', t => {
  const f = fixture(t), preload = path.join(f.dir, 'unsupported-node.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load;Module._load=function(request,...args){if(request==='node:sqlite')throw new Error('unsupported');return load.call(this,request,...args);};`);
  const r = spawnSync(process.execPath, ['--require', preload, installer, '--no', '--client-root', f.client], { env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(f.client), []);
  assert.deepEqual(fs.readdirSync(f.store), []);
});

test('installer rejects a whitespace client root', t => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [installer, '--yes', '--client-root', '   '], { cwd: f.cwd, env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(f.cwd), []);
});

test('missing-Node wrapper help/dry-run/skip never launches the Node installer', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const wrapper = path.join(f.dir, 'install.cmd'), log = path.join(f.dir, 'unexpected-node-install.log');
  fs.copyFileSync(path.join(root, 'install.cmd'), wrapper);
  fs.writeFileSync(path.join(f.dir, 'node.cmd'), '@echo off\r\nexit /b 1\r\n');
  fs.writeFileSync(path.join(f.dir, 'pwsh.cmd'), '@echo off\r\necho unexpected>"' + log + '"\r\nexit /b 0\r\n');
  const env = { ...f.env, ProgramFiles: f.dir, PATH: f.dir + ';' + path.join(process.env.SystemRoot, 'System32') };
  for (const args of ['--help', '--dry-run', '--yes --dry-run', '--no', '--non-interactive']) {
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'install.cmd ' + args], { cwd: f.dir, env, encoding: 'utf8', input: '', timeout: 10000, windowsHide: true, windowsVerbatimArguments: true });
    assert.equal(fs.existsSync(log), false, args + '\n' + r.stdout + r.stderr);
    if (args.includes('--dry-run')) assert.notEqual(r.status, 0, r.stdout + r.stderr);
    else assert.equal(r.status, 0, r.stdout + r.stderr);
  }
});

for (const scenario of ['winget-failure', 'child-failure', 'node-missing']) {
  test('Node bootstrap propagates its outcome: ' + scenario, { skip: process.platform !== 'win32' }, t => {
    const f = fixture(t);
    const original = fs.readFileSync(path.join(root, 'scripts/install-node.ps1'), 'utf8');
    // Only the menu/input gates are projected; neither winget nor a real
    // installer is executed. The rest of the bootstrap control flow is real.
    assert.equal(original.split('if ($NonInteractive -or [Console]::IsInputRedirected)').length, 2);
    const projected = original.replace('if ($NonInteractive -or [Console]::IsInputRedirected)', 'if ($false)')
      .replace(/^\$index = Select-Menu .*$/m, '$index = 0');
    const script = path.join(f.dir, 'install-node.ps1');
    fs.writeFileSync(script, '\ufeff' + projected.replace(/^\ufeff/, ''));
    fs.writeFileSync(path.join(f.dir, 'install-package.cjs'), 'process.exit(71);');
    const wrapper = path.join(f.dir, 'bootstrap-fixture.ps1');
    const quote = value => "'" + value.replace(/'/g, "''") + "'";
    fs.writeFileSync(wrapper, '\ufeff' + `$env:ProgramFiles = ${quote(f.dir)}
      \${env:ProgramFiles(x86)} = ${quote(f.dir)}
      $env:LOCALAPPDATA = ${quote(f.dir)}
      function winget { $global:LASTEXITCODE = ${scenario === 'winget-failure' ? 53 : 0} }
      function Get-Command { param([string]$Name, $ErrorAction) if ($Name -eq 'winget') { return @{ Source = 'fixture' } }; if ($Name -eq 'node') { ${scenario === 'node-missing' ? 'return $null' : 'return @{ Source = ' + quote(process.execPath) + ' }'} } }
      & ${quote(script)}
      exit $LASTEXITCODE
    `);
    const env = { ...f.env, ProgramFiles: f.dir, 'ProgramFiles(x86)': f.dir, LOCALAPPDATA: f.dir, APPDATA: f.dir, PATH: scenario === 'node-missing' ? path.join(process.env.SystemRoot, 'System32') : process.env.PATH };
    // Enterprise policy blocks Windows PowerShell 5.1 scripts; prefer pwsh 7.
    const pwsh7 = path.join(process.env.ProgramW6432 || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
    const ps = fs.existsSync(pwsh7) ? pwsh7 : path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-File', wrapper], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(r.status, scenario === 'winget-failure' ? 53 : scenario === 'child-failure' ? 71 : 3, r.stdout + r.stderr);
  });
}

test('unsupported-Node interactive setup falls back to installed Windows PowerShell', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), preload = path.join(f.dir, 'legacy-shell-fixture.cjs'), selected = path.join(f.dir, 'selected-shell.json');
  fs.writeFileSync(preload, `const Module=require('node:module'),load=Module._load,fs=require('node:fs'),exists=fs.existsSync;
    Module._load=function(request,...args){if(request==='node:sqlite')throw new Error('unsupported');return load.call(this,request,...args);};
    fs.existsSync=function(file){if(/PowerShell[\\\\/]7[\\\\/]pwsh\\.exe$/i.test(file))return false;return exists.call(this,file);};
    Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stdout,'isTTY',{value:true});
    process.stdin.setRawMode=()=>{};
    require('node:readline').emitKeypressEvents=stdin=>setImmediate(()=>stdin.emit('keypress','',{name:'return'}));
    require('node:child_process').spawnSync=function(shell){fs.writeFileSync(${JSON.stringify(selected)},JSON.stringify({shell}));return {status:0};};`);
  const r = spawnSync(process.execPath, ['--require', preload, installer], { env: f.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  const shell = JSON.parse(fs.readFileSync(selected, 'utf8')).shell;
  assert.equal(path.basename(shell).toLowerCase(), 'powershell.exe');
  assert.equal(path.isAbsolute(shell), true);
});
