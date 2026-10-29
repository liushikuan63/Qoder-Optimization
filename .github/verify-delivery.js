'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { archiveEntries } = require('../scripts/archive-entries.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateManifest(manifest) {
  if (!/^v\d+\.\d+\.\d+$/.test(manifest.tag || '') || manifest.package !== 'Qoder-Optimization-' + manifest.tag.slice(1) || !/^[a-f0-9]{40}$/.test(manifest.commit || '')) throw new Error('invalid build provenance');
  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts) || !artifacts.length || artifacts.length > 2 || artifacts[0].name !== manifest.package + '.zip') throw new Error('invalid artifacts');
  const files = [];
  for (const artifact of artifacts) {
    if (![manifest.package + '.zip', manifest.package + '-offline.zip'].includes(artifact.name) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Array.isArray(artifact.files)) throw new Error('invalid artifact');
    files.push(...artifact.files);
  }
  if (new Set(artifacts.map(a => a.name)).size !== artifacts.length || new Set(files).size !== files.length || JSON.stringify(files.sort()) !== JSON.stringify(Object.keys(manifest.files || {}).sort())) throw new Error('artifact file partition mismatch');
  return artifacts;
}

function verifyDelivery(manifest, dir) {
  const artifacts = validateManifest(manifest);
  let checked = 0;
  for (const artifact of artifacts) {
    const bytes = fs.readFileSync(path.join(dir, artifact.name));
    if (bytes.length !== artifact.size || digest(bytes) !== artifact.sha256) throw new Error('artifact hash or size mismatch: ' + artifact.name);
    const checksum = fs.readFileSync(path.join(dir, artifact.name + '.sha256'), 'utf8');
    if (checksum !== artifact.sha256 + '  ' + artifact.name + '\n') throw new Error('checksum file mismatch');
    const entries = archiveEntries(artifact.name, bytes);
    const found = [];
    for (const entry of entries) {
      const prefix = manifest.package + '/';
      if (!entry.name.startsWith(prefix)) throw new Error('unexpected archive root');
      const name = entry.name.slice(prefix.length);
      if (!artifact.files.includes(name) || digest(entry.data) !== manifest.files[name]) throw new Error('artifact member mismatch: ' + name);
      found.push(name); checked++;
    }
    if (JSON.stringify(found.sort()) !== JSON.stringify([...artifact.files].sort())) throw new Error('artifact members incomplete');
  }
  return { tag: manifest.tag, commit: manifest.commit, files: checked, artifacts: artifacts.length, verified: true };
}

function officialGh(args) {
  const result = spawnSync(process.env.GH_EXECUTABLE || 'gh', args, { timeout: 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    const text = String(result.stderr || result.error?.message || '');
    const error = new Error(/HTTP (401|403)|authentication|login required/i.test(text) ? 'authentication failed; no retry' : 'asset transport failed');
    error.transient = /timeout|timed out|connection|EOF|HTTP (429|50[0234])/i.test(text) && !/HTTP (401|403)/i.test(text);
    throw error;
  }
  return result.stdout;
}

async function downloadDelivery(manifest, dir, repo, { gh = officialGh, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const artifacts = validateManifest(manifest);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('invalid repository');
  const endpoint = 'repos/' + repo;
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'download-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : { repo, tag: manifest.tag, commit: manifest.commit, method: 'official-gh-api-ranges', chunks: {}, completed: false };
  if (state.repo !== repo || state.tag !== manifest.tag || state.commit !== manifest.commit || state.method !== 'official-gh-api-ranges') throw new Error('download state provenance mismatch');
  state.completed = false;
  delete state.verifiedAt;
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  save();
  const release = JSON.parse(gh(['api', endpoint + '/releases/tags/' + manifest.tag]).toString());
  const commit = JSON.parse(gh(['api', endpoint + '/commits/' + manifest.tag]).toString()).sha;
  if (release.draft || release.tag_name !== manifest.tag || commit !== manifest.commit) throw new Error('release or tag mismatch');
  for (const artifact of artifacts) for (const name of [artifact.name, artifact.name + '.sha256']) {
    const matches = release.assets.filter(a => a.name === name);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || !Number.isSafeInteger(matches[0].size) || matches[0].size <= 0) throw new Error('invalid remote asset');
    const asset = matches[0];
    const expectedSize = name === artifact.name ? artifact.size : Buffer.byteLength(artifact.sha256 + '  ' + artifact.name + '\n');
    if (asset.size !== expectedSize) throw new Error('remote asset size mismatch');
    const parts = [], keys = [];
    for (let start = 0; start < asset.size; start += 2 * 1024 * 1024) {
      const end = Math.min(asset.size, start + 2 * 1024 * 1024) - 1;
      const key = asset.id + '-' + start;
      keys.push(key);
      const file = path.join(dir, key + '.part');
      let bytes;
      if (state.chunks[key] && fs.existsSync(file)) {
        const cached = fs.readFileSync(file);
        if (cached.length === end - start + 1 && digest(cached) === state.chunks[key]) bytes = cached;
      }
      if (!bytes) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            bytes = gh(['api', endpoint + '/releases/assets/' + asset.id, '-H', 'Accept: application/octet-stream', '-H', 'Range: bytes=' + start + '-' + end]);
            if (bytes.length !== end - start + 1) throw new Error('range size mismatch');
            break;
          } catch (error) {
            if (!error.transient || attempt === 2) throw error;
            await wait(60000 * (attempt + 1));
          }
        }
        fs.writeFileSync(file, bytes);
        state.chunks[key] = digest(bytes); save();
        await wait(10000);
      }
      parts.push(bytes);
    }
    const assembled = Buffer.concat(parts);
    const valid = name === artifact.name ? digest(assembled) === artifact.sha256 : assembled.toString('utf8') === artifact.sha256 + '  ' + artifact.name + '\n';
    if (!valid) {
      for (const key of keys) {
        const file = path.join(dir, key + '.part');
        if (fs.existsSync(file) && digest(fs.readFileSync(file)) === state.chunks[key]) fs.unlinkSync(file);
        delete state.chunks[key];
      }
      save();
      throw new Error('downloaded content mismatch; invalid cached ranges cleared');
    }
    const target = path.join(dir, name);
    if (fs.existsSync(target) && !fs.readFileSync(target).equals(assembled)) throw new Error('download target already contains different bytes');
    fs.writeFileSync(target, assembled);
  }
  const result = verifyDelivery(manifest, dir);
  state.completed = true; state.verifiedAt = new Date().toISOString(); save();
  return result;
}

module.exports = { verifyDelivery, validateManifest, downloadDelivery };
if (require.main === module) (async () => {
  const [manifestFile, directory, flag, repo] = process.argv.slice(2);
  if (!manifestFile || !directory || (flag && (flag !== '--download' || !repo)) || process.argv.length > 6) throw new Error('usage: node verify-delivery.js <build.json> <directory> [--download owner/repo]');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  if (flag && path.resolve(directory) === path.dirname(path.resolve(manifestFile))) throw new Error('download directory must differ from build directory');
  const result = flag ? await downloadDelivery(manifest, path.resolve(directory), repo) : verifyDelivery(manifest, path.resolve(directory));
  console.log('DELIVERY_VERIFIED ' + JSON.stringify(result));
})().catch(error => { console.error('DELIVERY_FAILED: ' + error.message); process.exitCode = 1; });
