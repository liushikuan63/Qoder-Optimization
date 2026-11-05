#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
function visibleText(text) {
  let fence = null;
  return text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).filter(line => {
    const mark = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (mark) {
      if (!fence) fence = { char: mark[1][0], size: mark[1].length };
      else if (mark[1][0] === fence.char && mark[1].length >= fence.size && !mark[2].trim()) fence = null;
      return false;
    }
    return !fence;
  }).join('\n');
}
function references(text) {
  text = visibleText(text);
  const refs = new Map();
  const add = (raw, link) => {
    if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw) || /[<>\u0000-\u001f]/.test(raw)) return;
    let ref; try { ref = decodeURIComponent(raw.split(/[?#]/)[0]); } catch { throw new Error('INVALID_REFERENCE_ENCODING'); }
    if (!ref || /[<>\u0000-\u001f]/.test(ref)) return;
    if (link || /^(?:\.\.\/|\.\/)*(?:scripts|references|assets)\//u.test(ref)) refs.set((link ? 'link\0' : 'path\0') + ref, { ref, link });
  };
  // A link is relative to its document. Do not reinterpret its target as a
  // root-relative prose path, which could hide a genuinely missing child.
  text = text.replace(/\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)\n]+)(?:\s+["'][^\n]*["'])?\s*\)/gu, (match, raw) => { add(raw.replace(/^<|>$/g, ''), true); return ' '.repeat(match.length); });
  text = text.replace(/`([^`\n]+)`/gu, (match, raw) => { add(raw, false); return ' '.repeat(match.length); });
  for (const m of text.matchAll(/(?:^|[\s(])((?:\.\.\/|\.\/)*(?:scripts|references|assets)\/[^\s`<>"'()，。；,;]+\.[\p{L}\p{N}]+)(?=$|[\s),;，。；])/gmu)) add(m[1], false);
  return [...refs.values()];
}
function scan(directory) {
  const root = fs.realpathSync.native(directory), rootStat = fs.statSync(root, { bigint: true });
  if (!rootStat.isDirectory()) throw new Error('NOT_DIRECTORY');
  const result = { root, existing: [], missing: [], errors: [], filesScanned: 0, refsScanned: 0 };
  const existing = new Set(), missing = new Set(), visited = new Set(), pending = [path.join(root, 'SKILL.md')];
  function ordinary(file) {
    if (!inside(root, file)) throw new Error('REFERENCE_OUTSIDE_SKILL');
    const nowRoot = fs.statSync(directory, { bigint: true });
    if (nowRoot.ino !== rootStat.ino || nowRoot.dev !== rootStat.dev || fs.realpathSync.native(directory) !== root) throw new Error('SKILL_ROOT_CHANGED');
    let cursor = root;
    const chain = [];
    for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      let s; try { s = fs.lstatSync(cursor, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
      if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error('REFERENCE_LINK_OR_SPECIAL_FILE');
      if (!inside(root, fs.realpathSync.native(cursor))) throw new Error('REFERENCE_OUTSIDE_SKILL');
      const after = fs.lstatSync(cursor, { bigint: true });
      if (after.isSymbolicLink() || s.dev !== after.dev || s.ino !== after.ino) throw new Error('REFERENCE_CHANGED');
      chain.push({ file: cursor, stat: s });
    }
    // Assets are existence-checked without opening their content. Revalidate
    // their parent chain too, rather than accepting a leaf reached by a race.
    for (const item of chain.reverse()) {
      const current = fs.lstatSync(item.file, { bigint: true });
      if (current.isSymbolicLink() || current.dev !== item.stat.dev || current.ino !== item.stat.ino || !inside(root, fs.realpathSync.native(item.file))) throw new Error('REFERENCE_CHANGED');
    }
    const finalRoot = fs.statSync(directory, { bigint: true });
    if (finalRoot.dev !== rootStat.dev || finalRoot.ino !== rootStat.ino || fs.realpathSync.native(directory) !== root) throw new Error('SKILL_ROOT_CHANGED');
    return (chain[0]?.stat || rootStat).isFile();
  }
  function read(file) {
    if (!ordinary(file)) throw new Error('MARKDOWN_NOT_FOUND');
    const before = fs.lstatSync(file, { bigint: true });
    if (before.size > 1048576n) throw new Error('MARKDOWN_TOO_LARGE');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
      if (!ordinary(file) || !same(before, opened) || !same(opened, fs.lstatSync(file, { bigint: true }))) throw new Error('MARKDOWN_CHANGED');
      const bytes = fs.readFileSync(fd);
      if (!ordinary(file) || !same(opened, fs.fstatSync(fd, { bigint: true })) || !same(opened, fs.lstatSync(file, { bigint: true }))) throw new Error('MARKDOWN_CHANGED');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { fs.closeSync(fd); }
  }
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (visited.size > 1024) { result.errors.push({ code: 'DOCUMENT_LIMIT' }); break; }
    try {
      const refs = references(read(file)); result.filesScanned++;
      for (const { ref, link } of refs) {
        result.refsScanned++;
        if (result.refsScanned > 4096) throw new Error('REFERENCE_LIMIT');
        const candidates = [path.resolve(path.dirname(file), ref)];
        if (!link && /^(?:scripts|references|assets)\//.test(ref)) candidates.push(path.resolve(root, ref));
        let target = null;
        for (const candidate of candidates) if (ordinary(candidate)) { target = candidate; break; }
        if (target) {
          existing.add(path.relative(root, target).split(path.sep).join('/'));
          if (/\.md$/i.test(target)) pending.push(target);
        } else missing.add(ref);
      }
    } catch (error) { result.errors.push({ from: path.relative(root, file).split(path.sep).join('/'), code: error.code || error.message }); }
  }
  result.existing = [...existing].sort(); result.missing = [...missing].sort();
  return result;
}
function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log('Usage: node audit-references.cjs <skill-directory> [...directories]\nExit 0: checked references exist; 1: missing; 2: invalid, unreadable or unsafe input. Zero references is not full semantic verification.'); return 0; }
  if (!args.length || args.length > 32 || args.some(x => x.startsWith('--'))) throw new Error('USAGE');
  const results = args.map(directory => { try { return scan(path.resolve(directory)); } catch (error) { return { root: path.resolve(directory), existing: [], missing: [], errors: [{ code: error.code || error.message }] }; } });
  console.log(JSON.stringify(results.length === 1 ? results[0] : { results }, null, 2));
  return results.some(x => x.errors.length) ? 2 : results.some(x => x.missing.length) ? 1 : 0;
}
module.exports = { scan, references, main };
if (require.main === module) { try { process.exitCode = main(process.argv.slice(2)); } catch { console.error('REFERENCE_AUDIT_ERROR: invalid input'); process.exitCode = 2; } }
