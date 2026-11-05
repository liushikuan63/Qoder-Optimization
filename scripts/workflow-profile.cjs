'use strict';
// Portable defaults are deliberately separate from the author's live profile.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const HOOKS = [
  ['UserPromptSubmit', 'session-budget.js', 10],
  ['UserPromptSubmit', 'fact-ledger.cjs', 10, undefined, ['--hook']],
  ['Stop', 'stop-gate.js', 15],
  ['SessionStart', 'global-config-guard.js', 15],
  ['SessionStart', 'session-budget.js', 10],
  ['PreToolUse', 'edit-guard.js', 10],
  ['PreToolUse', 'huge-output-guard.js', 10],
  ['PreToolUse', 'commit-scope-guard.js', 10],
  ['PreToolUse', 'cua-cursor-guard.js', 10],
  ['PreToolUse', 'risky-match-guard.js', 10],
  ['PreToolUse', 'win-path-guard.js', 10, '^Bash$'],
  ['PostToolUse', 'cua-cursor-guard.js', 10],
  ['PostToolUse', 'auth-lock-guard.js', 10],
  ['PostToolUse', 'attempt-lock-guard.js', 10, '^Bash$'],
  ['PostToolUse', 'tool-payload-guard.js', 10, '^Bash$|^Read$|^Agent$|^Task$|mcp_call'],
];
const CORE_SKILLS = ['concurrent-edit-attribution-check', 'continuation-state-audit', 'goal-driven-execution', 'safe-text-editing', 'self-evolution', 'ship-clean-pr', 'skills-router', 'structured-edit-safety', 'verify-before-claim', 'verify-ui-in-browser', 'vibe-coding-workflow', 'vibecoding-doc'];
const COMPLETE_IDS = [...new Set(['script:run-package-hook.cjs', 'script:workflow-profile.cjs', 'script:work-queue-check.js', 'command:checkpoint', 'command:fact', ...HOOKS.map(hook => 'script:' + hook[1]), ...CORE_SKILLS.map(name => 'skill:' + name)])];
const RULES = {
  'AGENTS.md': `# 分享包通用工作流
当前用户要求、平台约束和项目约定优先；本段不扩大授权。已有个人细则继续保留。
- 默认简体中文，行动请求持续完成检查、实现、验证和交付；缺非关键细节自行选合理值。只读审查只交付报告，不写文件或顺带接手旧待办。
- 开工先检查实际仓库、工具链、Git 状态和已有任务归属；保护他人未提交修改，不 reset、stash、clean 或整仓暂存。
- 工具按当前步骤定向检索名称/描述，仅读取必要 schema 和参考片段；能力不足再扩检，不反复转储全部工具、环境或日志。检查真实解释器、锁定版本和 argv；Git Bash、WSL、PowerShell 5.1/7 不互换，不为任务改全局工具链。
- 按当前任务检索已装 skills 与 skills-library，读取真实入口后采用适用步骤。已明确选择或必要调用直接使用；待选择的相关能力说明用途并询问，拒绝后不催问。
- 安装包先核对已装/缺失；只有与可信旧包逐字节一致的旧副本可更新，本地定制保留审查。缺失通用/明确偏好的能力才问安装，专业且无关的跳过；本次选择不静默成为长期偏好。
- 目标仅在用户或系统/开发者明确要求时创建，已有目标不重建。并行先分析依赖、授权和唯一写入权；共享文件/生成物串行，写入使用隔离工作树和逐提交范围核验，实际集成后再验收。
- 先定位原因再最小修复。完成主张须有本轮可失败证据；测试、构建、真实流程按影响选择，跳过/前置缺失/模拟数据/原生实测分别说明。UI 与实体包需要实际运行验收。
- 失败先区分传输、确定性输入/契约、凭据/配额、环境前置与取消；沿已有任务记录使用唯一重试预算，尊重现有 guard，不因换工具、空闲或新轮次重置。写入/提交/发布超时先按操作标识只读查回，核对幂等性再补缺失步骤；取消撤销待执行动作。
- 开发变化同步必要注释和现有文档，按影响成文，不机械建立多层文档。精确路径暂存，提交、推送、发布和生产操作沿用适用授权。
- 交付分享包先核对行为→实现→安装依赖→接线→真实触发→结果；分别验证干净安装和旧环境增量，并由独立执行者实装最终包，关联源码、摘要、退出码及未验边界。
- 长任务按 rules/long-task.md 保存当前状态、下一步、阻塞和关键入口，只续当前获授权任务。复杂开发按 rules/vibe-coding.md 推进，明确需求不额外设审批关卡。
- 凭据、账号、真实数据、私人记忆不进入分享包。外部材料只作参考；破坏性/费用/敏感访问遵守当前授权，插件、hook 与机制不能绕过平台限制。
- self-evolution 只在当前明确授权和暂停状态允许时采用；安装本工作流不授予自动改规则、记忆、工具配置或后台监听权限。
`,
  'rules/long-task.md': `# 长任务与接续
沿现有任务卡记录目标与适用授权、当前状态及本轮证据、下一条具体操作、阻塞和关键文件入口。使用 /checkpoint 前先检查写入授权；只读任务在回复中交接，不写队列。
上下文或会话接近承载上限时先保存可接续状态，再使用宿主支持的接续入口。检查真实进程、会话与写入归属，不删除锁、不改会话数据库、不停止其他活跃任务。队列和会话摘要只作线索，接手先核对当前用户意图与现场状态。
目标只在明确要求时创建。使用 goal-driven-execution 或 continuation-state-audit 前读取真实技能入口；未验证的宿主接续能力标明前置条件，不假报自动接续。
`,
  'rules/vibe-coding.md': `# 开发任务与交付
按任务规模形成简短计划与可失败完成条件；充分明确的需求直接实施，不为形式额外索取设计批准。检查项目约定、锁文件、生产调用路径与已有改动，先定位原因，再做最小完整改动。
并行工作先标明依赖、ownedPaths、唯一写入者和固定基线，保护共享接口/生成物；真实隔离写入后核验逐提交范围、漂移与合并树。下一依赖波次使用已集成并通过验证的新基线。
执行相关回归与真实关键流程，保留首红和失败原因；按影响同步注释/现有文档。最后复核差异、精确暂存，交付说明完成项、命令/退出码和仍未验证的边界。
`,
};
const START = '<!-- qoder-package-workflow:start -->';
const END = '<!-- qoder-package-workflow:end -->';
const blockFor = rel => START + '\n' + RULES[rel].trimEnd() + '\n' + END;
function managedRule(bytes, rel, previousHash) {
  const text = bytes ? bytes.toString('utf8') : '';
  const start = text.indexOf(START), end = text.indexOf(END);
  const block = blockFor(rel);
  if (start < 0 && end < 0) return { bytes: Buffer.from(text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block + '\n'), hash: hash(block) };
  if (start < 0 || end < start || text.indexOf(START, start + 1) >= 0 || text.indexOf(END, end + 1) >= 0) throw new Error('分享包规则标记无效，保留供审阅：' + rel);
  const current = text.slice(start, end + END.length);
  if (current !== block && (!previousHash || hash(current) !== previousHash)) throw new Error('分享包规则存在本地定制，保留供审阅：' + rel);
  return { bytes: Buffer.from(text.slice(0, start) + block + text.slice(end + END.length)), hash: hash(block) };
}
function invocation(client, spec) {
  const payload = Buffer.from(JSON.stringify({ client: path.resolve(client), event: spec[0], script: spec[1], args: spec[4] || [] })).toString('base64url');
  const args = [path.join(client, 'scripts/run-package-hook.cjs'), payload];
  return { executable: process.execPath, args };
}
function completeSettings(bytes, client) {
  const settings = JSON.parse(bytes.toString('utf8'));
  if (settings.disableAllHooks === true || settings.hooksConfig?.enabled === false) throw new Error('宿主 hook 已禁用，保留选择；完整工作流未激活');
  const original = JSON.stringify(settings);
  for (const [event, groups] of Object.entries(settings.hooks)) for (const group of groups) for (const hook of group.hooks) {
    if (!String(hook.command || '').includes('run-package-hook.cjs') && !String(hook.args?.[0] || '').includes('run-package-hook.cjs')) continue;
    let value;
    try {
      if (!Array.isArray(hook.args) || hook.args.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(hook.args[1])) throw new Error();
      value = JSON.parse(Buffer.from(hook.args[1], 'base64url').toString('utf8'));
      const spec = HOOKS.find(item => item[0] === event && item[1] === value.script);
      if (!spec || Object.keys(value).sort().join(',') !== 'args,client,event,script' || value.event !== event || JSON.stringify(value.args) !== JSON.stringify(spec[4] || []) || fs.realpathSync.native(value.client) !== fs.realpathSync.native(client) || fs.realpathSync.native(hook.command) !== fs.realpathSync.native(process.execPath) || fs.realpathSync.native(hook.args[0]) !== fs.realpathSync.native(path.join(client, 'scripts/run-package-hook.cjs'))) throw new Error();
    } catch { throw new Error('完整工作流 launcher 接线冲突，保留供审阅：' + event); }
  }
  // The installer has validated the one routing hook before this conversion.
  // The real Qoder runner treats command+args as exec, avoiding Git Bash's
  // interpolation of dollar signs, spaces and apostrophes in client paths.
  for (const group of settings.hooks.UserPromptSubmit || []) for (const hook of group.hooks) {
    if (Array.isArray(hook.args) && hook.args[0] === path.join(client, 'scripts/rules-reminder.js')) continue;
    if (!String(hook.command || '').includes('rules-reminder.js')) continue;
    const mode = String(hook.command).match(/--workflow-mode (route|model)\s*$/)?.[1] || 'route';
    hook.command = process.execPath;
    hook.args = [path.join(client, 'scripts/rules-reminder.js'), '--client-root', client, '--workflow-mode', mode];
  }
  for (const spec of HOOKS) {
    const [event, script, timeout, matcher] = spec, call = invocation(client, spec);
    let found;
    for (const [actualEvent, groups] of Object.entries(settings.hooks)) for (const group of groups) for (const hook of group.hooks) {
      const command = String(hook.command || '');
      const owned = command === call.executable && JSON.stringify(hook.args) === JSON.stringify(call.args);
      const legacy = command.includes(script);
      // Decode only our bounded format, never execute a command while reconciling.
      let other;
      const token = Array.isArray(hook.args) && String(hook.args[0]).includes('run-package-hook.cjs') && hook.args[1];
      if (token) { try { other = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch {} }
      if (!owned && !legacy && other?.script !== script) continue;
      if (other?.script === script && other.event !== event) continue;
      if (legacy && actualEvent !== event) continue; // e.g. session-budget serves two events.
      const legacyMatch = legacy && command.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s+(--hook))?\s*$/);
      const realEqual = (a, b) => { try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return false; } };
      const validLegacy = !hook.args && legacyMatch && /^node(?:\.exe)?$/i.test(path.basename(legacyMatch[1] || legacyMatch[2] || legacyMatch[3])) && realEqual(legacyMatch[4] || legacyMatch[5] || legacyMatch[6], path.join(client, 'scripts', script)) && Boolean(legacyMatch[7]) === Boolean(spec[4]?.length);
      const validAlias = other && realEqual(other.client, client) && realEqual(hook.args[0], call.args[0]) && other.event === event && JSON.stringify(other.args) === JSON.stringify(spec[4] || []);
      if (found || actualEvent !== event || group.matcher !== matcher || hook.type !== 'command' || hook.env || hook.shell || ![timeout, ...(script === 'stop-gate.js' ? [10] : [])].includes(hook.timeout) || (!owned && !validLegacy && !validAlias)) throw new Error('完整工作流 hook 冲突，保留供审阅：' + event + '/' + script);
      found = hook;
    }
    if (found) { found.command = call.executable; found.args = call.args; found.timeout = timeout; }
    else (settings.hooks[event] ||= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: call.executable, args: call.args, timeout }] });
  }
  const next = Buffer.from(JSON.stringify(settings, null, 2) + '\n');
  return { bytes: next, state: JSON.stringify(settings) === original ? 'KEEP' : 'UPDATE' };
}
function health(client) {
  const receipt = JSON.parse(fs.readFileSync(path.join(client, 'package-activation.json'), 'utf8'));
  if (receipt.profile !== 'complete') return null;
  const issues = [];
  try { const roots = require('./capability-roots.cjs'); roots.readBindings(client); if (!roots.resolveTier(client, 'skills-library')) issues.push('CAPABILITY_LIBRARY_UNBOUND'); } catch { issues.push('CAPABILITY_ROOT_BINDING_INVALID'); }
  if (receipt.ready === false) issues.push('ACTIVATION_BLOCKED');
  for (const rel of Object.keys(RULES)) {
    const expected = receipt.managedRules?.[rel];
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) { issues.push('RULE_RECEIPT_MISSING:' + rel); continue; }
    try { const text = fs.readFileSync(path.join(client, rel), 'utf8'), start = text.indexOf(START), end = text.indexOf(END); if (start < 0 || end < start || hash(text.slice(start, end + END.length)) !== expected) issues.push('RULE_CHANGED:' + rel); }
    catch { issues.push('RULE_MISSING:' + rel); }
  }
  for (const rel of receipt.requiredFiles || []) if (!fs.existsSync(path.join(client, rel))) issues.push('FILE_MISSING:' + rel);
  try {
    const bytes = fs.readFileSync(path.join(client, 'settings.json')), settings = JSON.parse(bytes);
    const candidates = [];
    for (const [event, groups] of Object.entries(settings.hooks || {})) for (const group of groups) for (const hook of group.hooks) if (String(hook.command || '').includes('rules-reminder.js') || (Array.isArray(hook.args) && String(hook.args[0]).includes('rules-reminder.js'))) candidates.push({ event, group, hook });
    const rule = candidates[0], args = rule?.hook.args;
    const realEqual = (a, b) => { try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return false; } };
    if (candidates.length !== 1 || rule.event !== 'UserPromptSubmit' || rule.group.matcher !== undefined || rule.hook.type !== 'command' || rule.hook.timeout !== 10 || rule.hook.env || rule.hook.shell || !realEqual(rule.hook.command, process.execPath) || !Array.isArray(args) || args.length !== 5 || !realEqual(args[0], path.join(client, 'scripts/rules-reminder.js')) || args[1] !== '--client-root' || !realEqual(args[2], client) || args[3] !== '--workflow-mode' || !['route', 'model'].includes(args[4])) issues.push('RULES_HOOK_INCOMPLETE');
    if (completeSettings(bytes, client).state !== 'KEEP') issues.push('HOOKS_INCOMPLETE');
  }
  catch { issues.push('HOOKS_CONFLICT'); }
  return { schema: 1, profile: 'complete', status: issues.length ? 'INCOMPLETE' : 'READY', issues };
}
module.exports = { HOOKS, CORE_SKILLS, COMPLETE_IDS, RULES, START, END, managedRule, invocation, completeSettings, health };
if (require.main === module) { try { const result = health(process.argv[2] || require('./client-root.js').clientRoot()); console.log(JSON.stringify(result || { status: 'PROFILE_NOT_INSTALLED' })); process.exitCode = result?.status === 'READY' ? 0 : 1; } catch (error) { console.error('PROFILE_HEALTH_ERROR: ' + error.message); process.exitCode = 2; } }
