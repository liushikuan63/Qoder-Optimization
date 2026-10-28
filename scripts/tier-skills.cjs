#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { clientRoot } = require('./client-root.js');

const CORE = [
  'skills-router', 'verify-before-claim', 'verify-ui-in-browser', 'goal-driven-execution',
  'ship-clean-pr', 'self-evolution', 'safe-text-editing', 'structured-edit-safety',
  'continuation-state-audit', 'concurrent-edit-attribution-check', 'vibecoding-doc', 'vibe-coding-workflow',
];

function main(argv) {
  let apply = false, restoreAll = false, keep = [], restore = [], only = [];
  const names = value => {
    const result = value.split(',').map(name => name.trim()).filter(Boolean);
    if (!result.length || result.some(name => !/^[a-z0-9][a-z0-9-]*$/.test(name))) throw new Error('技能名必须为小写字母、数字或连字符');
    return [...new Set(result)];
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--restore-all') restoreAll = true;
    else if (['--keep', '--restore', '--only'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const option = argv[i++];
      if (option === '--keep') keep = names(argv[i]);
      else if (option === '--only') only = names(argv[i]);
      else restore = names(argv[i]);
    } else if (argv[i] === '--help') {
      console.log('tier-skills.cjs [--apply] [--keep a,b] [--only a,b] | [--apply] (--restore a,b | --restore-all)');
      return 0;
    } else throw new Error('未知或缺值参数：' + argv[i]);
  }
  if ((restoreAll && restore.length) || ((restoreAll || restore.length) && (keep.length || only.length))) throw new Error('迁移与恢复参数不能混用');
  const root = clientRoot();
  const resident = path.join(root, 'skills');
  const library = path.join(root, 'skills-library');
  const list = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => fs.existsSync(path.join(dir, name, 'SKILL.md'))).sort() : [];
  const restoring = restoreAll || restore.length > 0;
  const kept = new Set([...CORE, ...keep]);
  const movable = list(resident).filter(name => !kept.has(name));
  if (only.some(name => !movable.includes(name))) throw new Error('--only 含不存在或应保留的技能');
  const selected = restoring ? (restoreAll ? list(library) : restore) : (only.length ? only : movable);
  const plan = selected.map(name => ({ name, from: path.join(restoring ? library : resident, name), to: path.join(restoring ? resident : library, name) }));
  for (const item of plan) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.name) || !fs.existsSync(path.join(item.from, 'SKILL.md'))) throw new Error('源技能不存在或名称无效：' + item.name);
    if (fs.lstatSync(item.from).isSymbolicLink()) throw new Error('不自动迁移链接目录：' + item.name);
    if (fs.existsSync(item.to)) throw new Error('目标已有同名技能，未执行任何迁移：' + item.name);
  }
  console.log(`${apply ? 'APPLY' : 'DRY-RUN'} ${restoring ? 'restore' : 'library'}=${plan.length}`);
  for (const item of plan) console.log(`${item.name} -> ${restoring ? 'core' : 'library'}`);
  if (!apply || !plan.length) return 0;
  const builder = path.join(__dirname, 'build-skills-index.cjs');
  if (!fs.existsSync(builder)) throw new Error('缺少 build-skills-index.cjs，未执行迁移');
  const moved = [];
  try {
    fs.mkdirSync(restoring ? resident : library, { recursive: true });
    for (const item of plan) { fs.renameSync(item.from, item.to); moved.push(item); }
    const result = spawnSync(process.execPath, [builder], { encoding: 'utf8', timeout: 60000 });
    if (result.error || result.status !== 0) throw new Error('索引重建失败，exit=' + result.status);
    process.stdout.write(result.stdout || '');
    console.log('VERIFIED moved=' + moved.length);
    return 0;
  } catch (error) {
    const failed = [];
    for (const item of moved.reverse()) {
      try {
        if (fs.existsSync(item.from)) throw new Error('原位置出现其他内容');
        fs.renameSync(item.to, item.from);
      } catch { failed.push(item.name); }
    }
    console.error('TIER_FAILED: ' + error.message);
    console.error(failed.length ? '回滚未完成，请保留现场：' + failed.join(',') : '目录迁移已回滚；派生索引须复验，未覆盖其他写入者的索引。');
    return 1;
  }
}

module.exports = { CORE };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error('TIER_ERROR: ' + error.message); process.exitCode = 2; }
}
