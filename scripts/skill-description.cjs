'use strict';
// 技能 description 的**唯一解析真源**。此前三处各写一份且行为不同：
//   pack-share-extras  只取首行 + JSON.parse 解码（多行被静默截断）
//   share-package-verify 取含引号的原始行、不解码（长度多算 2~3）
//   skill-collisions   支持多行、剥引号、只解码 \" 与 \\
// 契约（统一后）：
//   · 支持单行与多行折叠标量（YAML plain / 双引号 / 单引号），续行以空格连接
//   · 双引号按 JSON 解码（含 \n \t \uXXXX \\ \"）；单引号按 YAML 的 '' 转义
//   · 长度口径一律 String.length（UTF-16 code unit），与 DESC_MAX / DESC_CARRERS.max 一致
//   · 缺 frontmatter / 缺 description / 引号不闭合 → 抛错，不静默返回半截值
function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function parseDescription(text) {
  const lines = String(text).split(/\r?\n/);
  if (!lines.length || lines[0].replace(/^\uFEFF/, '').trim() !== '---') throw fail('NO_FRONTMATTER', 'SKILL.md 缺少 frontmatter');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) throw fail('NO_FRONTMATTER', 'frontmatter 未闭合');
  const body = lines.slice(1, end);
  const idx = body.findIndex((l) => /^description:(?:[ \t]|$)/.test(l));
  if (idx < 0) throw fail('MISSING_DESCRIPTION', '缺少 description');
  const parts = [body[idx].replace(/^description:[ \t]*/, '')];
  for (let i = idx + 1; i < body.length; i++) {
    const l = body[i];
    if (!/^\s+\S/.test(l)) break;          // 遇到下一个顶层键即停
    if (/^[A-Za-z_][\w-]*:/.test(l.trim())) break;
    parts.push(l.trim());
  }
  const raw = parts.join(' ').trim();
  if (!raw) throw fail('MISSING_DESCRIPTION', 'description 为空');
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) throw fail('UNTERMINATED_QUOTE', '双引号 description 未闭合');
    try { return JSON.parse(raw); } catch (e) { throw fail('BAD_ESCAPE', '双引号 description 转义非法: ' + e.message); }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) throw fail('UNTERMINATED_QUOTE', '单引号 description 未闭合');
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

/** 便捷入口：读文件并解析。 */
function descriptionOfFile(file) {
  return parseDescription(require('fs').readFileSync(file, 'utf8'));
}

module.exports = { parseDescription, descriptionOfFile };