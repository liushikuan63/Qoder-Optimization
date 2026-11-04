'use strict';

const SECRET_PATTERNS = [
  { label: 'PRIVATE_KEY', regex: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { label: 'TOKEN', regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED_TOKEN]' },
  { label: 'JWT', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: '[REDACTED_JWT]' },
  // Quoted values can contain whitespace and escaped quotes. Consume the
  // entire value before the token-shaped fallback so no suffix is disclosed.
  { label: 'CREDENTIAL', regex: /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|密钥|口令|密码)["']?\s*[:=：]\s*)(["'])(?!\[REDACTED(?:_[A-Z]+)?\]\2)((?:\\[^\r\n]|(?!\2)[^\\\r\n]){6,})\2/gi, replacement: '$1$2[REDACTED]$2' },
  { label: 'CREDENTIAL', regex: /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|密钥|口令|密码)["']?\s*[:=：]\s*)(["']?)(?!\[REDACTED(?:_[A-Z]+)?\])([^\s"',;)}\]]{6,})\2/gi, replacement: '$1$2[REDACTED]$2' },
  { label: 'BEARER', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: 'Bearer [REDACTED]' },
  { label: 'INTERNAL_IP', regex: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3})\b/g, replacement: '[REDACTED_IP]' },
];

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password || /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
      return '[REDACTED_URL]';
    }
    if (url.search || url.hash) return url.origin + url.pathname + '[REDACTED_QUERY]';
    return raw;
  } catch {
    return '[REDACTED_URL]';
  }
}

function redact(text) {
  let value = String(text);
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern.regex, pattern.replacement);
  value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
  return value.replace(/\bhttps?:\/\/[^\s<>"')\]]+/gi, redactUrl);
}

function findSensitive(text) {
  const value = String(text);
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(value)) hits.push(pattern.label);
    pattern.regex.lastIndex = 0;
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i.test(value)) hits.push('URL_CREDENTIALS');
  const urls = value.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) || [];
  if (urls.some(url => redactUrl(url) !== url)) hits.push('URL');
  return [...new Set(hits)];
}

module.exports = { SECRET_PATTERNS, redactUrl, redact, findSensitive };
