#!/usr/bin/env node
/**
 * knowledge-filter.mjs 知识库过滤器（质量自检工具）
 * 用法：
 *   node knowledge-filter.mjs [--stage <阶段>] [--topic <主题>] [--role <角色>] [--json]
 *
 * 能力：
 *  - 索引 references/knowledge/ references/modules/ references/engine/ 下全部知识文件
 *  - 按开发阶段 / 主题 / 专家角色 过滤，输出应加载的文件清单
 *  - 避免全量加载 40+ 文件浪费上下文
 * 设计原则：
 *  - 无副作用：只读、只输出清单，不修改任何文件
 *  - 精准：只返回与当前任务相关的文件
 *  - 可组合：多条 AND 关系，同条件多个 OR 关系
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputSuccess, outputError, parseArgs, printHelp } from './lib/output-formatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(__dirname, '..');

const HELP = `知识库过滤器（按阶段/主题/角色精准加载）
用法:
  node knowledge-filter.mjs [选项]

选项:
  --stage <阶段>      按开发阶段过滤（可逗号分隔多值，OR 关系）
  --topic <主题>      按知识主题过滤（可逗号分隔多值，OR 关系）
  --role <角色>       按专家角色过滤（可逗号分隔多值，OR 关系）
  --list              列出所有可选值（阶段/主题/角色）后退出
  --json              以 JSON 格式输出
  --help              显示帮助

阶段（--stage）
  ideation      ①创意/立项
  compliance    ①资质/合规
  develop       ①技术开发
  qa            ①质量/测试
  submission    ①提审/上架
  operations    ①运营/变现
  failure       ①失败/复盘
  all           全流程（不按阶段过滤）

主题（--topic）
  market        市场情报
  design        游戏设计
  tech          技术开发
  compliance    合规法规
  analytics     数据分析
  growth        用户增长
  operations    运营变现
  art           美术音频
  legal         法律财务
  ai            AI辅助开发
  cloud         云开发
  crossplatform 跨端经营

角色（--role）
  planner       老周（策划）
  tech          老陈（技术）
  compliance    小林（合规）
  art           阿美（美术/UI）
  operations    老张（运营）

示例:
  # 加载"技术开发阶段"相关知识
  node knowledge-filter.mjs --stage develop --json

  # 加载"合规"主题 + "小林"角色相关知识
  node knowledge-filter.mjs --topic compliance --role compliance --json

  # 列出所有可选值
  node knowledge-filter.mjs --list
`;

// ---- 知识文件索引 ----
// 每个文件标注：阶段、主题、角色、优先级、描述
// 阶段: ideation/compliance/develop/qa/submission/operations/failure/all
// 主题: market/design/tech/compliance/analytics/growth/operations/art/legal/ai/cloud/crossplatform
// 角色: planner/tech/compliance/art/operations
// 优先级 P0(必看)/P1(常用)/P2(按需)
const KNOWLEDGE_INDEX = [
  // ---- references/engine/（引擎，跨阶段常驻）----
  { path: 'references/engine/anti-hallucination.md', stages: ['all'], topics: [], roles: [], priority: 'P0', desc: '反幻觉规则集' },
  { path: 'references/engine/execution-protocol.md', stages: ['develop', 'qa', 'submission'], topics: ['tech'], roles: ['tech'], priority: 'P0', desc: '执行层调用协议' },
  { path: 'references/engine/expert-panel.md', stages: ['all'], topics: [], roles: ['planner', 'tech', 'compliance', 'art', 'operations'], priority: 'P1', desc: '专家团完整定义' },
  { path: 'references/engine/decision-trees.md', stages: ['ideation', 'compliance', 'submission'], topics: ['market', 'compliance'], roles: ['planner', 'compliance'], priority: 'P1', desc: '决策树（选型/合规/就绪度）' },
  { path: 'references/engine/evolution-protocol.md', stages: ['all'], topics: [], roles: [], priority: 'P2', desc: '自进化协议详细' },

  // ---- references/modules/（模块，按阶段对应）----
  { path: 'references/modules/onboarding.md', stages: ['all'], topics: [], roles: [], priority: 'P1', desc: '新用户引导全流程' },
  { path: 'references/modules/market.md', stages: ['ideation'], topics: ['market'], roles: ['planner', 'operations'], priority: 'P0', desc: '市场情报分析引擎' },
  { path: 'references/modules/compliance.md', stages: ['compliance', 'submission'], topics: ['compliance'], roles: ['compliance'], priority: 'P0', desc: '合规引擎详细逻辑' },
  { path: 'references/modules/design.md', stages: ['ideation', 'develop'], topics: ['design'], roles: ['planner', 'art'], priority: 'P0', desc: '游戏策划指导' },
  { path: 'references/modules/develop.md', stages: ['develop'], topics: ['tech'], roles: ['tech'], priority: 'P0', desc: '技术开发指引' },
  { path: 'references/modules/qa.md', stages: ['qa', 'develop'], topics: ['tech'], roles: ['tech'], priority: 'P0', desc: '质量保障与测试' },
  { path: 'references/modules/review.md', stages: ['submission', 'qa'], topics: [], roles: ['planner', 'tech', 'compliance', 'art', 'operations'], priority: 'P1', desc: '专家团审查详细流程' },
  { path: 'references/modules/submission.md', stages: ['submission'], topics: ['compliance'], roles: ['compliance'], priority: 'P0', desc: '审核提交流程' },
  { path: 'references/modules/operations.md', stages: ['operations'], topics: ['operations'], roles: ['operations'], priority: 'P0', desc: '运营与变现' },
  { path: 'references/modules/analytics.md', stages: ['operations', 'qa'], topics: ['analytics'], roles: ['operations'], priority: 'P0', desc: '数据分析引擎' },
  { path: 'references/modules/growth.md', stages: ['operations'], topics: ['growth'], roles: ['operations'], priority: 'P1', desc: '用户增长引擎' },
  { path: 'references/modules/failure.md', stages: ['failure', 'operations'], topics: ['operations'], roles: ['operations', 'planner'], priority: 'P1', desc: '失败处理与复盘' },
  { path: 'references/modules/ai-tools.md', stages: ['ideation', 'develop'], topics: ['ai'], roles: ['planner', 'tech', 'art'], priority: 'P2', desc: 'AI辅助开发工具指南' },

  // ---- references/knowledge/（知识库）---
  { path: 'references/knowledge/compliance-rules.md', stages: ['compliance', 'submission'], topics: ['compliance'], roles: ['compliance'], priority: 'P0', desc: '合规规则库（14条红线）' },
  { path: 'references/knowledge/market-data.md', stages: ['ideation'], topics: ['market'], roles: ['planner', 'operations'], priority: 'P1', desc: '市场数据库（品类追踪）' },
  { path: 'references/knowledge/cost-database.md', stages: ['ideation', 'compliance'], topics: ['legal'], roles: ['planner', 'operations'], priority: 'P1', desc: '成本数据库' },
  { path: 'references/knowledge/tech-specs.md', stages: ['develop'], topics: ['tech'], roles: ['tech'], priority: 'P1', desc: '技术规格库' },
  { path: 'references/knowledge/legal-finance.md', stages: ['compliance', 'operations'], topics: ['legal'], roles: ['compliance', 'operations'], priority: 'P1', desc: '法律与财务基础' },
  { path: 'references/knowledge/art-audio.md', stages: ['develop'], topics: ['art'], roles: ['art'], priority: 'P1', desc: '美术与音频指引' },
  { path: 'references/knowledge/case-library.md', stages: ['all'], topics: [], roles: [], priority: 'P2', desc: '成功/失败案例库' },
  { path: 'references/knowledge/glossary.md', stages: ['all'], topics: [], roles: [], priority: 'P2', desc: '中英术语对照表（中英切换专用）' },
  { path: 'references/knowledge/cloud-development.md', stages: ['develop', 'operations'], topics: ['cloud', 'tech'], roles: ['tech'], priority: 'P2', desc: '微信云开发指南' },
  { path: 'references/knowledge/pc-mini-game.md', stages: ['operations'], topics: ['crossplatform'], roles: ['operations'], priority: 'P2', desc: 'PC端小游戏经营' },
  { path: 'references/knowledge/cross-platform.md', stages: ['operations'], topics: ['crossplatform'], roles: ['operations'], priority: 'P2', desc: '跨端经营路径' },
  { path: 'references/knowledge/ai-agent-workflow.md', stages: ['develop'], topics: ['ai', 'tech'], roles: ['tech'], priority: 'P2', desc: 'AI Agent 开发范式' },
  { path: 'references/knowledge/error-reference.md', stages: ['qa', 'develop'], topics: ['tech'], roles: ['tech'], priority: 'P2', desc: '脚本错误码与退出码参考' },

  // ---- references/knowledge/sop/（操作手册，合规阶段）---
  { path: 'references/knowledge/sop/icp-filing-sop.md', stages: ['compliance'], topics: ['compliance'], roles: ['compliance'], priority: 'P0', desc: 'ICP备案逐步操作' },
  { path: 'references/knowledge/sop/software-copyright-sop.md', stages: ['compliance'], topics: ['compliance'], roles: ['compliance'], priority: 'P0', desc: '软著申请逐步操作' },
  { path: 'references/knowledge/sop/self-review-report-sop.md', stages: ['submission'], topics: ['compliance'], roles: ['compliance'], priority: 'P0', desc: '自审自查报告填写' },
  { path: 'references/knowledge/sop/privacy-policy-sop.md', stages: ['compliance', 'submission'], topics: ['compliance'], roles: ['compliance'], priority: 'P0', desc: '隐私保护指引编写' },
  { path: 'references/knowledge/sop/anti-addiction-sop.md', stages: ['develop', 'compliance'], topics: ['compliance', 'tech'], roles: ['compliance', 'tech'], priority: 'P0', desc: '防沉迷系统接入' },
  { path: 'references/knowledge/sop/wechat-certification-sop.md', stages: ['compliance'], topics: ['compliance'], roles: ['compliance'], priority: 'P1', desc: '微信认证操作' },
  { path: 'references/knowledge/sop/version-number-sop.md', stages: ['compliance'], topics: ['compliance'], roles: ['compliance'], priority: 'P1', desc: '版号申请操作' },
  { path: 'references/knowledge/sop/content-filing-sop.md', stages: ['submission'], topics: ['compliance'], roles: ['compliance'], priority: 'P1', desc: '游戏内容备案' },

  // ---- references/knowledge/game-design/（游戏设计，创意+开发阶段）----
  { path: 'references/knowledge/game-design/core-loop-patterns.md', stages: ['ideation', 'develop'], topics: ['design'], roles: ['planner'], priority: 'P1', desc: '核心循环设计模式' },
  { path: 'references/knowledge/game-design/retention-mechanics.md', stages: ['ideation', 'operations'], topics: ['design', 'growth'], roles: ['planner', 'operations'], priority: 'P1', desc: '留存机制设计' },
  { path: 'references/knowledge/game-design/economy-design.md', stages: ['ideation', 'develop'], topics: ['design'], roles: ['planner'], priority: 'P1', desc: '经济系统设计' },
  { path: 'references/knowledge/game-design/difficulty-balancing.md', stages: ['develop'], topics: ['design'], roles: ['planner'], priority: 'P2', desc: '难度平衡' },
  { path: 'references/knowledge/game-design/social-mechanics.md', stages: ['ideation', 'develop'], topics: ['design', 'growth'], roles: ['planner'], priority: 'P2', desc: '合规社交机制' },
  { path: 'references/knowledge/game-design/ftue-design.md', stages: ['develop'], topics: ['design'], roles: ['planner', 'art'], priority: 'P2', desc: '首次用户体验' },

  // ---- references/knowledge/tech-practices/（技术实践，开发/QA阶段）---
  { path: 'references/knowledge/tech-practices/package-optimization.md', stages: ['develop', 'qa'], topics: ['tech'], roles: ['tech'], priority: 'P1', desc: '包体优化实战' },
  { path: 'references/knowledge/tech-practices/device-compatibility.md', stages: ['develop', 'qa'], topics: ['tech'], roles: ['tech'], priority: 'P1', desc: '机型适配' },
  { path: 'references/knowledge/tech-practices/sdk-integration/ad-sdk-guide.md', stages: ['develop', 'operations'], topics: ['tech', 'operations'], roles: ['tech'], priority: 'P1', desc: '广告SDK接入指南' },
  { path: 'references/knowledge/tech-practices/sdk-integration/analytics-sdk-guide.md', stages: ['develop', 'operations'], topics: ['tech', 'analytics'], roles: ['tech', 'operations'], priority: 'P1', desc: '数据SDK接入指南' },
  { path: 'references/knowledge/tech-practices/engine-specific/cocos-creator-guide.md', stages: ['develop'], topics: ['tech'], roles: ['tech'], priority: 'P1', desc: 'Cocos Creator专项指南' },
];

// ---- 可选值定义----
const VALID_STAGES = ['ideation', 'compliance', 'develop', 'qa', 'submission', 'operations', 'failure', 'all'];
const VALID_TOPICS = ['market', 'design', 'tech', 'compliance', 'analytics', 'growth', 'operations', 'art', 'legal', 'ai', 'cloud', 'crossplatform'];
const VALID_ROLES = ['planner', 'tech', 'compliance', 'art', 'operations'];

const STAGE_LABELS = {
  ideation: '①创意/立项',
  compliance: '①资质/合规',
  develop: '①技术开发',
  qa: '①质量/测试',
  submission: '①提审/上架',
  operations: '①运营/变现',
  failure: '①失败/复盘',
  all: '全流程',
};

async function main() {
  const args = parseArgs();
  if (args.help) printHelp(HELP);

  // --list 模式：列出所有可选值
  if (args.list) {
    outputSuccess({
      action: 'knowledge_filter_list',
      stages: VALID_STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s] })),
      topics: VALID_TOPICS,
      roles: VALID_ROLES.map((r) => ({ key: r, label: roleLabel(r) })),
      totalFiles: KNOWLEDGE_INDEX.length,
    }, args.json);
  }

  // 解析过滤条件（逗号分隔多值）
  const stages = parseMultiValue(args.stage);
  const topics = parseMultiValue(args.topic);
  const roles = parseMultiValue(args.role);

  // 校验
  validateValues('stage', stages, VALID_STAGES, args.json);
  validateValues('topic', topics, VALID_TOPICS, args.json);
  validateValues('role', roles, VALID_ROLES, args.json);

  // 应用过滤（AND 关系：三个条件都满足）
  let matched = KNOWLEDGE_INDEX.filter((item) => {
    // 阶段过滤：文件的 stages 包含任一指定阶段，或包含 'all'
    if (stages.length > 0) {
      const stageMatch = stages.some((s) => s === 'all' || item.stages.includes(s) || item.stages.includes('all'));
      if (!stageMatch) return false;
    }
    // 主题过滤：文件的 topics 包含任一指定主题
    if (topics.length > 0) {
      const topicMatch = topics.some((t) => item.topics.includes(t));
      if (!topicMatch) return false;
    }
    // 角色过滤：文件的 roles 包含任一指定角色
    if (roles.length > 0) {
      const roleMatch = roles.some((r) => item.roles.includes(r));
      if (!roleMatch) return false;
    }
    return true;
  });

  // 按优先级排序：P0 > P1 > P2
  const priorityOrder = { P0: 0, P1: 1, P2: 2 };
  matched.sort((a, b) => (priorityOrder[a.priority] || 9) - (priorityOrder[b.priority] || 9));

  // 读取每个文件的开头摘要（取前 3 行非空内容）+ 最后修改时间
  const results = matched.map((item) => {
    let preview = '';
    let lastModified = null;
    let ageDays = null;
    try {
      const full = join(SKILL_ROOT, item.path);
      const content = readFileSync(full, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 3);
      preview = lines.join(' ').slice(0, 120);
      // 文件最后修改时间（用于判断知识是否需要更新）
      const stat = statSync(full);
      lastModified = stat.mtime.toISOString().slice(0, 10);
      ageDays = Math.floor((Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24));
    } catch (_) { /* ignore */ }
    const stale = ageDays !== null && ageDays > 180 ? 'stale: 超过6个月未更新，建议验证' : null;
    return {
      path: item.path,
      priority: item.priority,
      stages: item.stages,
      topics: item.topics,
      roles: item.roles.map(roleLabel),
      description: item.desc,
      preview,
      lastModified,
      ageDays,
      stale,
    };
  });

  outputSuccess({
    action: 'knowledge_filter',
    filters: {
      stages: stages.length > 0 ? stages : null,
      topics: topics.length > 0 ? topics : null,
      roles: roles.length > 0 ? roles.map(roleLabel) : null,
    },
    totalIndexed: KNOWLEDGE_INDEX.length,
    matchedCount: results.length,
    files: results,
    hint: results.length === 0
      ? '没有匹配的知识文件，请检查过滤条件（用 --list 查看可选值）'
      : `建议加载以上 ${results.length} 个文件（按优先级排序，P0 必看）`,
  }, args.json);
}

/**
 * 解析多值参数（支持逗号分隔）
 */
function parseMultiValue(raw) {
  if (!raw || raw === true) return [];
  return String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * 校验过滤值是否合法
 */
function validateValues(name, values, valid, json = false) {
  for (const v of values) {
    if (!valid.includes(v)) {
      outputError(
        `无效的${name} 值 ${v}`,
        { hint: `可选值: ${valid.join(', ')}。用 --list 查看完整列表。` },
        json,
      );
    }
  }
}

function roleLabel(r) {
  const map = { planner: '老周(策划)', tech: '老陈(技术)', compliance: '小林(合规)', art: '阿美(美术)', operations: '老张(运营)' };
  return map[r] || r;
}

main().catch((e) => outputError(`未捕获异常 ${e.message}`, {}, false));

