'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const source = path.resolve(__dirname, '..');

function fixture(body) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-loop-'));
  const home = path.join(base, 'home'), client = path.join(home, '.qoder');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, QODER_HOME: client,
    TEMP: base, TMP: base, TMPDIR: base, APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'Local') };
  for (const key of Object.keys(env)) if (/^(AUTH_LOCK_|ATTEMPT_LOCK_|RISKY_MATCH_|FAIL_STREAK_|HOOK_)/.test(key)) delete env[key];
  const run = (file, args) => spawnSync(process.execPath, [path.join(source, file), ...args], { env, encoding: 'utf8', timeout: 60000 });
  try { body({ base, home, client, env, run }); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

for (const hooks of [[], null, 'invalid', { PreToolUse: {} }, { PostToolUse: [null] }, { PreToolUse: [{ hooks: {} }] }]) {
  test('MCP rejects malformed hook structure before any configuration write: ' + JSON.stringify(hooks), () => fixture(f => {
    fs.mkdirSync(path.join(f.client, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(f.client, 'scripts/cua-cursor-guard.js'), '// fixture, never executed\n');
    const file = path.join(f.client, 'settings.json');
    const before = JSON.stringify({ sentinel: 'preserve-me', mcpServers: {}, hooks });
    fs.writeFileSync(file, before);
    const result = f.run('mcp/install-mcp.cjs', ['--yes', '--skip-cua', '--skip-dbhub', '--wire-guard', '--config-dir', f.client]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(f.client, '.backups')), false);
  }));
}

test('MCP wires both events into valid settings and retains unrelated hooks', () => fixture(f => {
  fs.mkdirSync(path.join(f.client, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(f.client, 'scripts/cua-cursor-guard.js'), '// fixture, never executed\n');
  const unrelated = { matcher: '^Read$', hooks: [{ type: 'command', command: 'unrelated-fixture' }] };
  fs.writeFileSync(path.join(f.client, 'settings.json'), JSON.stringify({ sentinel: 'preserve-me', mcpServers: {}, hooks: { PreToolUse: [unrelated] } }));
  const result = f.run('mcp/install-mcp.cjs', ['--yes', '--skip-cua', '--skip-dbhub', '--wire-guard', '--config-dir', f.client]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(f.client, 'settings.json')));
  assert.equal(after.sentinel, 'preserve-me');
  assert.deepEqual(after.hooks.PreToolUse[0], unrelated);
  assert.ok(after.hooks.PreToolUse.some(entry => entry.hooks.some(hook => hook.command.includes('cua-cursor-guard.js'))));
  assert.ok(after.hooks.PostToolUse.some(entry => entry.hooks.some(hook => hook.command.includes('cua-cursor-guard.js'))));
}));

for (const kind of ['echo', 'extra-argument', 'wrong-node', 'wrong-type', 'wrong-matcher', 'wrong-timeout', 'duplicate']) {
  test('MCP rejects conflicting existing guard wiring without modifying settings: ' + kind, () => fixture(f => {
    const scripts = path.join(f.client, 'scripts'); fs.mkdirSync(scripts, { recursive: true });
    const guard = path.join(scripts, 'cua-cursor-guard.js'); fs.writeFileSync(guard, '// fixture\n');
    const command = `"${process.execPath}" "${guard}"`;
    const hook = { type: 'command', command, timeout: 10 };
    const entry = { matcher: 'mcp_call|mcp__cua[_-]?driver__.*|^Bash$', hooks: [hook] };
    if (kind === 'echo') hook.command = 'echo cua-cursor-guard.js';
    if (kind === 'extra-argument') hook.command += ' --clear ALL';
    if (kind === 'wrong-node') hook.command = `"${path.join(f.base, 'wrong-node')}" "${guard}"`;
    if (kind === 'wrong-type') hook.type = 'prompt';
    if (kind === 'wrong-matcher') entry.matcher = '^Read$';
    if (kind === 'wrong-timeout') hook.timeout = 1;
    const entries = kind === 'duplicate' ? [entry, structuredClone(entry)] : [entry];
    const settings = path.join(f.client, 'settings.json');
    const before = JSON.stringify({ mcpServers: {}, hooks: { PreToolUse: entries } });
    fs.writeFileSync(settings, before);
    const result = f.run('mcp/install-mcp.cjs', ['--yes', '--skip-cua', '--skip-dbhub', '--wire-guard', '--config-dir', f.client]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(settings, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(f.client, '.backups')), false);
  }));
}

test('MCP accepts equivalent platform paths and preserves existing guard entries on a second run', () => fixture(f => {
  const scripts = path.join(f.client, 'scripts'); fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'cua-cursor-guard.js'), '// fixture\n');
  const node = process.platform === 'win32' ? process.execPath.toUpperCase().replace(/\\/g, '/') : process.execPath;
  const guard = path.join(scripts, '..', 'scripts').replace(/\\/g, '/') + '/cua-cursor-guard.js';
  const entry = { matcher: 'mcp_call|mcp__cua[_-]?driver__.*|^Bash$', hooks: [{ type: 'command', command: `"${node}" "${guard}"`, timeout: 10 }] };
  const file = path.join(f.client, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: {}, hooks: { PreToolUse: [entry], PostToolUse: [entry] } }));
  const args = ['--yes', '--skip-cua', '--skip-dbhub', '--wire-guard', '--config-dir', f.client];
  let result = f.run('mcp/install-mcp.cjs', args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(after).hooks.PreToolUse.length, 1);
  assert.equal(JSON.parse(after).hooks.PostToolUse.length, 1);
  result = f.run('mcp/install-mcp.cjs', args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
}));

test('fail-streak installer self-test assembles a healthy host and exercises the delegated block', () => fixture(f => {
  const scripts = path.join(f.client, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['risky-match-guard.js', 'hook-crash-guard.js', 'auth-lock-core.js', 'attempt-lock-core.js', 'client-root.js', 'backup-file.js']) {
    fs.copyFileSync(path.join(source, 'scripts', name), path.join(scripts, name));
  }
  const before = fs.readdirSync(f.client).sort();
  const result = f.run('skills/mechanize-rule-into-hook-guard/scripts/install-fail-streak.cjs', ['--selftest']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS\s+自检9/);
  assert.match(result.stdout, /PASS\s+自检11/);
  assert.doesNotMatch(result.stdout, /FAIL\s/);
  assert.deepEqual(fs.readdirSync(f.client).sort(), before);
}));

test('fail-streak self-test rejects a failed negative-control subprocess', () => fixture(f => {
  const stub = path.join(f.base, 'failed-control.cjs');
  fs.writeFileSync(stub, "const cp = require('child_process'); const original = cp.spawnSync; cp.spawnSync = function(command, args, options) { if (Array.isArray(args) && /host-no-delegation\\.js$/.test(args[0] || '')) return { status: 7, stdout: '', stderr: 'fixture control crashed' }; return original(command, args, options); };\n");
  const script = path.join(source, 'skills/mechanize-rule-into-hook-guard/scripts/install-fail-streak.cjs');
  const result = spawnSync(process.execPath, ['--require', stub, script, '--selftest'], { env: f.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL\s+自检子进程健康 host-no-delegation\.js/);
  assert.match(result.stdout, /FAIL\s+自检10/);
}));

for (const apply of [false, true]) {
  test('migration reports a failed copy with a nonzero exit; apply=' + apply, { skip: process.platform !== 'win32' }, () => fixture(f => {
    const m = migrationFixture(f);
    if (!apply) {
      const trapRoot = path.join(f.base, 'foreign-modules'), trap = path.join(trapRoot, 'Microsoft.PowerShell.Utility');
      fs.mkdirSync(trap, { recursive: true });
      fs.writeFileSync(path.join(trap, 'Microsoft.PowerShell.Utility.psd1'), "@{ RootModule='trap.psm1'; ModuleVersion='99.0.0'; FunctionsToExport=@('Get-Date','Out-File') }\n");
      fs.writeFileSync(path.join(trap, 'trap.psm1'), "[IO.File]::WriteAllText('" + path.join(f.base, 'foreign-module-loaded').replace(/'/g, "''") + "','unexpected module'); throw 'foreign fixture module must not load'\n");
      for (const key of Object.keys(f.env)) if (/^(?:PSModulePath|WinPSModulePath)$/i.test(key)) delete f.env[key];
      f.env.PSModulePath = trapRoot;
    }
    fs.mkdirSync(m.link, { recursive: true });
    const file = path.join(m.link, 'owned.log'); fs.writeFileSync(file, 'owned fixture');
    const result = m.invoke('-To D' + (apply ? ' -Apply' : ''), { copyExit: 8 });
    assert.equal(result.status, apply ? 1 : 0, result.stdout + result.stderr);
    assert.match(result.stdout, apply ? /robocopy exit 8/ : /PLAN ONLY/);
    assert.doesNotMatch(result.stdout, /D:\\qoder-data\\/i);
    assert.equal(fs.readFileSync(file, 'utf8'), 'owned fixture');
    assert.equal(fs.existsSync(m.link + '.bak-migrating'), false);
    assert.equal(fs.existsSync(path.join(m.target, 'owned.log')), false);
    assert.equal(fs.existsSync(path.join(f.base, 'foreign-module-loaded')), false, 'a fixture must not resolve host modules');
  }));
}

// Project only the fixed destination resolver into the disposable test directory.
// All migration/rollback logic remains byte-for-byte production code.
function migrationFixture(f) {
  const destination = path.join(f.base, 'dest');
  const script = path.join(f.base, 'migration-fixture.ps1');
  const original = fs.readFileSync(path.join(source, 'scripts/migrate-qoder-data.ps1'), 'utf8');
  const needle = 'function Dst-Path($u, $drive) { "{0}:\\qoder-data\\{1}\\{2}" -f $drive, $u.Side, $u.Dir }';
  assert.ok(original.includes(needle), 'only the destination resolver may be projected');
  const quote = value => String(value).replace(/'/g, "''");
  fs.writeFileSync(script, original.replace(needle, "function Dst-Path($u, $drive) { Join-Path '" + quote(destination) + "' ('{0}\\{1}' -f $u.Side, $u.Dir) }"));
  const target = path.join(destination, 'qoder/logs'), link = path.join(f.client, 'logs');
  const marker = path.join(f.base, 'unsafe-transition.txt');
  let calls = 0;
  const invoke = (args, { running = false, copy = false, copyExit = 0, forbidRename = false, failedProbe = false, recordCopy = false } = {}) => {
    const wrapper = path.join(f.base, 'migration-call-' + calls++ + '.ps1');
    const trace = wrapper + '.trace';
    const moduleFence = path.join(f.base, 'empty-module-search'); fs.mkdirSync(moduleFence, { recursive: true });
    fs.writeFileSync(wrapper, [
      "$ErrorActionPreference = 'Stop'",
      '$fixtureClock = [Diagnostics.Stopwatch]::StartNew()',
      "function Trace-Fixture($Stage) { [IO.File]::AppendAllText('" + quote(trace) + "', ('{0}:{1}' -f $fixtureClock.ElapsedMilliseconds,$Stage) + [Environment]::NewLine) }",
      "Trace-Fixture 'bootstrap'",
      "$env:PSModulePath = [IO.Path]::Combine($PSHOME,'Modules')",
      "Import-Module ([IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1')) -ErrorAction Stop",
      "Import-Module ([IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop",
      "$PSModuleAutoLoadingPreference = 'None'",
      "Trace-Fixture 'builtin-modules-ready'",
      running ? "function Get-Process { [pscustomobject]@{ Name='QoderFixture' } }" : 'function Get-Process { @() }',
      'function Get-PSDrive { param($Name) [pscustomobject]@{Name=$Name;Free=100GB} }',
      'function robocopy { param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments) ' + (recordCopy ? "[IO.File]::WriteAllText('" + quote(marker) + "','copy called'); " : '') + (copy ? "[IO.File]::Copy((Join-Path $Arguments[0] 'owned.log'), (Join-Path $Arguments[1] 'owned.log'), $true); " : '') + '$global:LASTEXITCODE=' + copyExit + ' }',
      "function cmd { param([Parameter(ValueFromRemainingArguments=$true)]$Arguments) [IO.File]::WriteAllText('" + quote(marker) + "','unsafe unlink requested'); throw 'probe blocks shell deletion' }",
      ...(failedProbe ? ["function Get-ChildItem { param([string]$LiteralPath,[switch]$Recurse,[switch]$File,[switch]$Force,[string]$ErrorAction) if ($Recurse -and $File -and ((Get-Item -LiteralPath $LiteralPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { [pscustomobject]@{FullName=(Join-Path $LiteralPath 'absent-read-probe')} } else { Microsoft.PowerShell.Management\\Get-ChildItem @PSBoundParameters } }"] : []),
      ...(forbidRename ? ["function Rename-Item { param($LiteralPath,$NewName) [IO.File]::WriteAllText('" + quote(marker) + "','unsafe switch requested'); throw 'probe blocks rename' }"] : []),
      "Trace-Fixture 'production-start'",
      "& '" + quote(script) + "' " + args,
      '$fixtureExitCode = $LASTEXITCODE',
      "Trace-Fixture 'production-returned'",
      'exit $fixtureExitCode',
    ].join('\n'));
    // Only built-in modules are part of this fixture. Module discovery must not
    // scan inherited user/PS7/hosted-runner module trees before running it.
    // Keep the original 60s child/180s test bounds and every production assertion.
    const env = { ...f.env };
    for (const key of Object.keys(env)) if (/^(?:PSModulePath|WinPSModulePath)$/i.test(key)) delete env[key];
    env.PSModulePath = moduleFence;
    const powershell = path.join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const started = Date.now();
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    result.fixtureTrace = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
    if (result.error || result.status === null) {
      result.stderr = (result.stderr || '') + '\nMIGRATION_CHILD_ERROR ' + JSON.stringify({ elapsedMs: Date.now() - started, timeoutMs: 60000, code: result.error?.code, error: result.error?.message, signal: result.signal, status: result.status, trace: result.fixtureTrace });
    } else {
      assert.match(result.fixtureTrace, /builtin-modules-ready/);
      assert.match(result.fixtureTrace, /production-start/);
      assert.match(result.fixtureTrace, /production-returned/);
    }
    return result;
  };
  return { target, link, marker, invoke };
}

test('migration rejects same-count same-size destination bytes before requesting a switch', { skip: process.platform !== 'win32' }, () => fixture(f => {
  const m = migrationFixture(f);
  fs.mkdirSync(m.link, { recursive: true }); fs.writeFileSync(path.join(m.link, 'owned.log'), 'AAAA');
  fs.mkdirSync(m.target, { recursive: true }); fs.writeFileSync(path.join(m.target, 'owned.log'), 'BBBB');
  const result = m.invoke('-To D -Apply', { forbidRename: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /relative file paths or SHA256 differ/);
  assert.equal(fs.existsSync(m.marker), false, 'different bytes must be rejected before rename');
  assert.equal(fs.readFileSync(path.join(m.link, 'owned.log'), 'utf8'), 'AAAA');
  assert.equal(fs.readFileSync(path.join(m.target, 'owned.log'), 'utf8'), 'BBBB');
}));

test('rollback refuses a running client before touching its junction', { skip: process.platform !== 'win32' }, () => fixture(f => {
  const m = migrationFixture(f);
  fs.mkdirSync(m.target, { recursive: true }); fs.mkdirSync(f.client, { recursive: true });
  fs.symlinkSync(m.target, m.link, 'junction');
  const result = m.invoke('-Undo -Apply', { running: true });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(fs.existsSync(m.marker), false);
  assert.equal(fs.lstatSync(m.link).isSymbolicLink(), true);
}));

test('rollback refuses an unrelated junction or a legacy link with no trusted backup', { skip: process.platform !== 'win32' }, () => fixture(f => {
  const m = migrationFixture(f);
  const unrelated = path.join(f.base, 'unrelated');
  fs.mkdirSync(m.target, { recursive: true }); fs.mkdirSync(unrelated); fs.mkdirSync(f.client, { recursive: true });
  fs.writeFileSync(path.join(unrelated, 'owned.log'), 'unrelated data');
  fs.symlinkSync(unrelated, m.link, 'junction');
  const result = m.invoke('-Undo -Apply');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(fs.existsSync(m.marker), false, 'untrusted links must never reach removal');
  assert.equal(fs.lstatSync(m.link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(unrelated, 'owned.log'), 'utf8'), 'unrelated data');
}));

test('migration and verified rollback preserve bytes through a real disposable junction', { skip: process.platform !== 'win32' }, () => fixture(f => {
  const m = migrationFixture(f);
  fs.mkdirSync(m.link, { recursive: true });
  fs.writeFileSync(path.join(m.link, 'owned.log'), 'verified original');
  const applied = m.invoke('-To D -Apply', { copy: true });
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(fs.lstatSync(m.link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(m.link, 'owned.log'), 'utf8'), 'verified original');
  assert.equal(fs.existsSync(m.link + '.bak-migrating.receipt.json'), true);
  const undo = m.invoke('-Undo -Apply');
  assert.equal(undo.status, 0, undo.stdout + undo.stderr);
  assert.equal(fs.lstatSync(m.link).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(m.link, 'owned.log'), 'utf8'), 'verified original');
  assert.equal(fs.readFileSync(path.join(m.target, 'owned.log'), 'utf8'), 'verified original');
}));

test('migration read-back failure returns nonzero and retains recovery material', { skip: process.platform !== 'win32' }, () => fixture(f => {
  const m = migrationFixture(f);
  fs.mkdirSync(m.link, { recursive: true }); fs.writeFileSync(path.join(m.link, 'owned.log'), 'original');
  const result = m.invoke('-To D -Apply', { copy: true, failedProbe: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /read probe failed/);
  assert.equal(fs.lstatSync(m.link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(m.link, 'owned.log'), 'utf8'), 'original');
  assert.equal(fs.existsSync(m.link + '.bak-migrating.receipt.json'), true);
  assert.equal(fs.existsSync(path.join(m.link + '.bak-migrating', 'owned.log')), true);
}));

for (const changed of ['destination', 'backup']) {
  test('rollback preserves the junction when ' + changed + ' diverges from the recorded snapshot', { skip: process.platform !== 'win32' }, () => fixture(f => {
    const m = migrationFixture(f);
    fs.mkdirSync(m.link, { recursive: true }); fs.writeFileSync(path.join(m.link, 'owned.log'), 'original');
    const applied = m.invoke('-To D -Apply', { copy: true });
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const changedDirectory = changed === 'destination' ? m.target : m.link + '.bak-migrating';
    fs.writeFileSync(path.join(changedDirectory, 'owned.log'), 'new user content');
    const undo = m.invoke('-Undo -Apply');
    assert.equal(undo.status, 1, undo.stdout + undo.stderr);
    assert.equal(fs.lstatSync(m.link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(changedDirectory, 'owned.log'), 'utf8'), 'new user content');
    assert.equal(fs.existsSync(m.link + '.bak-migrating.receipt.json'), true);
  }));
}

for (const kind of ['root-link', 'parent-link', 'nested-link', 'existing-conflict']) {
  test('migration checks destination ownership before copying: ' + kind, { skip: process.platform !== 'win32' }, () => fixture(f => {
    const m = migrationFixture(f);
    fs.mkdirSync(m.link, { recursive: true }); fs.writeFileSync(path.join(m.link, 'owned.log'), 'new source content');
    const victim = path.join(f.base, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'owned.log'), 'VICTIM');
    if (kind === 'root-link') {
      fs.mkdirSync(path.dirname(m.target), { recursive: true }); fs.symlinkSync(victim, m.target, 'junction');
    } else if (kind === 'parent-link') {
      fs.mkdirSync(path.dirname(path.dirname(m.target)), { recursive: true });
      fs.mkdirSync(path.join(victim, 'logs')); fs.writeFileSync(path.join(victim, 'logs/owned.log'), 'VICTIM');
      fs.symlinkSync(victim, path.dirname(m.target), 'junction');
    } else {
      fs.mkdirSync(m.target, { recursive: true });
      if (kind === 'nested-link') fs.symlinkSync(victim, path.join(m.target, 'nested'), 'junction');
      else fs.writeFileSync(path.join(m.target, 'owned.log'), 'VICTIM');
    }
    const result = m.invoke('-To D -Apply', { copy: true, recordCopy: true });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(fs.existsSync(m.marker), false, 'unsafe destination must be rejected before robocopy');
    assert.equal(fs.readFileSync(path.join(victim, 'owned.log'), 'utf8'), 'VICTIM');
    assert.equal(fs.lstatSync(m.link).isSymbolicLink(), false);
    assert.equal(fs.existsSync(m.link + '.bak-migrating'), false);
    if (kind === 'existing-conflict') assert.equal(fs.readFileSync(path.join(m.target, 'owned.log'), 'utf8'), 'VICTIM');
  }));
}
