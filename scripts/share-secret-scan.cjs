#!/usr/bin/env node
/**
 * 分享包 / 待入包内容的敏感形态扫描。只报「文件 + 命中类别 + 次数」，绝不回显命中内容。
 * 用法：
 *   node share-secret-scan.cjs <目录或文件>...            # 扫描
 *   node share-secret-scan.cjs --selftest                 # 夹具自测（正例必中、干净夹具必放行）
 * 退出码：0 干净 / 2 命中硬类别（词表、真实 AppID、凭据键值）/ 1 只有软类别（示例私网 IP、他人家目录）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const LISTS = {
  '词表:secrets': path.join(HOME, '.qoder', 'scripts', '.export-secrets'),
  '词表:bizterms': path.join(HOME, '.qoder', 'scripts', '.export-bizterms'),
};
const WORDS = {};
for (const [k, p] of Object.entries(LISTS)) {
  WORDS[k] = fs.existsSync(p)
    ? fs.readFileSync(p, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
    : [];
}
const PLACEHOLDER = /^(x{3,}|your[_-]|<|\{\{|example|dummy|placeholder|changeme|xxx)/i;
// 裸写的 AppID 也是外泄形态，但顺序串 / 全同字符这类占位要放行
const PLACEHOLDER_APPID = /^wx(?:([0-9a-f])\1{15}|x{1,16}|0123456789abcdef|1234567890abcdef|abcdef0123456789|deadbeefdeadbeef)$/i;

// 文档里的 `password = <占位>` / `api_key: os.environ[...]` 是示例，不是外泄；
// 只有"像真值"的才判硬命中：够长、字母数字混合、不是环境变量/占位写法。
function looksRealSecret(text, m, v) {
  if (!v || v.length < 12) return false;
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false;
  if (!/^[A-Za-z0-9_\-/.+=:]+$/.test(v)) return false;
  if (/(your|example|placeholder|dummy|sample|changeme|secret|token|password|apikey|api_key|xxxx)/i.test(v)) return false;
  const at = text.indexOf(m);
  const ctx = at < 0 ? '' : text.slice(Math.max(0, at - 60), at);
  return !/process\.env|os\.environ|getenv|dotenv|config\.|settings\.|<|\{\{|\$\{/.test(ctx);
}
const HARD = {
  '真实微信AppID': /\bwx[0-9a-f]{16}\b/gi,
  '凭据键值': /(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token)\s*[:=]\s*["']?([^\s"',;)]{6,})/gi,
};
const SOFT = {
  '私网IP示例': /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g,
  '内网后缀主机': /\b[a-z0-9-]+\.(?:internal|intra|corp|lan|local)(?![a-z0-9_.-])/gi,
  '他人家目录': /(?<![A-Za-z0-9_./$])(?:[A-Za-z]:[\\/]{1,2}[Uu]sers[\\/]{1,2}|[/]home[/])(?!Admin\b|admin\b|user\b|User\b|x\b|\{|\$|\.)[A-Za-z0-9._-]{2,}/g,
};
function scanText(text) {
  const hits = {};
  const bump = (k, n) => { if (n) hits[k] = (hits[k] || 0) + n; };
  for (const [label, re] of Object.entries(HARD)) {
    const g = re.source.includes('gi') || String(re.flags).includes('g') ? re : new RegExp(re.source, re.flags + 'g');
    bump(label, (text.match(g) || []).filter(m => {
      const v = m.replace(/.*[:=]\s*["']?/, '');
      if (PLACEHOLDER.test(v) || /^\d+$/.test(v)) return false;
      if (label === '真实微信AppID') return !PLACEHOLDER_APPID.test(String(m).toLowerCase());
      if (label === '凭据键值') return looksRealSecret(text, m, v);
      return true;
    }).length);
  }
  for (const [label, words] of Object.entries(WORDS)) {
    let n = 0;
    for (const w of words) if (text.toLowerCase().includes(w.toLowerCase())) n++;
    bump(label, n);
  }
  for (const [label, re] of Object.entries(SOFT)) bump(label, (text.match(re) || []).length);
  return hits;
}
function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    if (/node_modules|backups|\.git$/.test(path.basename(p))) return out;
    for (const n of fs.readdirSync(p)) { const q = path.join(p, n); if (fs.statSync(q).isDirectory()) walk(q, out); else out.push(q); }
  } else out.push(p);
  return out;
}
function isHard(k) { return WORDS[k] !== undefined || HARD[k] !== undefined; }

function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretscan-'));
  const dirty = path.join(dir, 'dirty.md');
  const clean = path.join(dir, 'clean.md');
  // 夹具在源码里拆开写：包内文本不含完整凭据形状（否则本扫描器会把自己判红），运行时拼出来仍能被抓
  const fakeAppId = 'wx' + '0742b9f3c1' + 'a8d4e5';
  const fakePwd = 'S3cr3t' + 'Value9x77';
  const fakeHost = 'build-07.' + 'corp';
  const fakeIp = '10.' + '23.45.67';
  const fakeHome = ['/home', 'someone', 'config'].join('/');
  fs.writeFileSync(dirty, `appid ${fakeAppId} 与 password = "${fakePwd}" 以及主机 ${fakeHost} ${fakeIp} ${fakeHome}\n`);
  fs.writeFileSync(clean, '示例：`wx' + '1234567890' + 'abcdef` 是占位，password = <从凭据文件取>，api_key = process.env.OPENAI_API_KEY，文档用 IP 见 RFC5737 的 192.0.2.1\n版本10.12.5；pm-skills.local.md；./home/home.component；$T/case/home/.qoder\n');
  const dh = scanText(fs.readFileSync(dirty, 'utf8'));
  const ch = scanText(fs.readFileSync(clean, 'utf8'));
  const okHard = dh['真实微信AppID'] >= 1 && dh['凭据键值'] >= 1 && dh['内网后缀主机'] >= 1 && dh['私网IP示例'] >= 1 && dh['他人家目录'] >= 1;
  const okClean = Object.keys(ch).length === 0;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('脏夹具命中类别 = ' + Object.keys(dh).join(',') + ' → ' + (okHard ? 'OK 能判红' : 'RED 抓不到'));
  console.log('干净夹具类别 = ' + (Object.keys(ch).join(',') || '无') + ' → ' + (okClean ? 'OK 不误判硬类别' : 'RED 误判'));
  process.exit(okHard && okClean ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();
const targets = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!targets.length) { console.error('用法：share-secret-scan.cjs <目录或文件>... | --selftest'); process.exit(2); }
let hardFiles = 0, softFiles = 0, files = 0, unreadable = 0;
const rows = [];
for (const t of targets) {
  if (!fs.existsSync(t)) { console.error('FAIL 目标不存在: ' + t); unreadable++; continue; }
  for (const f of walk(t)) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { unreadable++; continue; }
    if (/\0/.test(text.slice(0, 8000))) continue;
    files++;
    const hits = scanText(text);
    const cats = Object.entries(hits);
    if (!cats.length) continue;
    const hard = cats.filter(([k]) => isHard(k));
    if (hard.length) hardFiles++; else softFiles++;
    rows.push([f, cats.map(([k, n]) => k + '=' + n).join(' '), hard.length ? 'HARD' : 'soft']);
  }
}
rows.forEach(([f, c, lvl]) => console.log(`  [${lvl}] ${path.relative(process.cwd(), f).replace(/\\/g, '/')} :: ${c}`));
console.log(`扫描 ${files} 个文件：硬命中 ${hardFiles}，软命中 ${softFiles}，不可读 ${unreadable}`);
if (!files) console.error('FAIL 没有可扫描的文本文件');
process.exit(unreadable || !files || hardFiles ? 2 : (softFiles ? 1 : 0));
