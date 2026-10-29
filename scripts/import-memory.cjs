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
  const written = [];
  try {
    for (const e of fresh) {
      fs.writeFileSync(e.target, e.data, { flag: 'wx' });
      written.push(e.target);
      if (!fs.readFileSync(e.target).equals(e.data)) throw new Error('导入字节校验失败');
    }
  } catch (error) {
    for (const file of written.reverse()) fs.unlinkSync(file);
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
      else if (flag === '--client-root' && args.length) root = path.resolve(args.shift());
      else throw new Error('未知或缺值参数');
    }
    if (!file) throw new Error('用法：node import-memory.cjs <归档> [--client-root <客户端目录>] [--apply]');
    importMemory(path.resolve(file), root, apply);
  } catch (error) { console.error('IMPORT_FAILED: ' + error.message); process.exitCode = 2; }
}
