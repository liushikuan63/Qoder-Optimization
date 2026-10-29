'use strict';
const zlib = require('zlib');
const path = require('path');

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20000;

function safeName(name) {
  const clean = name.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
  if (!clean || clean === '.') return '';
  if (path.posix.isAbsolute(clean) || /[\\:\x00-\x1f]/.test(clean) || clean.split('/').some(p => p === '..' || !p)) throw new Error('unsafe archive member');
  return clean;
}

function tarEntries(bytes) {
  const entries = [];
  let offset = 0;
  let pendingName;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const text = (a, b) => header.subarray(a, b).toString('utf8').split('\0')[0];
    const size = parseInt(text(124, 136).trim(), 8);
    const checksum = parseInt(text(148, 156).trim(), 8);
    const actual = header.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    if (actual !== checksum || !Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES || offset + 512 + size > bytes.length) throw new Error('invalid tar header or size');
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = text(156, 157);
    if (type === 'x' || type === 'g') {
      let p = 0;
      while (p < data.length) {
        const space = data.indexOf(32, p);
        const n = Number(data.subarray(p, space).toString());
        if (space < p || !Number.isSafeInteger(n) || n <= space - p + 1 || p + n > data.length) throw new Error('invalid pax record');
        const record = data.subarray(space + 1, p + n - 1).toString();
        if (record.startsWith('path=')) pendingName = record.slice(5);
        if (record.startsWith('GNU.sparse')) throw new Error('sparse archive unsupported');
        p += n;
      }
      continue;
    }
    if (type === 'L') { pendingName = data.toString().split('\0')[0]; continue; }
    const name = safeName(pendingName || (text(345, 500) ? text(345, 500) + '/' : '') + text(0, 100));
    pendingName = undefined;
    if (type === '5') continue;
    if (type !== '0' && type !== '') throw new Error('archive links and special members unsupported');
    if (!name || entries.some(e => e.name === name)) throw new Error('duplicate or empty archive member');
    entries.push({ name, data });
    if (entries.length > MAX_ENTRIES) throw new Error('archive entry limit exceeded');
  }
  if (!entries.length || offset > bytes.length) throw new Error('empty or truncated tar');
  return entries;
}

function zipEntries(bytes) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) throw new Error('invalid zip directory');
  if (bytes.readUInt32LE(end + 4) !== 0) throw new Error('multi-disk zip unsupported');
  const count = bytes.readUInt16LE(end + 10);
  if (!count || count > MAX_ENTRIES || bytes.readUInt16LE(end + 8) !== count) throw new Error('zip entry count invalid');
  const centralStart = bytes.readUInt32LE(end + 16);
  if (centralStart + bytes.readUInt32LE(end + 12) !== end) throw new Error('zip directory size mismatch');
  let cursor = centralStart;
  let total = 0;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('invalid zip member');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), packed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const n = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16, local = bytes.readUInt32LE(cursor + 42);
    if (flags & 1 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || cursor + 46 + n + extra + comment > end) throw new Error('unsupported zip member');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + n).toString('utf8');
    const name = safeName(rawName);
    cursor += 46 + n + extra + comment;
    if (rawName.endsWith('/')) continue;
    total += size;
    if (total > MAX_BYTES || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('zip size limit or header invalid');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + packed > centralStart) throw new Error('truncated zip data');
    const compressed = bytes.subarray(start, start + packed);
    const data = method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
    if (data.length !== size || zlib.crc32(data) !== crc || !name || entries.some(e => e.name === name)) throw new Error('zip checksum, size or name mismatch');
    entries.push({ name, data });
  }
  if (cursor !== end) throw new Error('zip directory count mismatch');
  if (!entries.length) throw new Error('empty zip');
  return entries;
}

function archiveEntries(name, bytes) {
  if (/\.zip$/i.test(name)) return zipEntries(bytes);
  if (/\.(?:tar\.gz|tgz)$/i.test(name)) return tarEntries(zlib.gunzipSync(bytes, { maxOutputLength: MAX_BYTES }));
  if (/\.tar$/i.test(name)) return tarEntries(bytes);
  if (/\.gz$/i.test(name)) return [{ name: safeName(path.basename(name).slice(0, -3)), data: zlib.gunzipSync(bytes, { maxOutputLength: MAX_BYTES }) }];
  return null;
}

function encodeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const name = safeName(entry.name), data = Buffer.from(entry.data);
    if (Buffer.byteLength(name) > 100) throw new Error('tar member name exceeds 100 bytes');
    const h = Buffer.alloc(512);
    const field = (value, offset, length) => h.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    h.write(name, 0, 100, 'utf8');
    field(0o644, 100, 8); field(0, 108, 8); field(0, 116, 8);
    field(data.length, 124, 12); field(0, 136, 12);
    h.fill(32, 148, 156); h[156] = 48; h.write('ustar\0', 257, 6); h.write('00', 263, 2);
    h.write(h.reduce((sum, b) => sum + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

module.exports = { archiveEntries, tarEntries, safeName, encodeTar, MAX_BYTES };
