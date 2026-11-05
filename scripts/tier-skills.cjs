#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const { clientRoot } = require('./client-root.js');

const CORE = [
  'skills-router', 'verify-before-claim', 'verify-ui-in-browser', 'goal-driven-execution',
  'ship-clean-pr', 'self-evolution', 'safe-text-editing', 'structured-edit-safety',
  'continuation-state-audit', 'concurrent-edit-attribution-check', 'vibecoding-doc', 'vibe-coding-workflow',
];
const RESIDENT_FILE = 'skills-resident.json';

function readResident(file) {
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || data.schema !== 1 || !Array.isArray(data.skills)
    || data.skills.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name))) {
    throw new Error(RESIDENT_FILE + ' 格式无效：需要 {"schema":1,"skills":["..."]}');
  }
  return [...new Set(data.skills)];
}

function fileSnapshot(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('元数据必须是普通文件：' + file);
  return { ino: stat.ino, dev: stat.dev, hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
const sameFile = (a, b) => !a || !b ? a === b : a.ino === b.ino && a.dev === b.dev && a.hash === b.hash;

function publishFile(file, staged, expected, stage, applied) {
  if (!sameFile(fileSnapshot(file), expected)) throw new Error('元数据在规划后已变化：' + path.basename(file));
  const item = { file, backup: path.join(stage, 'prior-' + applied.length), moved: false, owned: null };
  applied.push(item);
  if (expected) {
    fs.renameSync(file, item.backup); item.moved = true;
    if (!sameFile(fileSnapshot(item.backup), expected)) throw new Error('元数据在提交时已变化：' + path.basename(file));
  }
  // Stage and destination share a volume. Linking publishes exclusively without
  // replacing a concurrently recreated file or requiring another allocation.
  const stagedIdentity = fileSnapshot(staged);
  fs.linkSync(staged, file); item.owned = stagedIdentity;
}

function rollbackFiles(applied, stage) {
  const conflicts = [];
  for (const item of applied.slice().reverse()) {
    try {
      if (item.owned) {
        const current = fileSnapshot(item.file);
        if (current && !sameFile(current, item.owned)) { conflicts.push(item.file); continue; }
        if (current) {
          const withdrawn = path.join(stage, 'withdrawn-' + applied.indexOf(item));
          fs.renameSync(item.file, withdrawn);
          if (sameFile(fileSnapshot(withdrawn), item.owned)) fs.unlinkSync(withdrawn);
          else {
            try { fs.linkSync(withdrawn, item.file); } catch {}
            conflicts.push(item.file); continue;
          }
        }
      }
      if (item.moved) fs.linkSync(item.backup, item.file);
    } catch { conflicts.push(item.file); }
  }
  return conflicts;
}

function writeResident(file, skills, expected = fileSnapshot(file)) {
  const stage = fs.mkdtempSync(path.join(path.dirname(file), '.resident-transaction-'));
  const staged = path.join(stage, 'new.json'), applied = [];
  let preserve = false;
  try {
    fs.writeFileSync(staged, JSON.stringify({ schema: 1, skills: [...new Set(skills)].sort() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    publishFile(file, staged, expected, stage, applied);
  } catch (error) {
    const conflicts = rollbackFiles(applied, stage);
    preserve = conflicts.length > 0;
    if (preserve) error.message += '；保留并发内容与恢复目录：' + stage;
    throw error;
  } finally { if (!preserve) fs.rmSync(stage, { recursive: true, force: true }); }
}

function rememberResident(file, names) {
  const before = fileSnapshot(file), current = readResident(file);
  if (!sameFile(fileSnapshot(file), before)) throw new Error('常驻清单在读取期间已变化');
  const next = [...new Set([...current, ...names])].sort();
  if (next.length === current.length && next.every((name, index) => name === current[index])) return false;
  writeResident(file, next, before);
  return true;
}

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
    else if (['--keep', '--restore', '--promote', '--only', '--demote'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const option = argv[i++];
      if (option === '--keep') keep = names(argv[i]);
      else if (option === '--only' || option === '--demote') only = [...new Set([...only, ...names(argv[i])])];
      else restore = [...new Set([...restore, ...names(argv[i])])];
    } else if (argv[i] === '--help') {
      console.log('tier-skills.cjs [--apply] [--keep a,b] [--demote a,b | --only a,b] | [--apply] (--promote a,b | --restore a,b | --restore-all)\n--promote/--demote 会写入 <客户端>/skills-resident.json；--keep 与 --restore-all 只影响本次。');
      return 0;
    } else throw new Error('未知或缺值参数：' + argv[i]);
  }
  if ((restoreAll && restore.length) || ((restoreAll || restore.length) && (keep.length || only.length))) throw new Error('迁移与恢复参数不能混用');
  const root = clientRoot();
  const resident = path.join(root, 'skills');
  const library = path.join(root, 'skills-library');
  const residentFile = path.join(root, RESIDENT_FILE);
  const assertTiers = () => {
    for (const dir of [resident, library]) {
      let stat;
      try { stat = fs.lstatSync(dir); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
        if (dir === library && require('./capability-roots.cjs').readBindings(root)) throw new Error('已绑定迁移库可检索和安装；跨目录/跨卷升降级暂不支持，原路径与数据保留，请勿用 rename/copy-delete 绕过');
        throw new Error('技能层级必须是普通目录，不迁移链接路径：' + dir);
      }
    }
  };
  assertTiers();
  const residentBefore = fileSnapshot(residentFile), extras = readResident(residentFile);
  if (!sameFile(fileSnapshot(residentFile), residentBefore)) throw new Error('常驻清单在读取期间已变化');
  const list = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => fs.existsSync(path.join(dir, name, 'SKILL.md'))).sort() : [];
  const restoring = restoreAll || restore.length > 0;
  const kept = new Set([...CORE, ...extras, ...keep]);
  const movable = list(resident).filter(name => !kept.has(name));
  // Explicit demote must also reach skills the user previously promoted; the
  // extras list only protects them from the default whole-tier migration.
  const demotable = list(resident).filter(name => !CORE.includes(name) && !keep.includes(name));
  if (only.some(name => !demotable.includes(name))) throw new Error('--only 含不存在或应保留的技能');
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
  const indexFile = path.join(root, 'skills-index.json'), indexBefore = fileSnapshot(indexFile);
  const stage = fs.mkdtempSync(path.join(root, '.tier-transaction-'));
  const stagedIndex = path.join(stage, 'new-index.json');
  const moved = [], applied = [];
  let preserve = false;
  try {
    fs.mkdirSync(restoring ? resident : library, { recursive: true });
    for (const item of plan) { assertTiers(); fs.renameSync(item.from, item.to); moved.push(item); }
    // Collect into our private stage. A failed resident CAS must not leave an
    // index pointing at tier moves that are about to be rolled back.
    const code = "const fs=require('node:fs'),b=require(process.argv[1]);const entries=b.collectSkills();if(!Array.isArray(entries))throw new Error('invalid index entries');fs.writeFileSync(process.argv[2],JSON.stringify({generated_at:new Date().toISOString(),count:entries.length,entries},null,1),{flag:'wx',mode:0o600});";
    const result = spawnSync(process.execPath, ['-e', code, builder, stagedIndex], { encoding: 'utf8', timeout: 60000 });
    if (result.error || result.status !== 0) throw new Error('索引重建失败，exit=' + result.status);
    if (!sameFile(fileSnapshot(residentFile), residentBefore)) throw new Error('常驻清单在迁移期间已变化，保留其他写入者的选择');
    publishFile(indexFile, stagedIndex, indexBefore, stage, applied);
    // Persist only explicit promote/demote choices; --keep and --restore-all
    // remain one-off operations. Package upgrades never own this file.
    if (restoring && !restoreAll) writeResident(residentFile, [...extras, ...restore], residentBefore);
    else if (only.length) writeResident(residentFile, extras.filter(name => !only.includes(name)), residentBefore);
    process.stdout.write(result.stdout || '');
    console.log('VERIFIED moved=' + moved.length);
    return 0;
  } catch (error) {
    const failed = [];
    for (const item of moved.reverse()) {
      try {
        assertTiers();
        if (fs.existsSync(item.from)) throw new Error('原位置出现其他内容');
        fs.renameSync(item.to, item.from);
      } catch { failed.push(item.name); }
    }
    failed.push(...rollbackFiles(applied, stage));
    preserve = failed.length > 0;
    console.error('TIER_FAILED: ' + error.message);
    console.error(failed.length ? '回滚未完成，请保留现场：' + failed.join(',') + '；恢复目录：' + stage : '目录迁移与本事务派生索引已回滚，其他写入者的选择与索引保留。');
    return 1;
  } finally { if (!preserve) fs.rmSync(stage, { recursive: true, force: true }); }
}

module.exports = { CORE, RESIDENT_FILE, readResident, writeResident, rememberResident };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error('TIER_ERROR: ' + error.message); process.exitCode = 2; }
}
