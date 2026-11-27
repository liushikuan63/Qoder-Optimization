#!/usr/bin/env node
'use strict';
// mcp-toggle.cjs 的自测：沙箱 QODER_HOME，覆盖预览不写盘、--apply 备份写盘、幂等、
// 未知 server / 损坏 JSON 拒绝、--both 单侧、非法参数与退出码。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'mcp-toggle.cjs');
const ROOT = path.join(os.tmpdir(), `mcp-toggle-sb-${process.pid}-${Date.now()}`);
const CLIENT = path.join(ROOT, '.qoder');
const SETTINGS = path.join(CLIENT, 'settings.json');
const FIXTURE = {
  mcpServers: {
    dbhub: { type: 'stdio', command: 'node', args: ['dbhub.js'] },
    'cua-driver': { type: 'stdio', command: 'cua.exe' },
    'workflow-ops': { command: 'node', args: ['index.js'] },
    Context7: { type: 'http', url: 'https://example.invalid/mcp', disabled: true },
  },
};
fs.mkdirSync(CLIENT, { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(FIXTURE, null, 2) + '\n');

const ENV = { ...process.env, QODER_HOME: CLIENT, HOME: ROOT, USERPROFILE: ROOT, BACKUP_NO_RECYCLE: '1', CI: 'true' };
const run = (args, env = ENV) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000, env });
const sha = (file = SETTINGS) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const backups = (dir = CLIENT) => fs.readdirSync(dir).filter((name) => /^settings\.json\.bak/.test(name));
const read = (file = SETTINGS) => JSON.parse(fs.readFileSync(file, 'utf8'));

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
  if (!ok) fail += 1;
};

const hash1 = sha();
const r1 = run(['--list', '--json']);
let j1 = {};
try { j1 = JSON.parse(r1.stdout); } catch {}
const servers1 = j1.sides && j1.sides[0] ? j1.sides[0].servers : [];
check('① --list --json 列出 4 个 server 且 Context7 为 disabled',
  r1.status === 0 && servers1.length === 4 && (servers1.find((s) => s.name === 'Context7') || {}).disabled === true,
  `exit=${r1.status}`);
check('①-补 list 不写盘、不备份', sha() === hash1 && backups().length === 0);

const r2 = run(['--disable', 'dbhub']);
check('② 预览提及 dbhub 且不写盘/不备份',
  r2.status === 0 && /dbhub/.test(r2.stdout) && sha() === hash1 && backups().length === 0,
  `exit=${r2.status}`);

const r3 = run(['--disable', 'dbhub', '--apply']);
const after3 = read();
check('③ --disable --apply 写入 disabled 且有备份',
  r3.status === 0 && after3.mcpServers.dbhub.disabled === true && backups().length === 1,
  `exit=${r3.status}`);

const hash4 = sha();
const count4 = backups().length;
const r4 = run(['--disable', 'dbhub', '--apply']);
check('④ 重复禁用幂等：无写盘、无新备份',
  r4.status === 0 && sha() === hash4 && backups().length === count4,
  `exit=${r4.status}`);

const r5 = run(['--enable', 'dbhub', '--apply']);
const after5 = read();
check('⑤ --enable --apply 移除 disabled 键',
  r5.status === 0 && !Object.prototype.hasOwnProperty.call(after5.mcpServers.dbhub, 'disabled'),
  `exit=${r5.status}`);

const hash6 = sha();
const count6 = backups().length;
const r6 = run(['--disable', 'missing-server']);
check('⑥ 未知 server：exit 1 且不写盘',
  r6.status === 1 && sha() === hash6 && backups().length === count6,
  `exit=${r6.status}`);

const CORRUPT = path.join(ROOT, 'corrupt');
fs.mkdirSync(CORRUPT, { recursive: true });
fs.writeFileSync(path.join(CORRUPT, 'settings.json'), '{ not json');
const r7 = spawnSync(process.execPath, [SCRIPT, '--disable', 'dbhub', '--apply'], {
  encoding: 'utf8',
  env: { ...ENV, QODER_HOME: CORRUPT },
});
check('⑦ 损坏 JSON：exit 1 且文件不变',
  r7.status === 1 && fs.readFileSync(path.join(CORRUPT, 'settings.json'), 'utf8') === '{ not json',
  `exit=${r7.status}`);

const ONE = path.join(ROOT, 'one');
const ONE_CLIENT = path.join(ONE, '.qoder');
fs.mkdirSync(ONE_CLIENT, { recursive: true });
fs.writeFileSync(path.join(ONE_CLIENT, 'settings.json'), JSON.stringify(FIXTURE, null, 2) + '\n');
const r8 = spawnSync(process.execPath, [SCRIPT, '--list', '--both', '--json'], {
  encoding: 'utf8',
  env: { ...ENV, QODER_HOME: ONE_CLIENT },
});
let j8 = {};
try { j8 = JSON.parse(r8.stdout); } catch {}
check('⑧ --both 只有一侧：只处理存在侧、不创建另一侧',
  r8.status === 0 && j8.sides.length === 1 && !fs.existsSync(path.join(ONE, '.qoder-cn')),
  `exit=${r8.status}`);

const r9a = run(['--bogus']);
const r9b = run(['--enable']);
const r9c = run(['--config-dir', CLIENT, '--both']);
check('⑨ 非法参数 / 缺名称 / 互斥开关：exit 2',
  r9a.status === 2 && r9b.status === 2 && r9c.status === 2,
  `exit=${r9a.status}/${r9b.status}/${r9c.status}`);

const hash10 = sha();
const count10 = backups().length;
const r10 = run(['--enable', 'dbhub']);
check('⑩ 预览路径绝不调用备份',
  r10.status === 0 && sha() === hash10 && backups().length === count10,
  `exit=${r10.status}`);

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exitCode = fail ? 1 : 0;
