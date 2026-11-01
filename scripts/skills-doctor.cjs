'use strict';
// skills-doctor.cjs -- two-side skill consistency + quality gate (read-only by default)
// exit 0 = clean, 1 = red found, 2 = precondition failure
const fs = require('fs');
const path = require('path');

const HOME = (process.env.USERPROFILE || require('os').homedir()).replace(/\\/g, '/');
const DEFAULTS = {
  CN: path.join(HOME, '.qoder-cn/skills'),
  Q: path.join(HOME, '.qoder/skills'),
  RULES: [path.join(HOME, '.qoder-cn/AGENTS.md'), path.join(HOME, '.qoder/AGENTS.md')],
  RULEDIRS: [path.join(HOME, '.qoder-cn/rules'), path.join(HOME, '.qoder/rules')],
};
const DESC_MAX = 300;
// 载体技能（carrier）例外表：这类技能的 description 承担"路由线索"职责——删线索比多注入更糟
// （2026-10-22 实测：把 db-credential-auth-lock-safety 硬压到 298 字，跨通道计数、--clear 人工解除、
//  PreToolUse 覆盖面边界、RFC5737 探针、触发词、三条"不用于"全部丢失，被用户当场纠正）。
// 规则：**放宽长度上限，但换以逐条"线索必须存在"的硬判据**——DESC-CLUES 判红比 DESC-LONG 更贵。
// 新增载体条目时要写清为什么值得放宽，且 max 只按"当前实测 + 少量余量"给，不留空泛大数。
const DESC_CARRIERS = {
  'db-credential-auth-lock-safety': {
    max: 560,
    why: '凭据/防锁号入口技能，线索＝跨通道计数 + 锁定后禁止动作 + 人工解除命令 + 覆盖面边界 + 零风险探针 + 触发词 + 三条不用于',
    clues: ['不可见字符', 'CRLF', '满 3 次', '跨通道', '不算换目标', '禁止', '重连', '重启', '--clear', 'auth-lock-guard.js', '边界', '不硬拦', 'RFC5737', '192.0.2.1', '触发词', 'WRONGPASS', '535', 'Login failed', 'ORA-28000', '1045', 'invalid attempts', '不用于', 'postgresql', 'safe-text-editing', 'mechanize-rule-into-hook-guard'],
  },
  'skill-bundled-script-falsifiable-fix': {
    max: 650,
    why: '技能改脚本的取证式修复入口（2026-10-22 自 falsifiable-patch 降量迁移），线索＝六格可失败验收 + 并发改动补回 + .bak 迁出 + node-repl spawnSync 事实 + 四条"不含"',
    clues: ['取证式闭环', '判据升级', '变异验证', '备份落在包内', '并发改动', '独占路由线索', '复验不得只靠读代码', '被丢线索补回', 'backup-file.js', '.bak', 'skill-edit-backups', 'spawnSync', 'node --check', 'frontmatter', '触发词', '不含', 'skill-creator', 'mechanize-rule-into-hook-guard', 'falsifiable-partition-assertions', 'update-share-package'],
  },
  'mechanize-rule-into-hook-guard': {
    max: 460,
    why: 'hook 机制化的现役主流程载体（同域两份已并入），线索＝流水线八步各步名 + 触发词全表 + 覆盖面"不用于"指向',
    clues: ['carrier-preflight', 'core', 'PreToolUse', 'PostToolUse', '负对照', '变异验证', '台账', 'RFC5737', '两侧接线', '周检', '触发词', 'config-doctor', '事件×命令集合', '生成物被覆盖', '分发包落后', '假绿', '不用于', 'db-credential-auth-lock-safety', '连败三次', '停手上报', '机制化'],
  },
  'node-repl-isolated-subprocess-harness': {
    max: 820,
    why: '沙箱起不了子进程时的唯一取退出码通道，价值全在五条反直觉现场事实上；删任一条都会让后来者重新踩坑，故放宽长度但逐条钉死',
    clues: ['nodeRepl', 'tmpDir', 'ENOENT', 'require', 'already declared', 'var', 'spawnSync', '.out', 'SystemRoot', 'latin1', 'utf8', '假失败', '触发词', 'node_repl', '沙箱 Bash', '不用于', 'skill-bundled-script-falsifiable-fix', 'verify-before-claim', 'safe-text-editing', '强制权限', 'GBK/CRLF'],
  },
};
const BODY_MAX = 500;
// self-ref = bare "scripts|references|assets|templates/..." with no path prefix, no ~ and no <placeholder>/
// 扩展名放宽到 10 字符：`.conf.example` 曾被截成 `.conf.examp` 造成假悬空（2026-10-21）
const REF_RE = /(?<![\w./~><-])(?:scripts|references|assets|templates)\/[A-Za-z0-9_.\/-]*\.[A-Za-z0-9]{1,10}/g;
// cross-skill ref = "../<other-skill>/whatever"
const XREF_RE = /\.\.\/([a-z][a-z0-9-]+)\/[A-Za-z0-9_.\/-]*\.[A-Za-z0-9]{1,5}/g;
// adjudicated false positives (bare-path hits that are NOT files of the skill itself)
const WAIVERS = new Set([
  'CN|setup-windows-selfhosted-runner|scripts/check.sh', // generated into the user's repo CI, not shipped by the skill
  'Q|setup-windows-selfhosted-runner|scripts/check.sh',
  'CN|electron-asar-code-forensics|scripts/patch-hygiene.cjs', // prose pointer to sibling skill
  'Q|electron-asar-code-forensics|scripts/patch-hygiene.cjs',
  'CN|windows-powershell-scripting-safety|scripts/psdiag.cjs',
  'Q|windows-powershell-scripting-safety|scripts/psdiag.cjs',
  'CN|windows-ui-forensics-powershell|scripts/psdiag.cjs',
  'Q|windows-ui-forensics-powershell|scripts/psdiag.cjs',
  'CN|windows-desktop-keyboard-automation|scripts/capture-window.ps1', // lives in ~/.qoder/scripts, path is absolute in the body
  // 2026-10-21 审计裁定：以下四条是"全局脚本 / 任务包内脚本 / 示例文本"，不是技能自带文件
  'CN|merge-inbound-qoder-package|scripts/stop-gate.js', // 全局 ~/.qoder/scripts，正文是 cd "$HOME/.qoder" 后的相对路径
  'Q|merge-inbound-qoder-package|scripts/stop-gate.js',
  'CN|skill-reference-integrity-audit|scripts/derive-ids.cjs', // "输出示例"代码块里的格式样例
  'Q|skill-reference-integrity-audit|scripts/derive-ids.cjs',
  'CN|skill-reference-integrity-audit|scripts/old.cjs', // 悬空引用示例表格
  'Q|skill-reference-integrity-audit|scripts/old.cjs',
  'CN|skill-trim-with-capability-transfer|scripts/docx-surgery.js', // 指向 office-docs 技能的脚本
  'Q|skill-trim-with-capability-transfer|scripts/docx-surgery.js',
  'CN|vibecoding-batch-append|scripts/validate.mjs', // 任务包自带校验器
  'Q|vibecoding-batch-append|scripts/validate.mjs',
  'CN|vibecoding-batch-execution|scripts/check-wiki-refs.js', // 仓库自带校验器
  'Q|vibecoding-batch-execution|scripts/check-wiki-refs.js',
]);

function listDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name).sort();
}

function parse(md) {
  const lines = md.split(/\r?\n/);
  if (lines[0] !== '---') return { name: '', description: '', bodyLines: lines.length };
  let end = -1;
  for (let i = 1; i < Math.min(lines.length, 120); i++) if (lines[i] === '---') { end = i; break; }
  if (end < 0) return { name: '', description: '', bodyLines: lines.length };
  const fm = {};
  let key = null;
  for (const l of lines.slice(1, end)) {
    const m = l.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (m) { fm[m[1]] = m[2]; key = m[1]; continue; }
    if (/^\s+\S/.test(l) && key) fm[key] = (fm[key] + ' ' + l.trim()).trim();
  }
  const desc = (fm.description || '').replace(/^["']|["']$/g, '');
  return { name: (fm.name || '').trim(), description: desc, bodyLines: lines.length - (end + 1) };
}

function readCited(o) {
  const files = [];
  for (const f of o.RULES) if (fs.existsSync(f)) files.push(f);
  for (const d of o.RULEDIRS) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.md')) files.push(path.join(d, f));
  }
  const cited = new Set();
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/`([a-z][a-z0-9]+(?:-[a-z0-9]+){1,6})`/g)) cited.add(m[1]);
  }
  return cited;
}

function analyze(o) {
  const cnRoot = o.CN, qRoot = o.Q;
  const hasQ = fs.existsSync(qRoot), hasCn = fs.existsSync(cnRoot);
  if (!hasQ && !hasCn) throw new Error('no installed skill roots');
  const singleSide = hasQ && hasCn ? null : hasQ ? 'Q' : 'CN';
  const cn = listDirs(cnRoot), q = listDirs(qRoot);
  const knownQ = new Set(q), knownC = new Set(cn);
  const cited = [...readCited(o)].filter((n) => knownQ.has(n));
  const parity = !singleSide && o.parity !== false;
  const r = {
    counts: { cn: cn.length, q: q.length },
    parity, singleSide,
    missingInCn: singleSide ? [] : parity ? q.filter((n) => !knownC.has(n)) : cited.filter((n) => !knownC.has(n)),
    missingInIntl: parity ? cn.filter((n) => !knownQ.has(n)) : [],
    citedMissing: singleSide ? [] : cited.filter((n) => !knownC.has(n)),
    citedTotal: cited.length,
    drift: [], descLong: [], descClues: [], colonHazard: [], dangling: [], missingSibling: [], siblingSeeAlso: [], bodyLong: [], noSkillMd: [], bakLeftover: [], needsDeps: [],
  };
  for (const n of q) {
    const qp = path.join(qRoot, n, 'SKILL.md');
    if (!fs.existsSync(qp)) { r.noSkillMd.push('Q/' + n); continue; }
    const qtxt = fs.readFileSync(qp, 'utf8');
    if (cn.includes(n)) {
      const cp = path.join(cnRoot, n, 'SKILL.md');
      if (!fs.existsSync(cp)) { r.drift.push(n + ' (CN SKILL.md absent)'); continue; }
      if (fs.readFileSync(cp, 'utf8') !== qtxt) r.drift.push(n);
    }
  }
  for (const [side, root, names] of [['CN', cnRoot, cn], ['Q', qRoot, q]]) {
    for (const n of names) {
      const dir = path.join(root, n);
      const mdPath = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(mdPath)) {
        if (side === 'CN') r.noSkillMd.push(side + '/' + n);
        continue;
      }
      const md = fs.readFileSync(mdPath, 'utf8');
      const p = parse(md);
      const tag = side + '/' + n;
      const carrier = (o.carriers || DESC_CARRIERS)[n] || null;
      const cap = carrier ? carrier.max : DESC_MAX;
      if (p.description.length > cap) r.descLong.push(tag + ' (' + p.description.length + '>' + cap + (carrier ? ' 载体放宽后仍超' : '') + ')');
      if (carrier) {
        // 中文关键字一律用字面量比对（记忆 feedback-skill-description-trim-guardrails：
        // 用 Unicode 转义曾把「跨」写成「跳」，造出一次假红）
        const miss = carrier.clues.filter((k) => !p.description.includes(k));
        if (miss.length) r.descClues.push(tag + ' 丢失路由线索 ' + miss.length + ' 项：' + miss.join('、'));
      }
      if (/:\s/.test(p.description)) r.colonHazard.push(tag);
      if (p.bodyLines > BODY_MAX) r.bodyLong.push(tag + ' (' + p.bodyLines + ')');
      const refs = [...new Set(md.match(REF_RE) || [])];
      const bad = refs.filter((x) => !WAIVERS.has(side + '|' + n + '|' + x) && !fs.existsSync(path.join(dir, x)));
      if (bad.length) r.dangling.push(tag + ' -> ' + bad.join(', '));
      const seenX = new Set();
      for (const line of md.split(/\r?\n/)) {
        for (const m of line.matchAll(XREF_RE)) {
          if (fs.existsSync(path.join(root, m[1]))) continue;
          const key = side + '|' + n + '|' + m[1];
          if (seenX.has(key)) continue;
          seenX.add(key);
          const precond = /\b(must|without first|before you|required|prerequisite|ensure first)\b|必须|先完成|前置/i.test(line);
          (precond ? r.missingSibling : r.siblingSeeAlso).push(tag + ' -> ../' + m[1] + (precond ? ' (PRECONDITION, skill not installed)' : ' (see-also)'));
        }
      }
      const bak = fs.readdirSync(dir).filter((f) => /\.bak(\.|$)|\.orig$/.test(f));
      if (bak.length) r.bakLeftover.push(tag + ' (' + bak.length + ')');
    }
  }
  return r;
}

// Gates on per-turn injected cost and on files the CN client loads. The other client's own
// long descriptions are reported as INFO: hand-trimming upstream packs forks them from source.
const CN_ONLY_GATE = ['DESC-LONG', 'YAML-HAZARD'];
const cnGate = (list) => list.filter((s) => s.startsWith('CN/'));
const qualityGate = (r, list) => r.singleSide ? list.filter(s => s.startsWith(r.singleSide + '/')) : cnGate(list);

function isRed(r) {
  return r.missingInCn.length + r.missingInIntl.length + r.drift.length +
    qualityGate(r, r.descLong).length + qualityGate(r, r.colonHazard).length + r.descClues.length +
    r.dangling.length + r.missingSibling.length + r.noSkillMd.length > 0;
}

function report(r) {
  const L = [];
  L.push('SKILLS-DOCTOR  CN=' + r.counts.cn + '  INTL=' + r.counts.q + '  mode=' + (r.singleSide ? 'SINGLE-' + r.singleSide : r.parity ? 'FULL-PARITY' : 'CITED-ONLY') + '  cited-in-rules=' + r.citedTotal);
  const rows = [
    ['MISSING-IN-CN', r.missingInCn, r.parity ? 'skill exists only on the international side (full parity)' : 'rules cite a skill the CN client cannot load'],
    ['MISSING-IN-INTL', r.missingInIntl, 'skill exists only on the CN side - the international client cannot invoke it'],
    ['DRIFT', r.drift, 'same-name SKILL.md differs between sides'],
    ['DESC-LONG', r.descLong, 'description > ' + DESC_MAX + ' chars (per-turn injected cost；载体技能按 DESC_CARRIERS.max 判)'],
    ['DESC-CLUES', r.descClues, '载体技能声明的"独占路由线索"被删（瘦身红线：宁可长，不可删线索）'],
    ['YAML-HAZARD', r.colonHazard, 'description contains ASCII ": " (breaks skill_manage patch)'],
    ['DANGLING-REF', r.dangling, 'body points at a file that is not in the skill dir'],
    ['MISSING-SIBLING', r.missingSibling, 'body requires another skill that is not installed'],
    ['NO-SKILL-MD', r.noSkillMd, 'directory without SKILL.md'],
  ];
  for (const [k, v, why] of rows) {
    const gated = CN_ONLY_GATE.includes(k);
    const shown = gated ? qualityGate(r, v) : v;
    L.push((shown.length ? 'RED   ' : 'OK    ') + k + '=' + shown.length + '  # ' + why);
    shown.forEach((s) => L.push('        - ' + s));
    if (gated && v.length !== shown.length) L.push('INFO  ' + k + ' (other client only, not gated)=' + (v.length - shown.length));
  }
  L.push('INFO  BODY-LONG=' + r.bodyLong.length + ' over ' + BODY_MAX + ' lines (costs only on invoke; re-shaping upstream packs was out of scope this round)');
  r.bodyLong.forEach((s) => L.push('        - ' + s));
  L.push('INFO  SIBLING-SEEALSO=' + r.siblingSeeAlso.length + ' (dead see-also links into skills that are not installed)');
  L.push('INFO  BAK-LEFTOVER=' + r.bakLeftover.length + ' (kept on purpose as rollback points)');
  r.bakLeftover.forEach((s) => L.push('        - ' + s));
  L.push('VERDICT=' + (isRed(r) ? 'RED' : 'CLEAN'));
  return L.join('\n');
}

function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, ''); }

function copyTree(src, dst, skips) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    // node_modules is never copied: office-docs alone is 45 MB and the C-side skill dir must stay small;
    // SKILL.md carries the mirror-source install command, so deps are reproducible (recorded as NEEDS-DEPS).
    if (e.isDirectory() && e.name === 'node_modules') { if (skips) skips.push(dst); continue; }
    if (e.isDirectory()) copyTree(s, d, skips);
    else fs.copyFileSync(s, d);
  }
}

function applySync(o, r, dry) {
  const out = [];
  const bakRoot = path.join(o.CN, '..', '_skill-backups');
  const items = [];
  const label = (root) => (root === o.CN ? 'CN' : 'INTL');
  for (const n of r.missingInCn) items.push({ n, src: path.join(o.Q, n), dst: path.join(o.CN, n), from: label(o.Q), to: label(o.CN) });
  for (const n of r.missingInIntl) items.push({ n, src: path.join(o.CN, n), dst: path.join(o.Q, n), from: label(o.CN), to: label(o.Q) });
  for (const n of r.drift.map((s) => s.replace(/ \(.*\)$/, ''))) items.push({ n, src: path.join(o.Q, n), dst: path.join(o.CN, n), from: label(o.Q), to: label(o.CN) });
  const done = new Set();
  for (const it of items) {
    if (done.has(it.n + '|' + it.dst)) continue;
    done.add(it.n + '|' + it.dst);
    if (!fs.existsSync(path.join(it.src, 'SKILL.md'))) { out.push('SKIP  ' + it.n + ' (no source SKILL.md)'); continue; }
    if (fs.existsSync(it.dst)) {
      const bak = path.join(bakRoot, stamp(), it.to + '__' + it.n);
      out.push((dry ? 'WOULD BACKUP ' : 'BACKUP ') + bak);
      if (!dry) { fs.mkdirSync(path.dirname(bak), { recursive: true }); copyTree(it.dst, bak, null); }
    }
    const skips = [];
    out.push((dry ? 'WOULD COPY ' : 'COPIED ') + it.n + '  ' + it.from + '->' + it.to);
    if (!dry) { fs.rmSync(it.dst, { recursive: true, force: true }); copyTree(it.src, it.dst, skips); if (skips.length) out.push('  NEEDS-DEPS ' + it.n + ' (node_modules not copied; run the install line in its SKILL.md)'); }
  }
  return out;
}

function selftest() {
  const base = path.join(require('os').tmpdir(), 'skills-doctor-selftest-' + process.pid);
  const Q = path.join(base, 'q'), CN = path.join(base, 'cn'), RULE = path.join(base, 'AGENTS.md');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(Q, { recursive: true }); fs.mkdirSync(CN, { recursive: true });
  const mk = (root, name, desc, body) => {
    const d = path.join(root, name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n' + body + '\n');
  };
  fs.writeFileSync(RULE, 'use `alpha-kit` and `beta-kit` here\n');
  mk(Q, 'alpha-kit', 'short desc', 'run scripts/x.sh');
  fs.mkdirSync(path.join(Q, 'alpha-kit', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(Q, 'alpha-kit', 'scripts', 'x.sh'), 'echo ok\n');
  copyTree(path.join(Q, 'alpha-kit'), path.join(CN, 'alpha-kit'));
  mk(Q, 'beta-kit', 'long '.repeat(70), 'body');
  const o = { CN, Q, RULES: [RULE], RULEDIRS: [] };
  const res = [];
  const a1 = analyze(o);
  res.push(['fixture has both skills', a1.counts.q === 2 && a1.counts.cn === 1]);
  res.push(['NEG1 missing-in-cn detected', a1.missingInCn.includes('beta-kit')]);
  res.push(['NEG2 dangling ref NOT false-positive', !a1.dangling.some((s) => s.includes('alpha-kit'))]);
  res.push(['NEG3 desc-long detected', a1.descLong.some((s) => s.includes('beta-kit'))]);
  // 载体放宽 + 线索保全判据：必须**双向可失败**（只会在删线索时红，不会恒红也不会恒绿）
  const aCl = analyze({ ...o, carriers: { 'alpha-kit': { max: 100, clues: ['short', 'desc'] } } });
  res.push(['NEG5 carrier allowance: 放宽后不判长且线索齐全不判红',
    !aCl.descLong.some((s) => s.includes('alpha-kit')) && !aCl.descClues.some((s) => s.includes('alpha-kit'))]);
  const aCl2 = analyze({ ...o, carriers: { 'alpha-kit': { max: 100, clues: ['short', '被删掉的路由线索'] } } });
  res.push(['NEG6 声明的线索被删时必须判红并点名',
    aCl2.descClues.some((s) => s.includes('alpha-kit') && s.includes('被删掉的路由线索'))]);
  fs.rmSync(path.join(CN, 'alpha-kit', 'SKILL.md'));
  mk(CN, 'alpha-kit', 'short desc', 'run scripts/x.sh edited');
  const a2 = analyze(o);
  res.push(['NEG4 drift detected after body edit', a2.drift.includes('alpha-kit')]);
  fs.writeFileSync(path.join(CN, 'alpha-kit', 'SKILL.md'), fs.readFileSync(path.join(Q, 'alpha-kit', 'SKILL.md'), 'utf8'));
  const a3 = analyze(o);
  res.push(['POS drift clears after restore', !a3.drift.includes('alpha-kit')]);
  res.push(['POS verdict still red only from missing beta', a3.missingInCn.length === 1 && a3.drift.length === 0]);
  const applied = applySync(o, a3, true);
  res.push(['NEG5 dry-run apply lists exactly one copy', applied.filter((s) => /WOULD COPY beta-kit/.test(s)).length === 1 && fs.existsSync(path.join(CN, 'beta-kit')) === false]);
  const applied2 = applySync(o, analyze(o), false);
  res.push(['POS apply copies and re-check clean on that item', applied2.some((s) => /COPIED beta-kit/.test(s)) && analyze(o).missingInCn.length === 0]);
  // phase 2: ref predicates (tightened) — must catch true dangling, must not re-invent false positives
  mk(Q, 'gamma-kit', 'desc', 'node scripts/nope.cjs\nsee ../delta-kit/references/x.md\nyou must read ../zeta-kit/references/gate.md before uploading\nuse ~/.qoder/scripts/there.ps1 and <placeholder>/scripts/other.cjs and cloudbase-platform/references/y.md\n');
  const a4 = analyze(o);
  res.push(['NEG6 real dangling ref caught', a4.dangling.some((s) => s.includes('gamma-kit') && s.includes('scripts/nope.cjs'))]);
  res.push(['NEG7 see-also sibling ref is INFO not RED', a4.siblingSeeAlso.some((s) => s.includes('delta-kit')) && !a4.missingSibling.some((s) => s.includes('delta-kit'))]);
  res.push(['NEG10 precondition sibling ref is RED', a4.missingSibling.some((s) => s.includes('zeta-kit'))]);
  res.push(['POS8 prefixed paths not flagged', !a4.dangling.some((s) => /there\.ps1|other\.cjs|y\.md/.test(s))]);
  mk(Q, 'delta-kit', 'desc', 'body');
  res.push(['POS9 sibling ref clears once installed', !analyze(o).siblingSeeAlso.some((s) => s.includes('delta-kit'))]);
  res.push(['NEG11 gate only counts the visible side', cnGate(['Q/x (350)', 'CN/y (320)']).length === 1 && cnGate(['Q/x (350)']).length === 0]);
  const rep = report(analyze(o));
  res.push(['POS12 other-client items reported as INFO', /INFO  DESC-LONG \(other client only/.test(rep)]);
  mk(CN, 'zulu-cn-only', 'desc', 'body');
  const a6 = analyze(o);
  res.push(['NEG13 reverse gap reported (intl client cannot invoke CN-only)', a6.missingInIntl.includes('zulu-cn-only') && isRed(a6)]);
  const a7 = analyze({ ...o, parity: false });
  res.push(['POS14 cited-only mode ignores uncited gaps', !a7.missingInCn.includes('gamma-kit') && a7.missingInIntl.length === 0]);
  fs.rmSync(base, { recursive: true, force: true });
  let fail = 0;
  for (const [name, ok] of res) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) fail++; }
  console.log('SELFTEST ' + res.length + ' checks, ' + fail + ' failed');
  return fail ? 1 : 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest') process.exit(selftest());
  const o = { ...DEFAULTS, parity: !argv.includes('--cited-only') };
  let r;
  try { r = analyze(o); } catch (e) { console.log('ERROR ' + e.message); process.exit(2); }
  if (argv.includes('apply-sync')) {
    const dry = !argv.includes('--apply');
    console.log(report(r));
    console.log('--- apply-sync ' + (dry ? '(DRY RUN)' : '(APPLIED)') + ' ---');
    applySync(o, r, dry).forEach((l) => console.log(l));
    if (!dry) { r = analyze(o); console.log('--- re-check ---'); console.log('MISSING-IN-CN=' + r.missingInCn.length + ' MISSING-IN-INTL=' + r.missingInIntl.length + ' DRIFT=' + r.drift.length); }
    process.exit(isRed(r) ? 1 : 0);
  }
  console.log(report(r));
  process.exit(isRed(r) ? 1 : 0);
}
main();
