#!/usr/bin/env node
// MCP 安装助手：交互询问 → 选择离线包 / 联网最新版 / 跳过 → 合并配置（改前备份，不写凭据）。
// 用法: node install-mcp.cjs [--config-dir <目录>] [--dry-run] [--yes]
//        [--cua offline|online|register|skip] [--dbhub online|tgz|skip]
//        [--install-dir <cua 安装目录>] [--wire-guard] [--skip-cua] [--skip-dbhub]
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');
const https = require('https');
const readline = require('readline');

const args = process.argv.slice(2);
const get = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);
const flagOptions = new Set(['--dry-run', '--yes', '--wire-guard', '--skip-cua', '--skip-dbhub']);
const valueOptions = new Set(['--config-dir', '--cua', '--dbhub', '--install-dir']);
function invalidArgument(message) {
  console.error('[错误] 无效参数: ' + message);
  process.exit(2);
}
for (let i = 0; i < args.length; i++) {
  if (flagOptions.has(args[i])) continue;
  if (!valueOptions.has(args[i])) invalidArgument('存在未识别的选项');
  if (!args[i + 1] || args[i + 1].startsWith('--')) invalidArgument(args[i] + ' 缺少值');
  i++;
}
if (!['auto', 'offline', 'online', 'register', 'skip'].includes(get('cua', 'auto'))) invalidArgument('--cua 选项不受支持');
if (!['auto', 'online', 'tgz', 'skip'].includes(get('dbhub', 'auto'))) invalidArgument('--dbhub 选项不受支持');

// 配置落到**本机实际存在**的客户端目录：只装了一个客户端时，不去新建另一侧的目录（2026-10-27）
const CLIENT_ROOT = (() => {
  const h = os.homedir();
  const sides = [path.join(h, '.qoder'), path.join(h, '.qoder-cn')].filter((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  return sides.length === 1 ? sides[0] : path.join(h, '.qoder');
})();
const CONFIG = path.resolve(get('config-dir', CLIENT_ROOT));
const DRY = has('dry-run');
const YES = has('yes');
const WIRE_GUARD = has('wire-guard');
const SKIP_CUA = has('skip-cua');
const SKIP_DBHUB = has('skip-dbhub');
const CUA_MODE = get('cua', 'auto');
const DBHUB_MODE = get('dbhub', 'auto');
const INSTALL_DIR_RAW = get('install-dir', null);
let INSTALL_DIR = INSTALL_DIR_RAW ? path.resolve(INSTALL_DIR_RAW) : null;
const KIT = __dirname;
const OFFLINE = path.join(KIT, 'offline');
const SETTINGS = path.join(CONFIG, 'settings.json');
const REGISTRY = 'https://registry.npmmirror.com';
const REPO = 'trycua/cua';

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('[警告]', ...a);

function readJson(p, fallback) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  try { return JSON.parse(text); }
  catch { throw new Error('配置 JSON 无效，原文件未修改: ' + p); }
}
function backup(p) {
  const dir = path.join(CONFIG, '.backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(dir, `${stamp}-${path.basename(p)}`);
  if (fs.existsSync(p)) fs.copyFileSync(p, dst);
  return dst;
}
function runNpm(args, options = {}) {
  const nodeDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    path.resolve(nodeDirectory, '../share/nodejs/npm/bin/npm-cli.js'),
  ];
  const cli = candidates.find(file => fs.existsSync(file));
  if (!cli) return { status: 1, stdout: '', stderr: '无法定位 npm-cli.js' };
  return cp.spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 120000, ...options, shell: false });
}
function npmRoot() {
  const r = runNpm(['root', '-g'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}
function bundledCua() {
  if (!fs.existsSync(OFFLINE)) return null;
  const zip = fs.readdirSync(OFFLINE).find((f) => /^cua-driver-rs-.*-windows-x86_64\.zip$/.test(f));
  if (!zip) return null;
  const m = zip.match(/cua-driver-rs-(.+)-windows-x86_64\.zip$/);
  const sums = path.join(OFFLINE, 'SHA256SUMS');
  return { zip: path.join(OFFLINE, zip), version: m ? m[1] : 'unknown', sums: fs.existsSync(sums) ? sums : null };
}
function installedCuaVersion(exe) {
  if (!fs.existsSync(exe) || !fs.statSync(exe).isFile()) return null;
  const r = cp.spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.status !== 0) return null;
  const m = String(r.stdout || '').match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/);
  return m ? m[1] : null;
}
function findCuaExe() {
  const cands = INSTALL_DIR ? [path.join(INSTALL_DIR, 'cua-driver.exe')] : [];
  if (!INSTALL_DIR_RAW) {
    cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe'));
    cands.push(path.join(os.homedir(), '.cua-driver', 'packages', 'current', 'cua-driver.exe'));
  }
  return cands.find(p => p && fs.existsSync(p) && fs.statSync(p).isFile()) || null;
}
function checkedInstallDir() {
  if (!INSTALL_DIR) throw new Error('安装 cua-driver 需要 --install-dir 指定非系统盘目录');
  const drive = value => path.win32.parse(value).root.replace(/[\\/]+$/, '').toLowerCase();
  const systemDrive = String(process.env.SystemDrive || path.win32.parse(process.env.SystemRoot || 'C:/Windows').root).replace(/[\\/]+$/, '').toLowerCase();
  const raw = INSTALL_DIR_RAW || INSTALL_DIR;
  if (drive(raw) === systemDrive || drive(INSTALL_DIR) === systemDrive || raw.startsWith('\\\\') || raw.startsWith('//')) throw new Error('cua-driver 安装目录必须在非系统盘本地路径');
  let ancestor = INSTALL_DIR;
  for (;;) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  if (!fs.statSync(ancestor).isDirectory()) throw new Error('cua-driver 安装路径的已有父级不是目录');
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, INSTALL_DIR));
  if (drive(resolved) === systemDrive) throw new Error('cua-driver 安装目录实际指向系统盘');
  return INSTALL_DIR;
}
function emptyInstallDir() {
  const dir = checkedInstallDir();
  if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length)) throw new Error('不覆盖已有安装或非空目录；请指定新的空目录');
  return dir;
}
function cuaWorkspace(prefix) {
  const parent = path.dirname(emptyInstallDir());
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, prefix));
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function verifySums(zip, sums) {
  if (!sums || !fs.existsSync(sums)) return { ok: false, reason: '没有 SHA256SUMS' };
  const name = path.basename(zip);
  const row = fs.readFileSync(sums, 'utf8').split(/\r?\n/).map(line => line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)).find(match => match && match[2] === name);
  if (!row) return { ok: false, reason: 'SHA256SUMS 中没有该文件' };
  const want = row[1].toLowerCase();
  const got = sha256(zip);
  return { ok: want === got, want, got };
}
function bundledDbhubArchive() {
  const files = fs.existsSync(OFFLINE) ? fs.readdirSync(OFFLINE).filter(file => /^bytebase-dbhub-.*\.tgz$/.test(file)) : [];
  if (files.length !== 1) throw new Error('需要唯一的 dbhub 离线 tgz；不自动改用联网安装');
  const file = path.join(OFFLINE, files[0]);
  const result = verifySums(file, path.join(OFFLINE, 'SHA256SUMS'));
  if (!result.ok) throw new Error('dbhub 离线校验失败: ' + (result.reason || 'SHA256 不一致'));
  return file;
}
function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let r = cp.spawnSync('tar', ['-xf', zip, '-C', dest], { encoding: 'utf8' });
  if (r.status !== 0) {
    r = cp.spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`], { encoding: 'utf8' });
  }
  if (r.status !== 0) throw new Error('解压失败: ' + (r.stderr || r.stdout || 'tar/powershell 均失败'));
}
function installCuaFromZip(zip, version) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('cua-driver 资产仅支持 Windows x64，当前平台未安装');
  const expected = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || '')) ? version : null;
  const dest = emptyInstallDir();
  const stage = cuaWorkspace('cua-stage-');
  try {
    extractZip(zip, stage);
    const inner = fs.readdirSync(stage).map((n) => path.join(stage, n)).find((p) => fs.statSync(p).isDirectory()) || stage;
    const stagedExe = path.join(inner, 'cua-driver.exe');
    if (!fs.existsSync(stagedExe) || !fs.statSync(stagedExe).isFile()) throw new Error('归档中没有 cua-driver.exe，未安装');
    const got = installedCuaVersion(stagedExe);
    if (!got) throw new Error('无法确认解压后 cua-driver 的版本，未安装');
    if (expected && got !== expected) throw new Error('版本不一致（期望 ' + expected + '，实际 ' + got + '），未安装');
    emptyInstallDir();
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(inner, dest, { recursive: true, force: true });
    const exe = path.join(dest, 'cua-driver.exe');
    const installed = installedCuaVersion(exe);
    if (installed !== got) throw new Error('安装后版本复核失败，未注册');
    log(`- cua-driver ${installed} 已安装到 ${dest}`);
    return exe;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'qoder-share-mcp-kit' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 5) {
        r.resume();
        return download(new URL(r.headers.location, url).toString(), dest, redirects + 1).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const f = fs.createWriteStream(dest);
      r.pipe(f);
      f.on('finish', () => f.close(() => resolve()));
      f.on('error', reject);
    }).on('error', reject);
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'qoder-share-mcp-kit', Accept: 'application/vnd.github+json' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return getJson(new URL(r.headers.location, url).toString()).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function installCuaOnline() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('cua-driver 官方资产仅支持 Windows x64，当前平台未安装');
  emptyInstallDir();
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  const ver = String(rel.tag_name || '').replace(/^v/, '');
  const assets = rel.assets || [];
  const zip = assets.find((a) => /^cua-driver-rs-.*-windows-x86_64\.zip$/.test(a.name));
  const sums = assets.find((a) => /^SHA256SUMS$|^checksums\.txt$/i.test(a.name));
  if (!zip) throw new Error('最新 release 没有 windows-x86_64 资产');
  const tmp = cuaWorkspace('cua-download-');
  try {
    const zipPath = path.join(tmp, zip.name);
    log(`- 下载 ${zip.name} ...`);
    await download(zip.browser_download_url, zipPath);
    let sumsPath = null;
    if (sums) { sumsPath = path.join(tmp, sums.name); await download(sums.browser_download_url, sumsPath); }
    const v = verifySums(zipPath, sumsPath);
    if (!v.ok) throw new Error('校验失败: ' + (v.reason || `期望 ${v.want} 实际 ${v.got}`));
    log('- SHA256 校验通过');
    return installCuaFromZip(zipPath, ver);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
function createAutostart(exe) {
  const dir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  fs.mkdirSync(dir, { recursive: true });
  const vbs = path.join(dir, 'CuaDriverServe.vbs');
  const body = `CreateObject("WScript.Shell").Run """${exe}"" serve", 0, False\r\n`;
  fs.writeFileSync(vbs, body, 'utf8');
  return vbs;
}

async function main() {
  const interactive = !YES;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = (q, def) => {
    if (!rl) return Promise.resolve(def);
    return new Promise((resolve) => rl.question(q, (a) => resolve(String(a).trim() || def)));
  };

  log(`配置目录: ${CONFIG}`);
  log(`模式: ${DRY ? '预览（不执行安装/写入）' : '执行'}`);

  const settings = readJson(SETTINGS, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json 必须是对象，原文件未修改');
  if (settings.mcpServers === undefined) settings.mcpServers = {};
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers)) throw new Error('mcpServers 必须是对象，原文件未修改');
  const planned = [];
  const skipCua = SKIP_CUA || CUA_MODE === 'skip';
  const skipDbhub = SKIP_DBHUB || DBHUB_MODE === 'skip';
  const b = skipCua ? null : bundledCua();
  const existing = skipCua ? null : findCuaExe();
  const existingVersion = existing && !DRY ? installedCuaVersion(existing) : null;
  const detectedNpmRoot = !skipDbhub && !DRY ? npmRoot() : null;
  log(`\n检测：包内 cua-driver=${skipCua ? '跳过' : b ? b.version : '无'}；已安装=${skipCua ? '跳过' : existing ? (DRY ? '预览未探测' : existingVersion || '版本未知') : '无'}；npm=${skipDbhub ? '跳过' : DRY ? '预览未探测' : detectedNpmRoot ? '可用' : '不可用'}`);

  // ---- cua-driver ----
  let cuaChoice = SKIP_CUA ? 'skip' : CUA_MODE;
  if (cuaChoice === 'auto') {
    if (interactive) {
      log('\n是否安装 / 修复 cua-driver？');
      log('  1) 用包内离线版本' + (b ? `（${b.version}，无需联网）` : '（包内没有，不可用）'));
      log('  2) 联网下载最新版（GitHub 不通时会失败）');
      log('  3) 跳过（不安装、不注册）');
      log('  4) 仅注册已安装的版本');
      cuaChoice = await ask('选择 [默认 1]: ', '1');
      cuaChoice = cuaChoice === '1' ? 'offline' : cuaChoice === '2' ? 'online' : cuaChoice === '3' ? 'skip' : 'register';
    } else {
      cuaChoice = b ? 'offline' : existing ? 'register' : 'skip';
    }
  }
  let cuaExe = existing;
  const unsupportedCuaPlatform = process.platform !== 'win32' || process.arch !== 'x64';
  if ((cuaChoice === 'offline' || cuaChoice === 'online') && unsupportedCuaPlatform) {
    if (DRY) log('- [预览] 当前平台不是 Windows x64；执行阶段将拒绝安装 cua-driver');
    else throw new Error('包内与官方 cua-driver 资产仅支持 Windows x64；当前平台未安装');
  }
  if (cuaChoice === 'offline') {
    if (!b) throw new Error('包内没有离线 cua-driver；不自动改用联网安装');
    if (existing && existingVersion === b.version) { log(`- 已安装同版本 ${b.version}，跳过`); cuaExe = existing; }
    else {
      const v = verifySums(b.zip, b.sums);
      if (!v.ok) throw new Error('包内 zip 校验失败: ' + (v.reason || `期望 ${v.want} 实际 ${v.got}`));
      if (DRY) {
        const dir = checkedInstallDir();
        log(`- [预览] 将释放 ${path.basename(b.zip)} 到 ${dir}`);
        cuaExe = path.join(dir, 'cua-driver.exe');
      } else {
        log('- SHA256 校验通过');
        cuaExe = installCuaFromZip(b.zip, b.version);
      }
      if (interactive && !DRY) {
        const auto = await ask('是否设置开机自启（启动文件夹 VBS 运行 cua-driver serve）？[y/N]: ', 'n');
        if (/^y/i.test(auto)) log('- 自启: ' + createAutostart(cuaExe));
      }
    }
  } else if (cuaChoice === 'online') {
    if (DRY) log('- [预览] 将查询 GitHub 最新 release 并下载校验');
    else cuaExe = await installCuaOnline();
  } else if (cuaChoice === 'register') {
    if (!cuaExe) throw new Error('未找到已安装的 cua-driver.exe，无法注册');
    if (!DRY && !installedCuaVersion(cuaExe)) throw new Error('无法确认已安装 cua-driver 的版本，未注册');
  }
  const cuaServer = 'cua-computer-use';
  const cuaLegacy = 'cua-driver';
  if (cuaChoice !== 'skip' && cuaExe && !settings.mcpServers[cuaServer] && !settings.mcpServers[cuaLegacy]) {
    settings.mcpServers[cuaServer] = { type: 'stdio', command: cuaExe, args: ['mcp'] };
    planned.push('mcpServers.' + cuaServer + ' → ' + cuaExe);
  } else if (settings.mcpServers[cuaServer] || settings.mcpServers[cuaLegacy]) log('- cua-driver 已注册（含 legacy 名），跳过重复写入');

  // ---- dbhub ----
  let dbChoice = SKIP_DBHUB ? 'skip' : DBHUB_MODE;
  if (dbChoice === 'auto') {
    if (interactive) {
      log('\n是否安装 dbhub（多库只读查询）？');
      log('  1) 联网安装最新版（npm）');
      log('  2) 用包内 tgz（仍需联网解析依赖）');
      log('  3) 跳过');
      dbChoice = await ask('选择 [默认 1]: ', '1');
      dbChoice = dbChoice === '1' ? 'online' : dbChoice === '2' ? 'tgz' : 'skip';
    } else dbChoice = 'online';
  }
  const dbhubArchive = dbChoice === 'tgz' ? bundledDbhubArchive() : null;
  if (dbChoice !== 'skip' && DRY) {
    if (dbhubArchive) log('- [预览] 已校验 dbhub 离线包: ' + path.basename(dbhubArchive));
    log('- [预览] 将在执行阶段检查 npm 全局目录、dbhub 入口和依赖；本轮不运行 npm');
    if (!settings.mcpServers.dbhub) planned.push('mcpServers.dbhub（执行阶段验证入口后注册）');
  } else if (dbChoice !== 'skip') {
    const root = detectedNpmRoot;
    if (!root) throw new Error('无法定位 npm 全局目录，dbhub 未安装');
    else {
      const entry = path.join(root, '@bytebase', 'dbhub', 'dist', 'index.js');
      if (!fs.existsSync(entry)) {
        const spec = dbhubArchive || '@bytebase/dbhub';
        log(`- 安装 dbhub（${dbChoice === 'tgz' ? '包内 tgz' : 'npm 最新'}）...`);
        const npmArgs = ['install', '-g', spec, '--registry=' + REGISTRY];
        if (dbChoice === 'tgz') npmArgs.push('--prefer-offline');
        const r = runNpm(npmArgs, { stdio: 'inherit' });
        if (r.status !== 0) throw new Error('dbhub 安装失败，配置未写入');
      } else log('- dbhub 已安装，跳过');
      if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) throw new Error('dbhub 入口未找到，配置未写入');
      if (!settings.mcpServers.dbhub) {
        settings.mcpServers.dbhub = { type: 'stdio', command: process.execPath, args: [entry, '--transport', 'stdio', '--config=' + path.join(CONFIG, 'dbhub.toml')] };
        planned.push('mcpServers.dbhub（stdio）');
      }
      const toml = path.join(CONFIG, 'dbhub.toml');
      if (!fs.existsSync(toml)) {
        const tpl = ['# dbhub 数据源模板：每个源只读、加超时；凭据只写本机文件', '[[sources]]', 'id = "example"', 'dsn = "mysql://user:password@127.0.0.1:3306/db"', 'lazy = true', 'connection_timeout = 10000', 'query_timeout = 30000', ''].join('\n');
        fs.mkdirSync(CONFIG, { recursive: true });
        fs.writeFileSync(toml, tpl, 'utf8');
        log(`- 生成 dbhub 模板: ${toml}`);
      }
    }
  }

  // ---- context7 ----
  let addContext7 = true;
  if (!settings.mcpServers.context7 && !settings.mcpServers.Context7 && interactive) {
    const a = await ask('\n是否接入 context7（HTTP 文档检索，无需安装依赖）？[Y/n]: ', 'y');
    addContext7 = /^y/i.test(a);
  }
  if (addContext7 && !settings.mcpServers.context7 && !settings.mcpServers.Context7) {
    settings.mcpServers.context7 = { type: 'http', url: 'https://mcp.context7.com/mcp' };
    planned.push('mcpServers.context7（HTTP）');
  }

  // ---- 守卫 ----
  let guardChoice = WIRE_GUARD;
  if (!WIRE_GUARD && !SKIP_CUA && interactive && cuaExe) {
    const a = await ask('\n是否接线鼠标抢占守卫（cua-cursor-guard）？[y/N]: ', 'n');
    guardChoice = /^y/i.test(a);
  }
  if (guardChoice) {
    const guard = path.join(CONFIG, 'scripts', 'cua-cursor-guard.js');
    if (!fs.existsSync(guard)) warn(`守卫脚本不存在: ${guard}（先把包内 scripts/ 复制过去）`);
    else {
      settings.hooks = settings.hooks || {};
      const matcher = 'mcp_call|mcp__cua[_-]?driver__.*|^Bash$';
      for (const evt of ['PreToolUse', 'PostToolUse']) {
        settings.hooks[evt] = settings.hooks[evt] || [];
        if (!settings.hooks[evt].some((h) => JSON.stringify(h).includes('cua-cursor-guard.js'))) {
          settings.hooks[evt].push({ matcher, hooks: [{ type: 'command', command: `"${process.execPath}" "${guard}"`, timeout: 10 }] });
          planned.push(`hooks.${evt}（cua-cursor-guard）`);
        } else log(`- hooks.${evt} 已接线，跳过`);
      }
    }
  }

  if (rl) rl.close();

  if (!planned.length) { log('\n没有需要变更的配置。'); }
  else {
    log('\n将写入:');
    for (const p of planned) log('  + ' + p);
    if (DRY) log('\n[预览] 未写入 settings.json。');
    else {
      const bak = backup(SETTINGS);
      if (bak) log('已备份: ' + bak);
      fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');
      log('已写入: ' + SETTINGS);
    }
  }
  log('\n验证: 重开会话 → mcp_list 能看到工具名；dbhub 跑一条只读查询；cua-driver --version / status。');
}

main().catch((e) => { console.error('[错误] ' + e.message); process.exit(1); });
