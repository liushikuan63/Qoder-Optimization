'use strict';
const fs = require('fs');
const path = require('path');
const { archiveEntries } = require('./archive-entries.cjs');
const { clientRoot } = require('./client-root.js');

function importMemory(file, root, apply = false) {
  const entries = archiveEntries(file, fs.readFileSync(file));
  if (!entries) throw new Error('需要 tar.gz、tgz 或 zip 记忆归档');
  const indexes = entries.filter(e => e.name === 'MEMORY.md' || /^qoder-memory-export-[^/]+\/MEMORY\.md$/.test(e.name));
  if (indexes.length !== 1) throw new Error('归档必须只有一个记忆根目录及 MEMORY.md');
  const prefix = indexes[0].name.slice(0, -'MEMORY.md'.length);
  const memory = path.join(root, 'memory');
  const plan = entries.filter(e => e.name.startsWith(prefix)).map(e => ({ ...e, name: e.name.slice(prefix.length) }))
    .filter(e => /^[^/]+\.md$/.test(e.name) && e.name !== 'CREDENTIALS-TEMPLATE.md');
  for (const e of plan) {
    e.target = path.join(memory, e.name);
    if (fs.existsSync(e.target) && (fs.lstatSync(e.target).isSymbolicLink() || !fs.readFileSync(e.target).equals(e.data))) {
      throw new Error('现有文件与导入内容冲突，请先按三方合并流程裁决：' + e.name);
    }
  }
  const fresh = plan.filter(e => !fs.existsSync(e.target));
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', files: fresh.map(e => e.name), unchanged: plan.length - fresh.length }));
  if (!apply || !fresh.length) return;
  if (fs.existsSync(memory) && fs.lstatSync(memory).isSymbolicLink()) throw new Error('记忆目标不能是符号链接');
  fs.mkdirSync(memory, { recursive: true });
  const stage = fs.mkdtempSync(path.join(memory, '.import-memory-'));
  const written = [];
  try {
    // Keep complete input bytes until publication and rollback have finished.
    // Staging failures never expose a partial final memory file.
    for (const e of fresh) {
      e.staged = path.join(stage, e.name);
      fs.writeFileSync(e.staged, e.data, { flag: 'wx' });
      if (!fs.readFileSync(e.staged).equals(e.data)) throw new Error('导入暂存字节校验失败');
    }
    for (const e of fresh) {
      const fd = fs.openSync(e.target, 'wx');
      try {
        const stat = fs.fstatSync(fd);
        const owned = { target: e.target, ino: stat.ino, dev: stat.dev, data: e.data, bytes: 0 };
        written.push(owned);
        // Record each successful write before the next one can fail. A disk-full
        // error may leave a prefix, which belongs to this transaction only while
        // both its file identity and confirmed bytes still match.
        while (owned.bytes < e.data.length) {
          const count = fs.writeSync(fd, e.data, owned.bytes, e.data.length - owned.bytes, null);
          if (!Number.isInteger(count) || count <= 0 || count > e.data.length - owned.bytes) throw new Error('导入写入未取得进展');
          owned.bytes += count;
        }
      } finally { fs.closeSync(fd); }
      if (!fs.readFileSync(e.target).equals(e.data)) throw new Error('导入字节校验失败');
    }
    fs.rmSync(stage, { recursive: true, force: true });
  } catch (error) {
    const conflicts = [];
    for (const owned of written.reverse()) {
      try {
        const stat = fs.lstatSync(owned.target);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.ino !== owned.ino || stat.dev !== owned.dev
            || !fs.readFileSync(owned.target).equals(owned.data.subarray(0, owned.bytes))) {
          conflicts.push(owned.target); continue;
        }
        fs.unlinkSync(owned.target);
      } catch (rollbackError) {
        if (rollbackError.code !== 'ENOENT') conflicts.push(owned.target);
      }
    }
    if (conflicts.length) {
      try {
        fs.writeFileSync(path.join(stage, 'RECOVERY.json'), JSON.stringify({
          sourceArchive: path.resolve(file), firstError: { message: error.message, code: error.code || null },
          conflicts,
        }, null, 2) + '\n', { flag: 'wx' });
      } catch {} // A full disk must not hide the original failure or recovery path.
      error.message += '；回滚遇到并发变更或无法安全删除的文件，已保留目标；恢复资料：' + stage;
    } else {
      try { fs.rmSync(stage, { recursive: true, force: true }); }
      catch { error.message += '；暂存目录未能清理，恢复资料：' + stage; }
    }
    throw error;
  }
}

module.exports = { importMemory };
if (require.main === module) {
  try {
    const args = process.argv.slice(2), file = args.shift();
    let apply = false, root = clientRoot();
    while (args.length) {
      const flag = args.shift();
      if (flag === '--apply') apply = true;
      else if (flag === '--client-root') {
        const value = args.shift();
        if (!value || !value.trim() || value.startsWith('-')) throw new Error('--client-root 需要一个明确目录路径');
        root = path.resolve(value);
      }
      else throw new Error('未知或缺值参数');
    }
    if (!file) throw new Error('用法：node import-memory.cjs <归档> [--client-root <客户端目录>] [--apply]');
    importMemory(path.resolve(file), root, apply);
  } catch (error) { console.error('IMPORT_FAILED: ' + error.message); process.exitCode = 2; }
}
