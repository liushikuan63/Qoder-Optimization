'use strict';
const fs = require('fs');
const path = require('path');

function dependenciesFor(root, entry) {
  // First-party workflows name installed helpers, rather than shipping another
  // private copy inside the skill. Selecting the workflow includes its runtime.
  const skillRuntime = {
    'skill:parallel-orchestration': ['script:parallel-context.cjs', 'script:parallel-plan.cjs', 'script:parallel-write.cjs'],
    'skill:concurrent-edit-attribution-check': ['script:backup-file.js'],
    'skill:self-evolution': ['script:carrier-preflight.cjs'],
    'skill:skills-router': ['script:skill-load.cjs'],
    'skill:windows-powershell-from-gitbash': ['script:shell-boundary-probe.cjs'],
    'skill:windows-gitbash-command-safety': ['script:shell-boundary-probe.cjs'],
  };
  if (entry.category === 'skill') return skillRuntime[entry.id] || [];
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
