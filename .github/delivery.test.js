'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { verifyDelivery, downloadDelivery } = require('./verify-delivery.js');
const root = path.resolve(__dirname, '..');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');

async function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-test-'));
  const name = 'Qoder-Optimization-0.0.4';
  const manifest = { tag: 'v0.0.4', package: name, commit: 'a'.repeat(40), artifacts: [], files: {} };
  const blobs = new Map();
  try {
    for (const [group, relative, text] of [['core', 'README.md', 'approved core'], ['offline', 'mcp/offline/tool.bin', 'approved offline']]) {
      const input = path.join(dir, group, name), file = path.join(input, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
      const asset = name + (group === 'offline' ? '-offline' : '') + '.zip';
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/pack-folder.js'), input, path.join(dir, asset)], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const bytes = fs.readFileSync(path.join(dir, asset)), sha = hash(bytes);
      const checksum = Buffer.from(sha + '  ' + asset + '\n');
      fs.writeFileSync(path.join(dir, asset + '.sha256'), checksum);
      manifest.artifacts.push({ name: asset, sha256: sha, size: bytes.length, files: [relative] });
      manifest.files[relative] = hash(Buffer.from(text));
      blobs.set(asset, bytes); blobs.set(asset + '.sha256', checksum);
    }
    fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify(manifest));
    const assets = [...blobs].map(([name, data], i) => ({ name, id: i + 101, size: data.length }));
    const calls = [];
    const gh = args => {
      calls.push(args);
      if (args[1].includes('/releases/tags/')) return Buffer.from(JSON.stringify({ tag_name: manifest.tag, draft: false, assets }));
      if (args[1].includes('/commits/')) return Buffer.from(JSON.stringify({ sha: manifest.commit }));
      const id = Number(args[1].split('/').pop());
      const asset = assets.find(a => a.id === id);
      const range = args.find(a => a.startsWith('Range: bytes=')).match(/=(\d+)-(\d+)$/);
      return blobs.get(asset.name).subarray(Number(range[1]), Number(range[2]) + 1);
    };
    await body({ dir, manifest, blobs, gh, calls });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('core and optional offline assets verify as a disjoint complete partition', () => fixture(f => {
  assert.deepEqual(verifyDelivery(f.manifest, f.dir), { tag: 'v0.0.4', commit: 'a'.repeat(40), files: 2, artifacts: 2, verified: true });
  fs.appendFileSync(path.join(f.dir, f.manifest.artifacts[1].name), 'tampered');
  assert.throws(() => verifyDelivery(f.manifest, f.dir), /hash or size/);
}));

test('missing or overlapping artifact members never report success', () => fixture(f => {
  const duplicate = structuredClone(f.manifest);
  duplicate.artifacts[1].files = duplicate.artifacts[0].files;
  assert.throws(() => verifyDelivery(duplicate, f.dir), /partition/);
  fs.unlinkSync(path.join(f.dir, f.manifest.artifacts[1].name + '.sha256'));
  assert.throws(() => verifyDelivery(f.manifest, f.dir));
}));

test('download resolves metadata, receives network bytes and verifies before marking complete', () => fixture(async f => {
  const dir = path.join(f.dir, 'download');
  const result = await downloadDelivery(f.manifest, dir, 'example/repository', { gh: f.gh, wait: async () => {} });
  assert.equal(result.verified, true);
  assert.equal(f.calls.filter(c => c[1].includes('/releases/assets/')).length, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'download-state.json'))).completed, true);
  const count = f.calls.length;
  await downloadDelivery(f.manifest, dir, 'example/repository', { gh: f.gh, wait: async () => {} });
  assert.equal(f.calls.length - count, 2);
}));

test('authentication failure is not retried or marked complete', () => fixture(async f => {
  let failed = 0;
  const dir = path.join(f.dir, 'download');
  await assert.rejects(downloadDelivery(f.manifest, dir, 'example/repository', { gh: args => {
    if (args[1].includes('/releases/assets/')) { failed++; throw new Error('authentication failed; no retry'); }
    return f.gh(args);
  }, wait: async () => {} }), /authentication/);
  assert.equal(failed, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'download-state.json'))).completed, false);
}));

test('a failed recheck clears a previous completed state', () => fixture(async f => {
  const dir = path.join(f.dir, 'download');
  await downloadDelivery(f.manifest, dir, 'example/repository', { gh: f.gh, wait: async () => {} });
  fs.appendFileSync(path.join(dir, f.manifest.artifacts[0].name), 'changed');
  await assert.rejects(downloadDelivery(f.manifest, dir, 'example/repository', { gh: f.gh, wait: async () => {} }), /different bytes/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'download-state.json'))).completed, false);
}));

test('bad range bytes are discarded so the next attempt can recover', () => fixture(async f => {
  const dir = path.join(f.dir, 'download');
  await assert.rejects(downloadDelivery(f.manifest, dir, 'example/repository', { gh: args => {
    const bytes = f.gh(args);
    return args[1].includes('/releases/assets/') ? Buffer.alloc(bytes.length, 1) : bytes;
  }, wait: async () => {} }), /invalid cached ranges cleared/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'download-state.json')));
  assert.equal(state.completed, false);
  assert.equal(Object.keys(state.chunks).length, 0);
  const result = await downloadDelivery(f.manifest, dir, 'example/repository', { gh: f.gh, wait: async () => {} });
  assert.equal(result.verified, true);
}));

test('delivery CLI propagates verification failure as a nonzero process exit', () => fixture(f => {
  const cli = path.join(__dirname, 'verify-delivery.js');
  const args = [cli, path.join(f.dir, 'build.json'), f.dir];
  let result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  fs.unlinkSync(path.join(f.dir, f.manifest.artifacts[0].name));
  result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes('DELIVERY_VERIFIED'), false);
}));
