#!/usr/bin/env node
'use strict';
// Observe the arguments already delivered to this process. Never replay them.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function expectedArgs(file) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > 65536n) throw new Error('EXPECTATION_FILE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
    if (!same(before, opened)) throw new Error('EXPECTATION_CHANGED');
    const bytes = fs.readFileSync(fd);
    if (!same(opened, fs.fstatSync(fd, { bigint: true })) || !same(opened, fs.lstatSync(file, { bigint: true }))) throw new Error('EXPECTATION_CHANGED');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''));
    if (!Array.isArray(value) || value.length > 256 || value.some(x => typeof x !== 'string' || x.length > 8192)) throw new Error('EXPECTATION_SCHEMA');
    return value;
  } finally { fs.closeSync(fd); }
}
function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node shell-boundary-probe.cjs [--expect-file <JSON string array> -- <literal arguments>]\nNo command is executed. Exit 0: match or diagnostics; 1: mismatch; 2: invalid input.');
    return 0;
  }
  if (!args.length) {
    console.log(JSON.stringify({ schema: 1, status: 'INFO', platform: process.platform, node: process.version, executable: process.execPath, cwd: process.cwd(), msysDetected: Boolean(process.env.MSYSTEM), conversionExclusionPresent: Boolean(process.env.MSYS2_ARG_CONV_EXCL || process.env.MSYS_NO_PATHCONV), callerShellVerified: false }));
    return 0;
  }
  if (args[0] !== '--expect-file' || !args[1] || args[2] !== '--') throw new Error('USAGE');
  const expected = expectedArgs(args[1]), received = args.slice(3);
  if (received.length > 256 || received.some(x => x.length > 8192)) throw new Error('ARGUMENT_LIMIT');
  const mismatchedIndices = [];
  for (let i = 0; i < Math.max(expected.length, received.length); i++) if (expected[i] !== received[i]) mismatchedIndices.push(i);
  const matched = mismatchedIndices.length === 0;
  console.log(JSON.stringify({ schema: 1, status: matched ? 'MATCH' : 'MISMATCH', expectedCount: expected.length, receivedCount: received.length, expectedDigest: hash(expected), receivedDigest: hash(received), mismatchedIndices }));
  return matched ? 0 : 1;
}
module.exports = { main };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { console.error('BOUNDARY_PROBE_ERROR: invalid arguments, unreadable or changed expectation file'); process.exitCode = 2; }
}
