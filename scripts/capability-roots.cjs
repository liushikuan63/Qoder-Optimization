'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FILE = 'capability-roots.json';
const PROOF = Symbol('binding file proof');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = file => fs.realpathSync.native(file);
const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
function physical(file) { const suffix = []; let cursor = path.resolve(file); for (;;) { try { return path.join(canonical(cursor), ...suffix.reverse()); } catch (error) { if (error.code !== 'ENOENT') throw error; try { fs.lstatSync(cursor); throw new Error('悬空链接不是可创建目录'); } catch (e) { if (e.code !== 'ENOENT') throw e; } const parent = path.dirname(cursor); if (parent === cursor) throw error; suffix.push(path.basename(cursor)); cursor = parent; } } }
const identity = (file, link = false) => { const s = (link ? fs.lstatSync : fs.statSync)(file, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino) }; };
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const inside = (root, file) => { const rel = path.relative(root, file); return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
function readBindings(client) {
  const file = path.join(client, FILE);
  let stat; try { stat = fs.lstatSync(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('能力目录绑定必须是普通的小型配置文件');
  const bytes = readFileWithin(client, file, null); let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('能力目录绑定 JSON 无效，保留原文件供核对'); }
  const data = validateBindings(client, parsed);
  Object.defineProperty(data, PROOF, { value: { ...identity(file, true), hash: digest(bytes) } });
  return validateBindings(client, data);
}
function validateBindings(client, data) {
  if (!data || data.schema !== 1 || Object.keys(data).sort().join(',') !== 'client,library,schema' || !data.client || !data.library) throw new Error('能力目录绑定格式无效');
  if (data[PROOF]) {
    const file = path.join(client, FILE), bytes = readFileWithin(client, file, null);
    if (!same(data[PROOF], identity(file, true)) || digest(bytes) !== data[PROOF].hash) throw new Error('能力目录绑定已撤销或改变');
  }
  const logical = path.join(path.resolve(client), 'skills-library'), binding = data.library;
  if (typeof data.client.real !== 'string' || !path.isAbsolute(data.client.real) || pathKey(data.client.real) !== pathKey(canonical(client)) || !same(data.client, identity(client))) throw new Error('能力目录客户端身份已改变');
  if (typeof binding.real !== 'string' || !path.isAbsolute(binding.real) || pathKey(canonical(logical)) !== pathKey(binding.real) || pathKey(canonical(binding.real)) !== pathKey(binding.real) || !same(binding.link, identity(logical, true)) || !same(binding.target, identity(binding.real))) throw new Error('已绑定按需目录或链接身份已改变');
  if (!fs.lstatSync(binding.real).isDirectory() || fs.lstatSync(binding.real).isSymbolicLink()) throw new Error('按需目录真实目标不再是普通目录');
  return data;
}
function bindLibrary(client, requested) {
  const logical = path.join(path.resolve(client), 'skills-library');
  if (!path.isAbsolute(requested) || pathKey(canonical(logical)) !== pathKey(canonical(requested))) throw new Error('--bind-library 必须明确指向当前按需目录的真实目标');
  const data = { schema: 1, client: { real: canonical(client), ...identity(client) }, library: { real: canonical(requested), link: identity(logical, true), target: identity(requested) } };
  return validateBindings(client, data);
}
function resolveTier(client, tier, supplied) {
  if (!['skills', 'skills-library', 'scripts', 'commands', 'agents'].includes(tier)) throw new Error('无效能力目录');
  const logical = path.join(path.resolve(client), tier);
  const bindings = tier === 'skills-library' ? (supplied === undefined ? readBindings(client) : supplied && validateBindings(client, supplied)) : null;
  let stat; try { stat = fs.lstatSync(logical); } catch (error) { if (error.code === 'ENOENT') return logical; throw error; }
  if (!stat.isSymbolicLink()) {
    if (!stat.isDirectory()) throw new Error('能力目录不是普通目录：' + tier);
    return logical;
  }
  if (tier !== 'skills-library') return null;
  return bindings ? bindings.library.real : null;
}
function assertClientPath(client, file, supplied) {
  client = path.resolve(client); file = path.resolve(file);
  const rel = path.relative(client, file);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('能力目标不属于当前客户端');
  const parts = rel.split(path.sep), tier = parts[0];
  let actualRoot = physical(client), cursor = client, start = 0;
  if (['skills', 'skills-library', 'scripts', 'commands', 'agents'].includes(tier)) {
    const resolved = resolveTier(client, tier, supplied);
    if (!resolved) throw new Error('未绑定的链接目录：' + tier);
    actualRoot = fs.existsSync(resolved) ? canonical(resolved) : path.join(actualRoot, tier);
    cursor = path.join(client, tier); start = 1;
  }
  for (let i = start; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let stat; try { stat = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('能力路径含未授权链接或特殊对象');
    if (!inside(actualRoot, canonical(cursor))) throw new Error('能力路径越出已绑定目录');
  }
  // Revalidate the root after walking children; a substituted junction is never
  // accepted because the final bytes happen to match the requested file.
  if (tier === 'skills-library') resolveTier(client, tier, supplied);
  return file;
}
function ordinaryWithin(client, file, directory = false, supplied) {
  try { assertClientPath(client, file, supplied); const s = fs.lstatSync(file); return !s.isSymbolicLink() && (directory ? s.isDirectory() : s.isFile()); } catch { return false; }
}
function readFileWithin(client, file, supplied) {
  assertClientPath(client, file, supplied);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('能力入口不是普通文件');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
    assertClientPath(client, file, supplied);
    if (!sameFile(before, opened) || !sameFile(opened, fs.lstatSync(file, { bigint: true }))) throw new Error('能力入口在打开期间改变');
    const bytes = fs.readFileSync(fd);
    assertClientPath(client, file, supplied);
    if (!sameFile(opened, fs.fstatSync(fd, { bigint: true })) || !sameFile(opened, fs.lstatSync(file, { bigint: true }))) throw new Error('能力入口在读取期间改变');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function directoryToken(dir, parent) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (parent && pathKey(canonical(path.dirname(dir))) !== pathKey(canonical(parent)))) throw new Error('事务暂存目录不是原普通目录');
  return { real: canonical(dir), ...identity(dir, true) };
}
function assertDirectory(dir, token) {
  const current = directoryToken(dir);
  if (!same(current, token) || pathKey(current.real) !== pathKey(token.real)) throw new Error('事务暂存目录身份已改变');
}
module.exports = { FILE, readBindings, validateBindings, bindLibrary, resolveTier, assertClientPath, ordinaryWithin, readFileWithin, directoryToken, assertDirectory };
