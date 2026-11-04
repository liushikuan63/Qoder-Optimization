'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'pack-share-docs.cjs');

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-pack-docs-'));
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function makePackage(root, skillCount) {
  const home = path.join(root, 'home');
  const pkg = path.join(root, 'pkg');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(pkg, { recursive: true });
  write(home, '.qoder/AGENTS.md', '# AGENTS\n\n> 版本：9.9\n\n' + '全局规则正文。'.repeat(400));
  write(home, '.qoder/rules/one.md', '---\ntrigger: fixture\n---\n\n# 规则一\n\n' + '领域规则正文。'.repeat(400));
  const skills = Array.from({ length: skillCount }, (_, index) => ({
    name: 'skill-' + String(index).padStart(2, '0'),
    tier: index < 2 ? 'core' : 'library',
  }));
  write(pkg, 'skills-manifest.json', JSON.stringify({ schema: 1, package_name: 'Qoder-Optimization', version: '0.0.22', generated: '2026-11-04', skills }));
  for (const skill of skills) write(pkg, 'skills/' + skill.name + '/SKILL.md', '---\nname: ' + skill.name + '\ndescription: "fixture skill"\n---\n');
  write(pkg, 'README-安装说明.md', '# 安装说明\n\n| `skills/` | 随包技能源码 | 默认不整目录复制 |\n\n1. 技能：按需选择\n');
  write(pkg, 'Qoder-个人规则生成提示词.md', '> 配套版本：old\n');
  write(pkg, 'commands/verify-package.md', 'D:/tmp/qoder-pkg-xxx/Qoder优化x.y.z\n');
  return { home, pkg };
}

test('generates the rules document and skill list from a fixture home', () => fixture(root => {
  const { home, pkg } = makePackage(root, 20);
  const result = spawnSync(process.execPath, [script, pkg, '--home', home, '--version', '0.0.23', '--apply'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const doc = fs.readFileSync(path.join(pkg, 'Qoder-AI编码通用规则.md'), 'utf8');
  assert.match(doc, /## 一、全局开发规则/);
  assert.match(doc, /家用机实际装 20 个/);
  assert.match(doc, /## 三、推荐技能清单/);
  assert.ok(fs.existsSync(path.join(pkg, 'SKILLS-清单.md')));
}));

test('fails when the generated document has an empty section', () => fixture(root => {
  const { home, pkg } = makePackage(root, 0);
  const result = spawnSync(process.execPath, [script, pkg, '--home', home, '--version', '0.0.23'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /RED/);
}));
