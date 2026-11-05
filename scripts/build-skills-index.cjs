#!/usr/bin/env node
// 重建技能索引：扫描 ~/.qoder/skills（常驻）与 ~/.qoder/skills-library（按需），写 skills-index.json
const fs = require('fs');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
const os = require('os');
let roots; try { roots = require('./capability-roots.cjs'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const Q = CLIENT_ROOT;
const SRC = [['core', path.join(Q, 'skills')], ['library', path.join(Q, 'skills-library')]];
const OUT = path.join(Q, 'skills-index.json');

function desc(p, root, bindings) {
  const t = roots ? roots.readFileWithin(root, p, bindings).toString('utf8') : fs.readFileSync(p, 'utf8');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const d = m[1].match(/^description:([\s\S]*?)(?=\r?\n[A-Za-z_][\w-]*:|(?![\s\S]))/m);
  return d ? d[1].trim().replace(/^\|\s*/, '').replace(/\s+/g, ' ').replace(/^"|"$/g, '') : '';
}

// root 可显式指定：检索与每轮发现必须查询调用方绑定的客户端，不能落到默认一侧。
function collectSkills(root = Q, options = {}) {
  const entries = [];
  const names = new Set(), candidates = [], ambiguous = new Set();
  const bindings = roots ? (options.bindings === undefined ? roots.readBindings(root) : options.bindings ? roots.validateBindings(root, options.bindings) : null) : null;
  const sources = root === Q ? SRC : [['core', path.join(root, 'skills')], ['library', path.join(root, 'skills-library')]];
  const ordinary = (file, directory) => {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile());
  };
  for (const [tier, dir] of sources) {
    // Discovery must not read through a linked tier/skill/entry into unrelated
    // files. Ignore only the unsafe entry so ordinary local skills still route.
    const resolved = roots ? roots.resolveTier(root, path.basename(dir), bindings) : ordinary(dir, true) ? dir : null;
    if (!resolved || !fs.existsSync(resolved)) continue;
    for (const d of fs.readdirSync(dir)) {
      if (!ordinary(path.join(dir, d), true)) continue;
      const p = path.join(dir, d, 'SKILL.md');
      if (!ordinary(p, false)) continue;
      const key = d.toLowerCase();
      if (names.has(key)) { if (!bindings && !options.quarantineAmbiguous) throw new Error('两层技能重名，需核对真源后再建索引；重复项：' + d); ambiguous.add(key); }
      names.add(key);
      candidates.push({ name: d, tier, path: p.split(path.sep).join('/') });
    }
  }
  // Quarantine both ambiguous copies before reading either description. A
  // migrated library must not hide unrelated skills or silently select a tier.
  for (const item of candidates) if (!ambiguous.has(item.name.toLowerCase())) { if (roots && !roots.ordinaryWithin(root, item.path, false, bindings)) continue; entries.push({ ...item, description: desc(item.path, root, bindings) }); }
  Object.defineProperty(entries, 'diagnostics', { value: [...ambiguous].sort().map(name => ({ code: 'AMBIGUOUS_SKILL_QUARANTINED', name })), enumerable: false });
  return entries.sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name));
}

module.exports = { collectSkills };
if (require.main === module) {
  try {
    const entries = collectSkills();
    fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), count: entries.length, entries, diagnostics: entries.diagnostics }, null, 1));
    console.log('index=' + entries.length + ' core=' + entries.filter((e) => e.tier === 'core').length + ' library=' + entries.filter((e) => e.tier === 'library').length);
    console.log(OUT);
  } catch (error) {
    console.error('INDEX_ERROR: ' + error.message);
    process.exitCode = 2;
  }
}
