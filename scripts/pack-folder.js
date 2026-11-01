#!/usr/bin/env node
/**
 * pack-folder.js — 生成兼容性最好的 zip 包（UTF-8 文件名 + Unix 来源标记）
 *
 * 背景：PowerShell Compress-Archive 生成的是 DOS 来源 zip，MSYS/Git Bash 的
 * unzip 对其中文文件名会按本地代码页误转成乱码；Unix 来源 + UTF-8 标志位的
 * zip 在 Windows 资源管理器 / PowerShell / unzip 下都能正确解出中文名。
 *
 * 用法: node pack-folder.js <待打包文件夹> [输出.zip]
 * 默认输出到文件夹同级目录的 <文件夹名>.zip
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fixedTime = process.env.SOURCE_DATE_EPOCH === undefined ? null : Number(process.env.SOURCE_DATE_EPOCH) * 1000;
if (fixedTime !== null && (!Number.isFinite(fixedTime) || fixedTime < Date.UTC(1980, 0, 1) || fixedTime >= Date.UTC(2108, 0, 1))) {
  throw new Error('SOURCE_DATE_EPOCH must fit the ZIP timestamp range');
}

const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(mtime) {
  const d = new Date(fixedTime === null ? mtime : fixedTime);
  const get = name => d[(fixedTime === null ? 'get' : 'getUTC') + name]();
  // Files generated with an epoch mtime are common. ZIP can represent only
  // 1980..2107; clamp implicit filesystem dates, while explicit epochs stay strict.
  const year = get('FullYear');
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 };
  const time = (get('Hours') << 11) | (get('Minutes') << 5) | Math.floor(get('Seconds') / 2);
  const date = ((get('FullYear') - 1980) << 9) | ((get('Month') + 1) << 5) | get('Date');
  return { time, date };
}

// 备份 / 临时件不入包：实测发生过把改文档时留下的 `*.md.bak-cua-<ts>` 一起打进分享包，
// 收件人解包看到两份互相矛盾的"当前版"文档。判据同时加在 check-share-docs.js 里兜底。
// 字符类含下划线命名（.bak_20261013 曾漏网，2026-10-13 补）。
const SKIP = /(\.bak([-._][^/]*)?|~|\.tmp|\.swp|\.orig)$/i;

function walk(dir, base, entries) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (SKIP.test(name)) { console.error(`[skip] 备份/临时件不入包：${base ? base + '/' : ''}${name}`); continue; }
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) throw new Error('不打包符号链接或 junction：' + rel);
    if (st.isDirectory()) {
      entries.push({ name: rel + '/', isDir: true, mtime: st.mtimeMs });
      walk(full, rel, entries);
    } else if (st.isFile()) {
      entries.push({ name: rel, isDir: false, mtime: st.mtimeMs, full, stat: st });
    } else throw new Error('不打包非常规文件：' + rel);
  }
}

function sameSource(actual, expected) {
  return actual.isFile() && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => actual[key] === expected[key]);
}

function readEntry(entry) {
  // Bind the read to the object observed by walk, rather than following a path
  // again after a parent directory may have been replaced with a junction.
  // Nonblocking open also avoids hanging if a regular file is replaced by a FIFO.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(entry.full, flags);
  try {
    const before = fs.fstatSync(fd);
    if (!sameSource(before, entry.stat)) throw new Error('源文件在扫描后已变化：' + entry.name);
    const data = fs.readFileSync(fd);
    if (data.length !== before.size || !sameSource(fs.fstatSync(fd), before)) throw new Error('源文件在读取期间已变化：' + entry.name);
    return data;
  } finally { fs.closeSync(fd); }
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime);
    let data = Buffer.alloc(0);
    let compressed = Buffer.alloc(0);
    let method = 0;

    if (!e.isDir) {
      data = readEntry(e);
      compressed = zlib.deflateRawSync(data, { level: 9 });
      method = 8;
    }

    const crc = e.isDir ? 0 : crc32(data);
    const compSize = e.isDir ? 0 : compressed.length;
    const uncompSize = e.isDir ? 0 : data.length;
    const flags = 0x800; // UTF-8 标志位
    const extAttr = e.isDir ? 0x41ff0000 : 0x81b60000; // Unix 权限位 040755 / 0100664

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x14, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    chunks.push(local, nameBuf);
    if (!e.isDir) chunks.push(compressed);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(0x0314, 4); // version made by: Unix (3) + v2.0 (0x14)
    cen.writeUInt16LE(0x14, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compSize, 20);
    cen.writeUInt32LE(uncompSize, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk start
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(extAttr, 38);
    cen.writeUInt32LE(offset, 42);

    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + compSize;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const folder = process.argv[2];
if (!folder) {
  console.error('用法: node pack-folder.js <待打包文件夹> [输出.zip]');
  process.exit(1);
}
const abs = path.resolve(folder);
if (!fs.existsSync(abs) || !fs.lstatSync(abs).isDirectory()) {
  console.error('错误: 文件夹不存在: ' + abs);
  process.exit(1);
}
const folderName = path.basename(abs);
const out = path.resolve(process.argv[3] || path.join(path.dirname(abs), folderName + '.zip'));
// Resolve the output's existing ancestor as well as the source. An external
// junction can otherwise put the output back inside the tree being archived.
let parent = path.dirname(out);
const tail = [path.basename(out)];
while (!fs.existsSync(parent)) {
  tail.unshift(path.basename(parent));
  const next = path.dirname(parent);
  if (next === parent) throw new Error('无法定位输出目录的已有父级');
  parent = next;
}
const realOutput = path.resolve(fs.realpathSync(parent), ...tail);
const relative = path.relative(fs.realpathSync(abs), realOutput);
if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
  throw new Error('输出 ZIP 必须在待打包文件夹之外');
}
try {
  if (fs.lstatSync(out).isSymbolicLink()) throw new Error('输出 ZIP 不能是符号链接');
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const entries = [{ name: folderName + '/', isDir: true, mtime: fs.statSync(abs).mtimeMs }];
walk(abs, folderName, entries);
const zipBuf = buildZip(entries);
fs.writeFileSync(out, zipBuf);
console.log('已生成: ' + out);
console.log('条目数: ' + entries.length + '（含目录项）');
for (const e of entries) console.log('  ' + e.name);
