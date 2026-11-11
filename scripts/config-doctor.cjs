'use strict';
// config-doctor.cjs -- parity of plugins / hooks / MCP / security settings between the two Qoder clients.
// exit 0 CLEAN, 1 RED found, 2 precondition failure. Fixes are explicit subcommands, never implicit.
const fs = require('fs');
const path = require('path');
const { clientRoot } = require('./client-root.js');
const CLIENT_ROOT = clientRoot();
const HOME = (process.env.USERPROFILE || require('os').homedir()).replace(/\\/g, '/');
const S = { CN: path.join(HOME, '.qoder-cn'), INTL: path.join(HOME, '.qoder') };
const argv = process.argv.slice(2);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function settings(side) { return readJson(path.join(S[side], 'settings.json')) || {}; }
function registry(side) { const j = readJson(path.join(S[side], 'plugins/installed_plugins_v2.json')); return (j && j.plugins) || {}; }
function hookSet(side) {
  const j = settings(side);
  const out = [];
  for (const [ev, arr] of Object.entries(j.hooks || {})) for (const g of arr || []) for (const h of (g.hooks || [])) out.push(ev + ' :: ' + String(h.command || '').replace(/^"([^"]+)"/, '$1'));
  return out.sort();
}
function pluginKeys(side) { return Object.keys(registry(side)).sort(); }
function deadPaths(side) {
  const r = registry(side);
  const bad = [];
  for (const [k, v] of Object.entries(r)) { const rec = Array.isArray(v) ? v[0] : v; const ip = rec && rec.installPath; if (!ip) continue; if (!fs.existsSync(ip)) bad.push(k + ' -> ' + ip); }
  return bad;
}
function otherUserPaths(side) {
  // 用本机真实用户名判定，而不是写死某个名字。注意 USERNAME 可能是短名，
  // 而用户目录名可能带域名后缀——以 home 目录名为准。
  const me = new Set([process.env.USERNAME, process.env.USER, require('os').userInfo().username, path.basename(HOME)]
    .filter(Boolean).map((x) => String(x).toLowerCase()));
  const r = registry(side); const bad = [];
  for (const [k, v] of Object.entries(r)) { const rec = Array.isArray(v) ? v[0] : v; const ip = String(rec && rec.installPath || ''); const m = ip.match(/[\\/]Users[\\/]([^\\/]+)[\\/]/); if (m && !me.has(m[1].toLowerCase())) bad.push(k + ' 记录指向别的机器用户 ' + m[1] + '（本机不存在）'); }
  return bad;
}
function inertHooks(side) {
  // polarmem0 hooks are inert when its client has no config: base_url null / api_key_set false
  const out = [];
  for (const h of hookSet(side)) if (/polarmem0/.test(h)) out.push('polarmem0 hook 空转（该侧挂了记忆 hook 但客户端未配置）: ' + h.slice(0, 70));
  return out;
}
function check() {
  const r = [];
  const cn = settings('CN'), intl = settings('INTL');
  const push = (lvl, k, msg) => r.push({ lvl, k, msg });
  // A. hook 接线一致性（事件 + 命令集合）
  const a = hookSet('CN'), b = hookSet('INTL');
  const onlyA = a.filter((x) => !b.includes(x)), onlyB = b.filter((x) => !a.includes(x));
  if (onlyA.length || onlyB.length) push('RED', 'HOOK-DIFF', '仅 CN: [' + onlyA.join('; ') + '] 仅 INTL: [' + onlyB.join('; ') + ']');
  else push('OK', 'HOOK-DIFF', a.length + ' 条两侧一致');
  // A2. 反向 drift（现役侧）：hook 接线引用的脚本必须真实存在。
  // 正向 drift 只比对「包内有的条目」，结构上查不出「现役挂了但根本没这个脚本」——
  // 本项目实测过两个 dispatcher 只存在于本机、仓库与 catalog 都没有的情况。
  const entryMissing = [];
  for (const side of ['CN', 'INTL']) {
    for (const h of hookSet(side)) {
      const m = /([A-Za-z]:[\\/][^\s"']+\.(?:js|cjs|mjs)|~\/[^\s"']+\.(?:js|cjs|mjs))/.exec(h);
      if (!m) continue;
      const p = m[1].replace(/^~/, process.env.USERPROFILE || process.env.HOME || '');
      if (!fs.existsSync(p)) entryMissing.push(side + ': ' + p);
    }
  }
  if (entryMissing.length) push('RED', 'HOOK-ENTRY-MISSING', '接线指向不存在的脚本 ' + entryMissing.length + ' 条: [' + [...new Set(entryMissing)].join('; ') + ']');
  else push('OK', 'HOOK-ENTRY-MISSING', '两侧 hook 入口脚本均存在');
  // B. 插件集合一致。分两档：bundler（两侧市场都有）缺了算 RED；
  // 市场插件（@qoder-marketplace）在两边的市场目录里未必都上架，属平台差异，只报 INFO 不判红。
  const isMkt = (k) => /@qoder-marketplace$/.test(k);
  const pa = pluginKeys('CN'), pb = pluginKeys('INTL');
  const bMiss = [...pb.filter((k) => !pa.includes(k)), ...pa.filter((k) => !pb.includes(k))].filter((k) => !isMkt(k));
  const mMiss = [...pb.filter((k) => !pa.includes(k)), ...pa.filter((k) => !pb.includes(k))].filter(isMkt);
  if (bMiss.length) push('RED', 'PLUGIN-SET', '两侧 bundler 插件不一致: ' + bMiss.join(', '));
  else push('OK', 'PLUGIN-SET', 'bundler 插件两侧一致（市场插件差异见 INFO）');
  if (mMiss.length) push('INFO', 'PLUGIN-SET-MARKETPLACE', '市场插件仅单侧可用（平台上架差异）: ' + mMiss.join(', '));
  // C. 每条 installPath 在本机真实存在（跨机器残留记录会让插件静默加载失败）
  const dead = [...deadPaths('CN'), ...deadPaths('INTL')];
  if (dead.length) push('RED', 'PLUGIN-PATH', dead.join(' | '));
  else push('OK', 'PLUGIN-PATH', '全部 installPath 存在');
  const alien = [...otherUserPaths('CN'), ...otherUserPaths('INTL')];
  if (alien.length) push('RED', 'PLUGIN-ALIEN-PATH', alien.join(' | '));
  // D. 空转的记忆 hook（挂了但客户端没配）
  const inert = [...inertHooks('CN'), ...inertHooks('INTL')];
  if (inert.length) push('RED', 'HOOK-INERT', inert.join(' | '));
  // E. MCP 集合（两侧 mcpServers）
  const ma = Object.keys(cn.mcpServers || {}).sort().join(','), mb = Object.keys(intl.mcpServers || {}).sort().join(',');
  if (ma !== mb) push('RED', 'MCP-SERVERS', 'CN=[' + ma + '] INTL=[' + mb + ']');
  else push('OK', 'MCP-SERVERS', (ma || '(两侧均未配置 mcpServers，连接器来自插件)') + ' 一致');
  // F. securityScan 开关存在且一致
  const sa = JSON.stringify(cn.securityScan || null), sb = JSON.stringify(intl.securityScan || null);
  if (sa !== sb) push('RED', 'SECURITY-SCAN', 'CN=' + sa + ' INTL=' + sb);
  else push('OK', 'SECURITY-SCAN', sa || '(两侧均未设置)');
  // G. enabledPlugins 键集合一致（同样区分 bundler 与市场插件）
  const ea = Object.keys(cn.enabledPlugins || {}).sort(), eb = Object.keys(intl.enabledPlugins || {}).sort();
  const ediff = [...ea.filter((k) => !eb.includes(k)), ...eb.filter((k) => !ea.includes(k))];
  const eB = ediff.filter((k) => !isMkt(k)), eM = ediff.filter(isMkt);
  if (eB.length) push('RED', 'ENABLED-PLUGINS', 'bundler 启用项不一致: ' + eB.join(', '));
  else push('OK', 'ENABLED-PLUGINS', 'bundler 启用项一致');
  if (eM.length) push('INFO', 'ENABLED-PLUGINS-MARKETPLACE', '市场插件仅单侧启用（平台上架差异）: ' + eM.join(', '));
  for (const x of r) console.log(x.lvl.padEnd(6) + x.k + '  ' + x.msg);
  const red = r.filter((x) => x.lvl === 'RED').length;
  console.log('VERDICT=' + (red ? 'RED' : 'CLEAN'));
  return red ? 1 : 0;
}

function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, ''); }
function backup(p) {
  // 备份写到被改文件所属的那一侧：单端装配时不能为了备份去新建另一侧目录
  const side = /[\\/]\.qoder-cn[\\/]/.test(p) ? S.CN : S.INTL;
  const d = path.join(side, '_skill-backups', stamp());
  fs.mkdirSync(d, { recursive: true });
  const dst = path.join(d, path.basename(path.dirname(p)) + '__' + path.basename(p));
  fs.copyFileSync(p, dst);
  return dst;
}
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }

// fix-hooks-inert: drop the polarmem0 hook entries (the memory service is unconfigured on this machine;
// restore with `polarmem0 setup --agent qoder ...` or from the backup this prints)
function fixHooksInert(dry) {
  for (const side of Object.keys(S)) {
    const p = path.join(S[side], 'settings.json');
    const j = readJson(p);
    if (!j || !j.hooks) continue;
    let removed = 0;
    for (const ev of Object.keys(j.hooks)) {
      const before = j.hooks[ev].length;
      j.hooks[ev] = j.hooks[ev].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !/polarmem0/.test(String(h.command || ''))) })).filter((g) => (g.hooks || []).length);
      removed += before - j.hooks[ev].length;
    }
    if (!removed) { console.log('SKIP  ' + side + ' 无 polarmem0 hook'); continue; }
    if (dry) { console.log('WOULD REMOVE ' + removed + ' 组 hook 条目 on ' + side); continue; }
    const bak = backup(p);
    writeJson(p, j);
    console.log('REMOVED ' + removed + ' 组 on ' + side + ' (备份 ' + bak + ')');
  }
}
// fix-security-scan: copy the securityScan block to the side that lacks it
function fixSecurityScan(dry) {
  const cn = settings('CN'), intl = settings('INTL');
  const src = cn.securityScan ? ['CN'] : intl.securityScan ? ['INTL'] : [];
  if (!src.length) { console.log('SKIP  两侧都没有 securityScan'); return; }
  for (const [side, root] of Object.entries(S)) {
    const j = readJson(path.join(root, 'settings.json'));
    if (!j || j.securityScan) continue;
    j.securityScan = (side === 'CN' ? intl : cn).securityScan || (readJson(path.join(S[src[0]], 'settings.json')).securityScan);
    if (dry) { console.log('WOULD ADD securityScan on ' + side + ' = ' + JSON.stringify(j.securityScan)); continue; }
    const bak = backup(path.join(root, 'settings.json'));
    writeJson(path.join(root, 'settings.json'), j);
    console.log('ADDED securityScan on ' + side + ' (备份 ' + bak + ')');
  }
}
// fix-plugin-paths: repoint registry records whose installPath lives under another machine's user dir
function fixPluginPaths(dry) {
  for (const [side, root] of Object.entries(S)) {
    const bad = otherUserPaths(side);
    if (!bad.length) continue;
    const p = path.join(root, 'plugins/installed_plugins_v2.json');
    const j = readJson(p);
    let fixed = 0;
    for (const [k, v] of Object.entries(j.plugins)) {
      const rec = Array.isArray(v) ? v[0] : v;
      const ip = String(rec.installPath || '');
      if (fs.existsSync(ip) && !/Users[\\/](?!Admin)/.test(ip.replace(/\//g, '\\'))) continue; // healthy and local
      const tail = ip.replace(/^.*?[\\/]\.qoder(?:-cn)?[\\/]/, ''); // already starts with "plugins\"
      const guess = path.join(root, tail);
      if (fs.existsSync(guess)) {
        if (dry) { console.log('WOULD REPOINT ' + side + '/' + k + ' -> ' + guess); }
        else { rec.installPath = guess; }
        fixed++;
      } else console.log('RED   ' + side + '/' + k + ' 本机找不到对应缓存目录，需重装该插件（' + guess + '）');
    }
    if (fixed && !dry) { const bak = backup(p); writeJson(p, j); console.log('REPOINTED ' + fixed + ' 条 on ' + side + ' (备份 ' + bak + ')'); }
  }
}
// fix-security-cache: copy the security-scan plugin data dir so both clients expose the same capability
function fixSecurityCache(dry) {
  const srcDir = path.join(S.INTL, 'plugins/data/security-scan');
  const dstDir = path.join(S.CN, 'plugins/data/security-scan');
  if (!fs.existsSync(srcDir)) { console.log('SKIP  国际版侧没有 security-scan 数据目录'); return; }
  if (fs.existsSync(dstDir)) { console.log('SKIP  CN 侧已有 security-scan 数据目录'); return; }
  if (dry) { console.log('WOULD COPY plugins/data/security-scan  INTL->CN'); return; }
  fs.cpSync(srcDir, dstDir, { recursive: true });
  console.log('COPIED plugins/data/security-scan INTL->CN（生效需重启 CN 客户端 - 未做视觉验证）');
}

// fix-plugin-set: mirror a plugin that exists on only one side (copy its cache dir, repoint the record,
// and carry the enabledPlugins flag). The app normally writes these; manual mirroring takes effect on client restart.
function fixPluginSet(dry) {
  for (const [from, to] of [['INTL', 'CN'], ['CN', 'INTL']]) {
    const a = registry(from), b = registry(to);
    for (const k of Object.keys(a).filter((x) => !Object.keys(b).includes(x))) {
      const src = Array.isArray(a[k]) ? a[k][0] : a[k];
      const srcPath = String(src.installPath || '');
      if (!fs.existsSync(srcPath)) { console.log('RED   ' + k + ' 在 ' + from + ' 侧的缓存目录本身就不存在，无法镜像（需重装）'); continue; }
      const tail = srcPath.replace(/^.*?[\\/]\.qoder(?:-cn)?[\\/]/, ''); // already starts with "plugins\"
      const dstPath = path.join(S[to], tail);
      console.log((dry ? 'WOULD MIRROR ' : 'MIRRORED ') + k + '  ' + from + '->' + to + '  ' + dstPath);
      if (!dry) {
        fs.cpSync(srcPath, dstPath, { recursive: true });
        const p = path.join(S[to], 'plugins/installed_plugins_v2.json');
        const bak = backup(p);
        const j = readJson(p);
        j.plugins[k] = [{ ...src, installPath: dstPath.replace(/\//g, '\\') }];
        writeJson(p, j);
        const sp = path.join(S[to], 'settings.json');
        const sj = readJson(sp);
        if (sj.enabledPlugins) sj.enabledPlugins[k] = true;
        writeJson(sp, sj);
        console.log('  注册表已写入（备份 ' + bak + '），enabledPlugins 置 true - 生效需重启该侧客户端，未做视觉验证');
      }
    }
  }
}
function main() {
  if (argv[0] === 'fix') {
    const dry = !argv.includes('--apply');
    fixHooksInert(dry); fixSecurityScan(dry); fixPluginPaths(dry); fixSecurityCache(dry); fixPluginSet(dry);
    console.log('--- 复检 ---');
    process.exit(check());
  }
  if (argv[0] === '--selftest') {
    const os = require('os');
    const base = path.join(os.tmpdir(), 'cfg-doctor-selftest-' + process.pid);
    const mk = (side, obj) => { const d = path.join(base, side); fs.mkdirSync(path.join(d, 'plugins'), { recursive: true }); fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(obj, null, 2)); fs.writeFileSync(path.join(d, 'plugins/installed_plugins_v2.json'), JSON.stringify({ version: 2, plugins: obj.__plugins || {} })); delete obj.__plugins; };
    fs.rmSync(base, { recursive: true, force: true });
    const clean = { hooks: { Stop: [{ hooks: [{ command: 'node a.js' }] }] }, mcpServers: {}, enabledPlugins: { 'x@b': true }, __plugins: { 'x@b': [{ installPath: path.join(base, 'CN', 'plugins'), enabled: true }] } };
    mk('CN', JSON.parse(JSON.stringify(clean))); mk('INTL', JSON.parse(JSON.stringify(clean)));
    const savedS = { ...S };
    S.CN = path.join(base, 'CN'); S.INTL = path.join(base, 'INTL');
    const cap = [];
    const log = console.log; console.log = (m) => cap.push(String(m));
    check();
    const out1 = cap.join('\n');
    cap.length = 0;
    const bad = JSON.parse(JSON.stringify(clean));
    bad.hooks.Stop[0].hooks.push({ command: 'node polarmem0.js' });
    bad.mcpServers = { ghost: { command: 'x' } };
    mk('INTL', bad);
    check();
    const out2 = cap.join('\n');
    cap.length = 0;
    const ghost = JSON.parse(JSON.stringify(clean));
    ghost.hooks.Stop[0].hooks.push({ command: 'node ~/cfg-doctor-ghost-' + process.pid + '.js' });
    mk('INTL', ghost);
    check();
    const out3 = cap.join('\n');
    console.log = log;
    S.CN = savedS.CN; S.INTL = savedS.INTL;
    fs.rmSync(base, { recursive: true, force: true });
    const t = [
      ['基线一致时 HOOK/MCP 判 OK', /OK    HOOK-DIFF/.test(out1) && /OK    MCP-SERVERS/.test(out1)],
      ['NEG 多挂的 hook 被报红', /RED   HOOK-DIFF/.test(out2)],
      ['NEG 两侧 mcpServers 不一致被报红', /RED   MCP-SERVERS/.test(out2)],
      ['NEG 空转记忆 hook 被报红', /RED   HOOK-INERT/.test(out2)],
      ['基线入口都存在时 HOOK-ENTRY-MISSING 判 OK', /OK    HOOK-ENTRY-MISSING/.test(out1)],
      ['NEG 接线指向不存在脚本被报红（反向 drift）', /RED   HOOK-ENTRY-MISSING/.test(out3)],
    ];
    let fail = 0;
    for (const [n, ok] of t) { log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fail++; }
    log('SELFTEST ' + t.length + ' checks, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
  process.exit(check());
}
main();
