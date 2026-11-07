#!/usr/bin/env node
/**
 * 生成分享包的《Qoder-AI编码通用规则.md》：第一节 = 本机 AGENTS.md 逐字节；
 * 第二节 = rules/*.md（每篇一个 yaml 块 + 正文）；第三节 = 随包技能按域清单；
 * 第四节 = 沿用上一版文档的设计原则原文。顺带把 README 里的"制作端现场"计数改成实测值。
 * 用法：node pack-share-docs.cjs <包目录> [--name Qoder-Optimization] [--version 0.0.1] [--home <目录>] [--apply]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const HOME = os.homedir().replace(/\\/g, '/');
const out = process.argv[2];
const APPLY = process.argv.includes('--apply');
const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
if (!out) { console.error('用法：pack-share-docs.cjs <包目录> [--name 名称] [--version x.y.z] [--home 目录] [--apply]'); process.exit(2); }
const home = path.resolve(argValue('--home', HOME));
const DOC = path.join(out, 'Qoder-AI编码通用规则.md');
const agentsRaw = fs.readFileSync(path.join(home, '.qoder/AGENTS.md'), 'utf8').replace(/\r\n/g, '\n');
const agentsVer = (agentsRaw.match(/版本：([0-9.]+)/) || [, '0.0.0'])[1];
const ver = argValue('--version', agentsVer);
const packageName = argValue('--name', path.basename(out));
// 校验器口径：文档头已有 H1 与版本行，第一节正文不重复这两段
const agents = agentsRaw.replace(/^# .*\n+/, '').replace(/^> 版本：.*\n+/, '').trim();

const ruleDir = path.join(home, '.qoder/rules');
const ruleFiles = fs.readdirSync(ruleDir).filter(f => f.endsWith('.md')).sort();
const sec2 = ruleFiles.map(f => {
  const raw = fs.readFileSync(path.join(ruleDir, f), 'utf8').replace(/\r\n/g, '\n');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const body = (fm ? raw.slice(fm[0].length) : raw).trim();
  const title = (body.match(/^# (.+)$/m) || [, f.replace(/\.md$/, '')])[1].trim();
  const yaml = fm ? '```yaml\n' + fm[1].trim() + '\n```\n\n' : '';
  return '### ' + title + '\n\n' + yaml + body.replace(/^# .+$\n/m, '').trim() + '\n';
}).join('\n');

const man = JSON.parse(fs.readFileSync(path.join(out, 'skills-manifest.json'), 'utf8'));
const byTier = { core: [], library: [] };
for (const s of man.skills) byTier[s.tier].push(s.name);
const catOf = n => /^local-/.test(n) ? '领域专用（本机形态样例）' : /^(java|spring|python|node|vue|umi|rust|redis|rabbit|kafka|nginx|sql|oracle|postgres|polardb|db)/.test(n) ? '后端 / 数据'
  : /^(deploy|ship|verify|user-side|github|infra|windows|disk|clean|edge|pkg|cua|desktop|electron|office|docx|xlsx)/.test(n) ? '交付 / 运维 / 文档'
  : /^(skill|rules|memory|self-evolution|mechanize|goal|vibe|clarify|checkpoint|fact|structured|pause|concurrent|continuation|converge|local-skill)/.test(n) ? '规则与技能治理' : '其他';
const groups = {};
for (const s of man.skills) (groups[catOf(s.name)] = groups[catOf(s.name)] || []).push(s.name + (s.tier === 'core' ? '（常驻）' : ''));
const sec3 = Object.entries(groups).map(([k, v]) => '**' + k + '**（' + v.length + '）：' + v.sort().join('、')).join('\n\n') + '\n';
const shippedSkillLines = man.skills.slice().sort((a, b) => a.name.localeCompare(b.name)).map(s => {
  const p = path.join(out, 'skills', s.name, 'SKILL.md');
  const m = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').match(/^description: (.*)$/m) : null;
  const desc = m ? m[1].replace(/^"|"$/g, '').slice(0, 220) : '（无 description）';
  return `- \`${s.name}\`（${s.tier === 'core' ? '常驻' : '按需'}）—— ${desc}`;
});
const skillsList = [
  `# ${packageName} - ${ver} 技能清单`, '',
  `共 ${man.skills.length} 个源码随包技能：常驻 ${byTier.core.length} / 按需 ${byTier.library.length}。机器可读版见 \`skills-manifest.json\` 与 \`catalog.json\`。`,
  '', '**默认不全量安装**：先登记包，再按技术栈与任务用 `pkg-catalog.cjs search/install` 选择；`tier` 决定安装到常驻层还是按需库。',
  '', '## 源码随包', '', ...shippedSkillLines, '',
  '## 明确不随包', '',
  '- `polarmem0-memory`：强绑定另一台机器的服务与配置。',
  '- `uni-app-wechat-cicd`：含本机专有小程序标识，未做可证明无损的脱敏。',
  '- `clarify-ambiguous-request`：已由 `/clarify` 命令与 `rules/long-task.md` 的 A/B/C 判档完整承接，继续双轨会让“只优化提示词”与“顺带执行”口径冲突。', ''
].join('\n');

let sec4 = '（随包文档未含设计原则章节）\n';
try {
  const prev = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
  const i = prev.indexOf('## 四、背后的设计原则');
  if (i >= 0) sec4 = prev.slice(i).replace(/^## 四、背后的设计原则\s*/, '').trim() + '\n';
} catch { }

const doc = [
  `# ${packageName} - ${ver}`,
  '',
  '> 文档：Qoder AI 编码通用规则（可分享版）。',
  `> 版本：${ver}；制作日期：${new Date().toISOString().slice(0, 10)}。版本、计数与目录由公开包元数据同步；是否已发布以对应 Release 为准。`,
  `> 内容：全局开发纪律 + ${ruleFiles.length} 条领域 / 流程规则 + 可选能力目录。按使用者习惯取舍，不默认全装；材料不是授权来源。`,
  `> 制作端家用机实际装 ${man.skills.length} 个（${byTier.core.length} 常驻 + ${byTier.library.length} 按需），不等于随包或接收者已装数量。`,
  '> 先读《Qoder-个人规则生成提示词.md》；catalog.json/INDEX.md 提供按需检索。任何权限、MCP、hook 接线变更仍按平台要求单独批准。',
  '',
  '## 一、全局开发规则',
  '',
  agents,
  '',
  '## 二、领域规则',
  '',
  sec2,
  '## 三、推荐技能清单（按域速查）',
  '',
  sec3,
  '## 四、背后的设计原则',
  '',
  sec4,
].join('\n');

const i1 = doc.indexOf('## 一、全局开发规则'), i2 = doc.indexOf('## 二、领域规则');
const sec = doc.slice(i1 + '## 一、全局开发规则'.length, i2).trim();
const checks = [
  ['第一节与 AGENTS.md 逐字节一致', sec === agents],
  [`yaml 块数(${(doc.match(/```yaml/g) || []).length}) == rules 文件数(${ruleFiles.length})`, (doc.match(/```yaml/g) || []).length === ruleFiles.length],
  ['三反引号行成对', (doc.match(/^```/gm) || []).length % 2 === 0],
  ['含实测计数行', doc.includes(`家用机实际装 ${man.skills.length} 个`)],
  ['无空节', sec2.length > 2000 && sec3.length > 200],
];
console.log(`文档 ${doc.length} 字；rules=${ruleFiles.length}；技能=${man.skills.length}（常驻 ${byTier.core.length}）`);
checks.forEach(([k, v]) => console.log(`  ${v ? 'OK ' : 'RED'} ${k}`));
if (checks.some(([, v]) => !v)) process.exit(1);
if (APPLY) {
  fs.writeFileSync(DOC, doc);
  fs.writeFileSync(path.join(out, 'SKILLS-清单.md'), skillsList);
  const rd = path.join(out, 'README-安装说明.md');
  if (fs.existsSync(rd)) {
    let t = fs.readFileSync(rd, 'utf8');
    t = t.replace(/^# 安装说明/m, `# ${packageName} - ${ver} 安装说明`);
    t = t.replace(/\| `skills\/` \|[^\n]+/,
      '| `skills/` | 随包技能源码（每个子目录一份 `SKILL.md`，tier 见 manifest/catalog） | **默认不整目录复制**；先登记包，再按任务用 `pkg-catalog.cjs search/install` 选择 |');
    t = t.replace(/1\. 技能：[^\n]+/,
      '1. 技能：先运行 `node ~/.qoder/scripts/pkg-catalog.cjs register <分享包目录>` 登记包，再用 `search` 查找、`install <id>` 预演、明确需要后加 `--apply`；条目 `tier` 决定进 `skills/`（常驻）还是 `skills-library/`（按需）。**不要 `cp -r skills/*` 全量安装**。');
    t = t.replace(/安装时只放了常用那部分。[^\n]+：/,
      '包内收录经脱敏门验证的完整能力集，但安装时默认不全量复制；按技术栈和任务从 catalog 选择，以后用到别的也不用重新翻包：');
    t = t.replace(/制作端现场：\d+ 个技能（\d+ 常驻 \+ \d+ 按需）/, `制作端现场：${man.skills.length} 个技能（${byTier.core.length} 常驻 + ${byTier.library.length} 按需）`);
    t = t.replace(/(\d+) 条领域 \/ 流程规则/, `${ruleFiles.length} 条领域 / 流程规则`);
    fs.writeFileSync(rd, t);
  }
  const prompt = path.join(out, 'Qoder-个人规则生成提示词.md');
  if (fs.existsSync(prompt)) {
    let t = fs.readFileSync(prompt, 'utf8');
    t = t.replace(/^> 配套版本：[^\n]+/m, `> 配套包：${packageName} - ${ver}（${new Date().toISOString().slice(0, 10)}）；安装内容按接收者习惯选择，配置或来源索引不自动提供执行授权。`);
    fs.writeFileSync(prompt, t);
  }
  const verifyCmd = path.join(out, 'commands', 'verify-package.md');
  if (fs.existsSync(verifyCmd)) {
    let t = fs.readFileSync(verifyCmd, 'utf8');
    t = t.replace(/D:\/tmp\/qoder-pkg-xxx\/Qoder优化x\.y\.z/g, `D:/tmp/${packageName} - ${ver}`);
    fs.writeFileSync(verifyCmd, t);
  }
  console.log('APPLIED（规则文档 / README / 提示词 / 技能清单 / verify-package 示例已同步）');
} else console.log('DRY-RUN');
