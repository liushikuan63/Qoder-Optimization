'use strict';

const norm = (s) => String(s || '').toLowerCase();
// 类别中文名也进检索面：搜「插件」「技能」「脚本」应能列出对应类别
const CAT_LABEL = { skill: '技能', plugin: '插件', mcp: 'MCP 连接', script: '脚本', command: '命令', agent: '子智能体' };
const hay = (e) => e.name + ' ' + (e.description || '') + ' ' + (CAT_LABEL[e.category] || '');

function scoreEntry(e, query, tokens) {
  const name = norm(e.name);
  const desc = norm(hay(e));
  const id = norm(e.id);
  const q = norm(query);
  let score = 0;
  if (name === q || id === q) score += 20;
  else if (name.includes(q) || id.includes(q)) score += 8;
  if (desc.includes(q)) score += 3;
  for (const t of tokens) {
    if (name.includes(t)) score += 4;
    else if (desc.includes(t)) score += 1;
  }
  return score;
}

module.exports = { norm, CAT_LABEL, hay, scoreEntry };
