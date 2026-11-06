'use strict';

const STAGES = [
  { id: 'review', pattern: /(?:审查|审阅|评审|盘点|梳理|排查|评估|体检|分析|调研)/i },
  { id: 'implement', pattern: /(?:实现|开发|改造|重构|接入|修复|编码|落地|补齐)/i },
  { id: 'verify', pattern: /(?:测试|验证|验收|联调|回归|截图)/i },
  { id: 'deploy', pattern: /(?:部署|上线|发布|生产环境|线上)/i },
  { id: 'document', pattern: /(?:文档|vibecoding|规格|方案|报告|清单|成文|建议|优化|完善)/i },
  { id: 'deliver', pattern: /(?:提交\s*(?:SVN|Git)?|SVN\s*提交|commit|PR|交付)/i },
];
// 审查+成文只有在任务足够宽（项目/多版本/多模块）时才算长任务候选，避免“审查一个按钮并给方案”也弹窗。
const BROAD_TASK = /(?:项目|完整版|\blite\b|\bsvn\b|全量|全面|整体|多版本|多套|多个版本|多个模块|多个项目|多个服务|多个文件|多个代码库|跨模块|前后端|全仓|整套|全部代码|三个(?:模块|项目|版本|服务|文件|任务|代码库)|三套)/i;
// 只有祈使/授权语境才算显式目标请求；提问、否定、元提及一律不算，
// 否则"是否开启目标模式""目标模式是什么"也会被当成已授权并触发 CreateGoal。
const GOAL_INTENT = /(?:创建|设置|设为|建立|进入|开启|打开|启用|使用|用|按)\s*(?:一个|个)?\s*(?:目标|Goal)\s*(?:模式|执行)?|(?:目标|Goal)\s*(?:模式|执行)\s*(?:推进|来做|做|执行)|持续推进|盯到完成|盯到做完|直到完成/i;
const GOAL_META = /(?:是什么|什么意思|怎么|如何|为什么|为何|是否|会不会|能不能|要不要|可不可以|有没有|还会|吗|？|\?|这句话|这个词|这个机制|这个规则)/i;
const GOAL_NEGATION = /(?:不要|不用|无需|不必|取消|关闭|停用|禁用|停止|不(?:开启|进入|创建|设置|建立|使用|启用|打开|用)|别\s*(?:开启|进入|创建|设置|建立|使用|打开|用|再|去))/i;
const READ_ONLY = /(?:只读|仅审阅|只审查|只分析|仅分析|只评估|仅评估|不要修改|不改文件|仅给建议)/i;

function normalize(prompt) {
  return typeof prompt === 'string' ? prompt.replace(/\s+/g, ' ').trim() : '';
}

function classifyGoalCandidate(prompt, options = {}) {
  // 引用中的祈使句是被编辑/讨论的数据；保留“开启『目标模式』”这类被引用的名词。
  const text = normalize(typeof prompt === 'string' ? prompt
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
    .replace(/“([^”\n]*)”|「([^」\n]*)」|『([^』\n]*)』|"([^"\n]*)"|'([^'\n]*)'/g, (_, ...parts) => {
      const quoted = parts.slice(0, 5).find(value => value !== undefined) || '';
      return GOAL_INTENT.test(quoted) ? ' ' : quoted;
    }) : '');
  const explicitGoal = GOAL_INTENT.test(text) && !GOAL_META.test(text) && !GOAL_NEGATION.test(text);
  const matchedStages = STAGES.filter((stage) => stage.pattern.test(text)).map((stage) => stage.id);
  const minStages = Number.isFinite(options.minStages) ? options.minStages : 3;
  const hasDeliveryBoundary = matchedStages.includes('deploy') || matchedStages.includes('deliver');
  const readOnly = READ_ONLY.test(text) && (!matchedStages.includes('implement')
    || /^(?:请\s*)?(?:只读|仅审阅|只审查|只分析|仅分析|只评估|仅评估|仅给建议)/.test(text));
  const reviewAndDocument = matchedStages.includes('review') && matchedStages.includes('document') && BROAD_TASK.test(text);
  const candidate = !readOnly && (explicitGoal || (matchedStages.length >= minStages && hasDeliveryBoundary) || reviewAndDocument);
  return { candidate, explicitGoal, matchedStages, readOnly };
}

function goalCandidateNote(prompt) {
  const result = classifyGoalCandidate(prompt);
  if (!result.candidate) return '';
  if (result.explicitGoal) {
    return '\n【目标候选 · 已获显式授权】当前请求明确要求目标化执行；若尚无活动目标，立即调用 CreateGoal，objective 必须包含可失败完成判据。同时检查是否已有适用的 Vibecoding 四层文档；没有则用 AskUserQuestion 主动询问是否创建，有则询问是否按本轮需求更新，禁止重复新建平行文档。';
  }
  return '\n【目标候选 · 需弹窗确认】当前请求同时包含多阶段实施/验证/部署或提交，或属于审查+成文类长任务，符合长任务目标候选。CreateGoal 仍需用户显式授权：开工前用 AskUserQuestion 同轮询问两项——①“创建目标并持续推进（推荐）/仅使用任务清单”；②“创建或更新 Vibecoding 四层文档（推荐）/本轮不成文”。不得静默创建目标，也不得因目录有任务包推定实施授权；已有文档只更新，不重复新建。';
}

module.exports = { classifyGoalCandidate, goalCandidateNote };
