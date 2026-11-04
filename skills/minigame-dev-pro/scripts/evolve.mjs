#!/usr/bin/env node
// evolve.mjs — 学习闭环执行器（1.0.8）
// 读 feedback-log → 聚类相似反馈 → 满足 "3+ 相似且未处理" → 生成 evolution-log 提议条目（不自动改写 shipped 知识）。
import fs from 'node:fs';
import path from 'node:path';
import { loadFeedbackLog, loadEvolutionLog, appendEvolution, loadProjectState, loadProfile } from './lib/user-profile.mjs';

const THRESHOLD = 3;

function cluster(feedbacks) {
  const groups = new Map();
  for (const f of feedbacks) {
    const key = `${f.signal}:${f.context || ''}`.slice(0, 80);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return groups;
}

function main() {
  const feedbacks = loadFeedbackLog();
  const processedIds = new Set(loadEvolutionLog().map((e) => e.fromContext));
  const groups = cluster(feedbacks);
  let proposals = 0;

  for (const [key, items] of groups) {
    if (items.length < THRESHOLD) continue;
    const first = items[0];
    if (processedIds.has(first.context)) continue;
    const proposal = {
      version: '1.1.0',
      proposedAt: new Date().toISOString(),
      signal: first.signal,
      sampleContext: first.context,
      similarCount: items.length,
      confidence: Math.min(0.9, 0.4 + items.length * 0.1),
      humanConfirmRequired: true,
      suggestion: '建议复核相关知识点并考虑更新；本条目仅为提议，未自动改写任何 shipped 知识文件。',
      fromContext: first.context,
    };
    appendEvolution(proposal);
    proposals++;
  }

  // 输出给 knowledge-filter 的权重调整建议（不自动改写）
  const weightHints = feedbacks
    .filter((f) => f.signal === 'invalid' || f.signal === 'outdated')
    .map((f) => ({ context: f.context, action: 'down-weight' }));

  console.log(JSON.stringify({ proposals, totalFeedback: feedbacks.length, weightHints }, null, 2));
}

main();
