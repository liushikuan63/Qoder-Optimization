'use strict';

const STAGES = [
  { id: 'implement', pattern: /(?:实现|开发|改造|重构|接入|修复|编码|落地|补齐)/i },
  { id: 'verify', pattern: /(?:测试|验证|验收|联调|回归|截图)/i },
  { id: 'deploy', pattern: /(?:部署|上线|发布|生产环境|线上)/i },
  { id: 'deliver', pattern: /(?:提交\s*(?:SVN|Git)?|SVN\s*提交|commit|PR|交付)/i },
];
const EXPLICIT_GOAL = /(?:创建|设(?:置)?|建立|进入|使用|开启).{0,8}(?:目标|Goal)|(?:目标|Goal)\s*(?:模式|执行)|持续推进|盯到完成|直到完成/i;
const READ_ONLY = /(?:只读|仅审阅|只审查|只分析|仅分析|只评估|仅评估|不要修改|不改文件|仅给建议)/i;

function normalize(prompt) {
  return typeof prompt === 'string' ? prompt.replace(/\s+/g, ' ').trim() : '';
}

function classifyGoalCandidate(prompt, options = {}) {
  const text = normalize(prompt);
  const explicitGoal = EXPLICIT_GOAL.test(text);
  const matchedStages = STAGES.filter((stage) => stage.pattern.test(text)).map((stage) => stage.id);
  const minStages = Number.isFinite(options.minStages) ? options.minStages : 3;
  const hasDeliveryBoundary = matchedStages.includes('deploy') || matchedStages.includes('deliver');
  const readOnly = READ_ONLY.test(text) && !matchedStages.includes('implement');
  const candidate = !readOnly && (explicitGoal || (matchedStages.length >= minStages && hasDeliveryBoundary));
  return { candidate, explicitGoal, matchedStages, readOnly };
}

function goalCandidateNote(prompt) {
  const result = classifyGoalCandidate(prompt);
  if (!result.candidate) return '';
  if (result.explicitGoal) {
    return '\n【目标候选 · 已获显式授权】当前请求明确要求目标化执行；若尚无活动目标，立即调用 CreateGoal，objective 必须包含可失败完成判据。同时检查是否已有适用的 Vibecoding 四层文档；没有则用 AskUserQuestion 主动询问是否创建，有则询问是否按本轮需求更新，禁止重复新建平行文档。';
  }
  return '\n【目标候选 · 需弹窗确认】当前请求同时包含多阶段实施/验证/部署或提交，符合长任务目标候选。CreateGoal 仍需用户显式授权：开工前用 AskUserQuestion 同轮询问两项——①“创建目标并持续推进（推荐）/仅使用任务清单”；②“创建或更新 Vibecoding 四层文档（推荐）/本轮不成文”。不得静默创建目标，也不得因目录有任务包推定实施授权；已有文档只更新，不重复新建。';
}

module.exports = { classifyGoalCandidate, goalCandidateNote };
