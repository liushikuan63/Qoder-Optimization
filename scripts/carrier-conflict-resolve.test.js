'use strict';
// carrier-conflict-resolve 的隔离自测：增量索引必须真的增量，自主消解必须只改候选、绝不覆盖既有载体。
// 每条判据都配负对照；并断言「无变化时零重解析」这条性能判据本身能失败（改一个文件就必须重解析一个）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadIndex, detectConflicts, resolve } = require('./carrier-conflict-resolve.cjs');

const SCRIPT = path.join(__dirname, 'carrier-conflict-resolve.cjs');
let fail = 0;
const check = (label, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`); if (!ok) fail++; };

const r = spawnSync(process.execPath, [SCRIPT, '--selftest'], { encoding: 'utf8', timeout: 120000 });
check('自带正负对照自测 exit=0', r.status === 0, `exit=${r.status}`);
check('自测条数与声明一致（14 条）', /14 PASS \/ 0 FAIL/.test(r.stdout || ''), (r.stdout || '').trim().split('\n').slice(-2).join(' | '));
check('自测非空转（真的跑了判据）', /增量生效/.test(r.stdout || '') && /同名冲突一律 BLOCK/.test(r.stdout || ''));

// 独立沙箱：不复用脚本自己的夹具，避免「函数读自己」式伪验证
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-resolve-independent-'));
const w = (rel, text) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const mk = (name, desc) => w(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`);
mk('existing-one', '既有载体。触发词：既有词、共享词');
const cand = mk('candidate-one', '候选载体。触发词：候选词、共享词');

const i1 = loadIndex(base);
const i2 = loadIndex(base);
check('独立沙箱：无变化零重解析', i1.reparsed === 2 && i2.reparsed === 0 && i2.reused === 2, `first=${i1.reparsed} second=${i2.reparsed}`);
fs.writeFileSync(cand, fs.readFileSync(cand, 'utf8') + '\n改动\n');
const i3 = loadIndex(base);
check('负对照：改一个文件必须重解析一个（证明增量判据能失败）', i3.reparsed === 1, `reparsed=${i3.reparsed}`);

const index = loadIndex(base, { refresh: true });
const { descriptionOfFile } = require('./skill-description.cjs');
const { triggerPhrases } = require('./skill-trigger-uniqueness.cjs');
const desc = descriptionOfFile(cand);
const candidate = { file: cand, name: 'candidate-one', description: desc, triggers: triggerPhrases(desc) };
const conflicts = detectConflicts(index, candidate);
check('独立沙箱：检出共享触发词', conflicts.some(c => c.kind === 'trigger-overlap' && c.phrases.includes('共享词')));
const res = resolve(candidate, conflicts, index);
check('独立沙箱：消解后保留独有线素', !res.blocked && triggerPhrases(res.description).includes('候选词'));
check('独立沙箱：消解后去掉重复线素', !triggerPhrases(res.description).includes('共享词'));
check('独立沙箱：消解后零冲突', detectConflicts(index, { ...candidate, description: res.description, triggers: triggerPhrases(res.description) }).length === 0);
check('负对照：既有载体文件未被触碰', fs.readFileSync(path.join(base, 'skills/existing-one/SKILL.md'), 'utf8').includes('共享词'));

const usage = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 60000 });
check('负对照：缺参 exit=2', usage.status === 2, `exit=${usage.status}`);
const missing = spawnSync(process.execPath, [SCRIPT, '--root', base, '--type', 'skill', '--name', 'x', '--file', path.join(base, 'nope.md')], { encoding: 'utf8', timeout: 60000 });
check('负对照：候选文件不存在 exit=2', missing.status === 2, `exit=${missing.status}`);

fs.rmSync(base, { recursive: true, force: true });
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);