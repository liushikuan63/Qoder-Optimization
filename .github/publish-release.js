#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256 } = require('./build-release.js');

function officialGh(args) {
  return spawnSync(process.env.GH_EXECUTABLE || 'gh', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
}

function publishRelease({ repo, tag, dest, gh = officialGh }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo || '') || !/^v\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('invalid repository or tag');
  const invoke = (args, allow404 = false) => {
    const result = gh(args);
    if (allow404 && !result.error && result.status !== 0 && /\(HTTP 404\)/.test(result.stderr || '')) return null;
    if (result.error || result.status !== 0) throw new Error(`gh failed (exit=${result.status}): ${(result.stderr || result.error?.message || '').slice(0, 1000)}`);
    return result.stdout || '';
  };
  const endpoint = `repos/${repo}/releases/tags/${tag}`;
  const getRelease = () => {
    const text = invoke(['api', endpoint], true);
    if (text !== null) return JSON.parse(text);
    const pages = JSON.parse(invoke(['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp']));
    const matches = pages.flat().filter(release => release.tag_name === tag);
    if (matches.length > 1) throw new Error('multiple releases share the requested tag; nothing replaced');
    return matches[0] || null;
  };
  const evidence = JSON.parse(fs.readFileSync(path.join(dest, 'build.json'), 'utf8'));
  const name = 'Qoder-Optimization-' + tag.slice(1);
  const assets = [name + '.zip', name + '.zip.sha256'];
  if (evidence.tag !== tag || evidence.package !== name || !/^[a-f0-9]{40}$/.test(evidence.commit || '')) throw new Error('build provenance does not match release');
  if (sha256(path.join(dest, assets[0])) !== evidence.sha256 ||
      fs.readFileSync(path.join(dest, assets[1]), 'utf8') !== `${evidence.sha256}  ${assets[0]}\n`) throw new Error('local asset checksum mismatch');
  const remoteCommit = invoke(['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha']).trim();
  if (remoteCommit !== evidence.commit) throw new Error('remote tag does not match the tested source commit');
  let release = getRelease();
  if (!release) {
    invoke(['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--target', evidence.commit, '--title', `Qoder-Optimization ${tag.slice(1)}`, '--generate-notes']);
    release = getRelease();
  }
  if (!release || release.tag_name !== tag || !Array.isArray(release.assets)) throw new Error('invalid remote release metadata');
  if (release.assets.some(asset => !assets.includes(asset.name))) throw new Error('unexpected existing assets; no assets replaced');
  const temp = fs.mkdtempSync(path.join(dest, '.verify-remote-'));
  try {
    for (const asset of assets) {
      const local = path.join(dest, asset);
      const existing = release.assets.find(item => item.name === asset);
      if (!existing) invoke(['release', 'upload', tag, local, '--repo', repo]);
      invoke(['release', 'download', tag, '--repo', repo, '--pattern', asset, '--dir', temp]);
      const downloaded = path.join(temp, asset);
      if (!fs.existsSync(downloaded) || fs.statSync(downloaded).size !== fs.statSync(local).size || sha256(downloaded) !== sha256(local)) {
        throw new Error('remote asset content mismatch; left untouched: ' + asset);
      }
    }
    release = getRelease();
    if (!release || release.assets.length !== assets.length || assets.some(name => !release.assets.some(asset => asset.name === name))) throw new Error('remote asset set is incomplete');
    if (release.draft) invoke(['release', 'edit', tag, '--repo', repo, '--draft=false']);
    const published = getRelease();
    if (!published || published.draft || !published.html_url) throw new Error('release publication was not confirmed');
    return { url: published.html_url, sha256: evidence.sha256, assets };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { publishRelease };
if (require.main === module) {
  try {
    const [tag, dest, repo = process.env.GITHUB_REPOSITORY] = process.argv.slice(2);
    if (!dest || process.argv.length > 5) throw new Error('usage: node .github/publish-release.js <vX.Y.Z> <dist-dir> [owner/repo]');
    const result = publishRelease({ repo, tag, dest: path.resolve(dest) });
    console.log(`VERIFIED ${result.url} sha256=${result.sha256}`);
  } catch (error) { console.error('PUBLISH_FAILED: ' + error.message); process.exitCode = 1; }
}
