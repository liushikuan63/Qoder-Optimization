'use strict';
// 触发短语唯一性校验器（T-07 / F8 / A2）。
// 判据是「归一后精确相等」，不是 skill-collisions.cjs 的「共享区分性词 ≥12 且占比 ≥22%」模糊阈值——
// 后者对单个短语重复结构上不可能命中，会给出假绿读数。
// 覆盖面是仓库全量技能（skills/*/SKILL.md），不是现役常驻集。
const fs = require('node:fs');
const path = require('node:path');
const { parseDescription } = require('./skill-description.cjs');

const TRIGGER_MARKER = /触发(?:词|短语)?\s*[:：]/;
const SEGMENT_END = /。|不用于|也用于|改用|参见|Not for|Use instead|See also/;
const SEPARATOR = /[、，,;；]/;

function normalizePhrase(value) {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

// 只取「触发词：」段落里的短语；「不用于 / 也用于」之后的排除项不是触发线索，不参与重复判定。
function triggerPhrases(description) {
  const text = String(description || '');
  const marker = TRIGGER_MARKER.exec(text);
  if (!marker) return [];
  const rest = text.slice(marker.index + marker[0].length);
  const end = rest.search(SEGMENT_END);
  const segment = end < 0 ? rest : rest.slice(0, end);
  return [...new Set(segment.split(SEPARATOR).map(normalizePhrase).filter(Boolean))];
}

function skillFiles(root) {
  const dir = path.join(root, 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(dir, entry.name, 'SKILL.md'))
    .filter(file => fs.existsSync(file))
    .sort();
}

function scan(root) {
  const files = skillFiles(root);
  const byPhrase = new Map();
  const skills = [];
  let withTriggerSegment = 0;
  let phraseCount = 0;
  const parseErrors = [];
  for (const file of files) {
    const name = path.basename(path.dirname(file));
    let description = '';
    try { description = parseDescription(fs.readFileSync(file, 'utf8')); }
    catch (error) { parseErrors.push({ skill: name, code: error.message }); }
    const phrases = triggerPhrases(description);
    if (phrases.length) withTriggerSegment++;
    phraseCount += phrases.length;
    skills.push({ skill: name, phrases });
    for (const phrase of phrases) {
      if (!byPhrase.has(phrase)) byPhrase.set(phrase, []);
      byPhrase.get(phrase).push(name);
    }
  }
  const duplicates = [...byPhrase.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([phrase, owners]) => ({ phrase, skills: owners.sort() }))
    .sort((a, b) => a.phrase.localeCompare(b.phrase));
  return {
    root: path.resolve(root),
    skills: files.length,
    withTriggerSegment,
    phrases: phraseCount,
    uniquePhrases: byPhrase.size,
    duplicateGroups: duplicates.length,
    duplicates,
    parseErrors,
    entries: skills,
  };
}

function main(argv) {
  const root = path.resolve(__dirname, '..');
  let scanRoot = root;
  let asJson = false;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') asJson = true;
    else if (arg === '--list') list = true;
    else if (arg === '--root') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) { console.error('INVALID_ARGUMENT: --root 需要目录'); return 2; }
      scanRoot = path.resolve(value);
    } else { console.error('INVALID_ARGUMENT: ' + arg); return 2; }
  }
  const result = scan(scanRoot);
  if (asJson) {
    const { entries, ...summary } = result;
    console.log(JSON.stringify(list ? result : summary, null, 1));
  } else {
    console.log(`skills=${result.skills} withTriggerSegment=${result.withTriggerSegment} phrases=${result.phrases} uniquePhrases=${result.uniquePhrases} duplicateGroups=${result.duplicateGroups}`);
    for (const item of result.duplicates) console.log(`DUP ${item.phrase} :: ${item.skills.join(' | ')}`);
    for (const item of result.parseErrors) console.log(`PARSE_ERROR ${item.skill} :: ${item.code}`);
    if (list) for (const item of result.entries) console.log(`  ${item.skill} :: ${item.phrases.join(' / ')}`);
  }
  return result.duplicateGroups || result.parseErrors.length ? 1 : 0;
}

module.exports = { scan, triggerPhrases, normalizePhrase, skillFiles };
if (require.main === module) process.exitCode = main(process.argv.slice(2));