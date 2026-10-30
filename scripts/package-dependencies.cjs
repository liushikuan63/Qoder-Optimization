'use strict';
const fs = require('fs');
const path = require('path');

function dependenciesFor(root, entry) {
  if (entry.category !== 'script' || entry.install?.mode === 'copy-directory' || !/\.[cm]?js$/.test(entry.source || '')) return [];
  const source = path.join(root, entry.source);
  const text = fs.readFileSync(source, 'utf8');
  const ids = new Set();
  for (const match of text.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
    let file;
    try { file = require.resolve(path.resolve(path.dirname(source), match[1])); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      if (!/\.test\.[cm]?js$/.test(source)) throw new Error('包内缺少脚本依赖：' + path.basename(match[1]));
      continue;
    }
    const relative = path.relative(path.resolve(root, 'scripts'), file);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('依赖路径越界');
    ids.add('script:' + relative.split(path.sep)[0]);
  }
  for (const match of text.matchAll(/path\.join\((?:__dirname|SCRIPTS),\s*['"]([A-Za-z0-9_.-]+\.(?:cjs|js|sh))['"]\)/g)) {
    const file = path.join(root, 'scripts', match[1]);
    if (fs.existsSync(file)) ids.add('script:' + match[1]);
    else if (!/\.test\.[cm]?js$/.test(source)) throw new Error('包内缺少运行依赖：' + match[1]);
  }
  for (const match of text.matchAll(/resolveSkillFile\(['"]([a-z0-9-]+)['"]/g)) ids.add('skill:' + match[1]);
  ids.delete(entry.id);
  return [...ids].sort();
}

module.exports = { dependenciesFor };
