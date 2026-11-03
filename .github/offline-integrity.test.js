'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkOffline } = require('./check-release.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-integrity-'));
  const dir = path.join(root, 'mcp/offline'); fs.mkdirSync(dir, { recursive: true });
  const data = Buffer.from('Fixture license\n'), hash = crypto.createHash('sha256').update(data).digest('hex');
  const files = ['mcp/offline/LICENSE-cua-driver.txt', 'mcp/offline/SHA256SUMS'];
  fs.writeFileSync(path.join(dir, 'LICENSE-cua-driver.txt'), data);
  const manifest = text => fs.writeFileSync(path.join(dir, 'SHA256SUMS'), text);
  manifest('## SHA256 Checksums\n```\n' + hash + '  LICENSE-cua-driver.txt\n```\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, files, data, hash, manifest };
}

test('offline checksums bind exact distributed bytes including license line endings', t => {
  const f = fixture(t); assert.deepEqual(checkOffline(f.root, f.files), []);
  fs.writeFileSync(path.join(f.dir, 'LICENSE-cua-driver.txt'), f.data.toString().replace(/\n/g, '\r\n'));
  assert.match(checkOffline(f.root, f.files).join('\n'), /checksum mismatch/);
});
for (const kind of ['missing-manifest', 'missing-entry', 'duplicate-entry', 'traversal', 'unlisted-file']) {
  test('offline gate rejects ' + kind, t => {
    const f = fixture(t);
    if (kind === 'missing-manifest') { fs.unlinkSync(path.join(f.dir, 'SHA256SUMS')); f.files.pop(); }
    if (kind === 'missing-entry') f.manifest('## SHA256 Checksums\n```\n```\n');
    if (kind === 'duplicate-entry') f.manifest((f.hash + '  LICENSE-cua-driver.txt\n').repeat(2));
    if (kind === 'traversal') f.manifest(f.hash + '  ../outside.txt\n');
    if (kind === 'unlisted-file') { fs.writeFileSync(path.join(f.dir, 'tool.bin'), 'tool'); f.files.push('mcp/offline/tool.bin'); }
    assert.ok(checkOffline(f.root, f.files).length > 0);
  });
}
