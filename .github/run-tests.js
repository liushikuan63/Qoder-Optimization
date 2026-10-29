#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const homeParent = process.env.RELEASE_TEST_HOME_PARENT || os.homedir();
const home = fs.mkdtempSync(path.join(homeParent, '.qo-release-home-'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-release-tests-'));
const env = {};
for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL']) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, {
  HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp,
  APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
  SMOKE_SCRIPTS_DIR: path.join(root, 'scripts'),
});
for (const dir of [env.APPDATA, env.LOCALAPPDATA, path.join(home, '.qoder/scripts')]) fs.mkdirSync(dir, { recursive: true });
for (const name of ['hook-crash-guard.js', 'client-root.js']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(home, '.qoder/scripts', name));
const checks = [
  ['global self-tests', [path.join(root, 'skills/global-config-smoke-runner/scripts/smoke-runner.cjs'), '--tests-only']],
  ['release, suggestion, scan and tiering contracts', ['--test', path.join(__dirname, 'release.test.js'), path.join(__dirname, 'suggestions.test.js'), path.join(__dirname, 'scan.test.js'), path.join(__dirname, 'tiering.test.js'), path.join(__dirname, 'maintenance.test.js'), path.join(__dirname, 'delivery.test.js')]],
];
let failures = 0;
try {
  console.log('Runtime ' + process.version + '; isolated HOME and temp; no live client configuration inherited');
  for (const [name, args] of checks) {
    const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', timeout: 540000 });
    console.log(`${name} EXIT=${result.status === null ? 'TIMEOUT/CRASH' : result.status}`);
    if (result.status !== 0) {
      failures++;
      if (name === 'global self-tests') for (const dir of fs.readdirSync(temp).filter(dir => dir.startsWith('qoder-smoke-'))) {
        const summary = path.join(temp, dir, 'summary.json');
        if (!fs.existsSync(summary)) continue;
        try {
          for (const item of JSON.parse(fs.readFileSync(summary, 'utf8')).results.filter(item => item.exit !== 0 && item.exit !== 'SKIP' && item.log)) {
            const relative = path.relative(fs.realpathSync(temp), fs.realpathSync(item.log));
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('diagnostic log escaped the isolated directory');
            console.error(`DIAGNOSTIC ${item.name}\n${fs.readFileSync(item.log, 'utf8').slice(0, 12000)}`);
          }
        } catch (error) { console.error('DIAGNOSTIC_ERROR ' + error.message); }
      }
    }
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('TEST_LOGS ' + temp);
process.exitCode = failures ? 1 : 0;
