#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256 } = require('./build-release.js');

function officialGh(args) {
  return spawnSync(process.env.GH_EXECUTABLE || 'gh', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
}


function changelogNotes(root, version) {
  try {
    const raw = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const lines = raw.split(String.fromCharCode(13)).join('').split(String.fromCharCode(10));
    const start = lines.findIndex(line => line.startsWith('## [' + version + ']'));
    if (start < 0) return null;
    const body = [];
    for (let i = start + 1; i < lines.length && !lines[i].startsWith('## ['); i++) body.push(lines[i]);
    const notes = body.join(String.fromCharCode(10)).trim();
    return notes || null;
  } catch { return null; }
}


// 中文摘要单一真源＝CHANGELOG 对应版本节的 ### 中文摘要；tag 附注与 Release 正文都从这里取，不手抄。
function chineseSummary(root, version) {
  const notes = changelogNotes(root, version);
  if (!notes) return null;
  const lines = notes.split(String.fromCharCode(10));
  const start = lines.findIndex(line => /^###\s*中文摘要\s*$/.test(line));
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const bullets = body.filter(line => line.trim().startsWith('- '));
  return bullets.length ? bullets.join(String.fromCharCode(10)) : null;
}

function composeTagMessage(root, version) {
  const zh = chineseSummary(root, version);
  if (!zh) throw new Error('CHANGELOG [' + version + '] 缺少非空中文摘要，拒绝生成 tag 附注');
  return 'Qoder-Optimization ' + version + String.fromCharCode(10, 10) + '### 中文摘要' + String.fromCharCode(10, 10) + zh + String.fromCharCode(10);
}

// 0.1.6/0.1.7 的 tag 附注只有英文一行（用户 2026-11-15 指出的遗漏）。0.2.0 起硬拦：
// 附注必须含中文摘要标题且至少一条非空条目；轻量 tag（无附注）一律拒绝。
function assertTagMessage(message, version) {
  const text = String(message == null ? '' : message);
  if (!/中文摘要/.test(text)) throw new Error('tag ' + version + ' 附注缺中文摘要（0.2.0 起硬拦；轻量 tag 或英文一行都不放行）。若附注本有标题却消失，多半是 git 默认 cleanup=strip 把 "### 中文摘要" 当注释删了：改用 git tag -a --cleanup=verbatim -F <附注> 重打');
  const bullets = text.split(String.fromCharCode(10)).filter(line => line.trim().startsWith('- '));
  if (!bullets.length) throw new Error('tag ' + version + ' 附注的中文摘要为空');
  return true;
}

// 读远端 tag 对象附注。type=commit 表示轻量 tag，没有附注 ⇒ 返回 null 由调用方判红。
function remoteTagMessage(invoke, repo, tag) {
  const ref = JSON.parse(invoke(['api', 'repos/' + repo + '/git/ref/tags/' + tag]));
  const obj = ref && ref.object ? ref.object : null;
  if (!obj || !obj.sha) throw new Error('remote tag ref is unreadable: ' + tag);
  if (obj.type !== 'tag') return null;
  const tagObj = JSON.parse(invoke(['api', 'repos/' + repo + '/git/tags/' + obj.sha]));
  return tagObj && typeof tagObj.message === 'string' ? tagObj.message : null;
}

function publishRelease({ repo, tag, dest, gh = officialGh, root = process.cwd() }) {
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
  if (evidence.tag !== tag || evidence.package !== name || !/^[a-f0-9]{40}$/.test(evidence.commit || '')) throw new Error('build provenance does not match release');
  const artifacts = evidence.artifacts;
  if (!Array.isArray(artifacts) || !artifacts.length || artifacts.length > 2 || artifacts[0].name !== name + '.zip' ||
      new Set(artifacts.map(a => a.name)).size !== artifacts.length || artifacts.some(a => ![name + '.zip', name + '-offline.zip'].includes(a.name))) throw new Error('invalid build artifact list');
  const assets = artifacts.flatMap(artifact => [artifact.name, artifact.name + '.sha256']);
  for (const artifact of artifacts) {
    if (sha256(path.join(dest, artifact.name)) !== artifact.sha256 ||
        fs.readFileSync(path.join(dest, artifact.name + '.sha256'), 'utf8') !== `${artifact.sha256}  ${artifact.name}\n`) throw new Error('local asset checksum mismatch');
  }
  const remoteCommit = invoke(['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha']).trim();
  if (remoteCommit !== evidence.commit) throw new Error('remote tag does not match the tested source commit');
  // tag 附注中文摘要硬判据（在上传/发布任何资产之前判，失败即停、远端零改动）
  assertTagMessage(remoteTagMessage(invoke, repo, tag), tag);
  const byId = id => JSON.parse(invoke(['api', `repos/${repo}/releases/${id}`]));
  const reconcileLatest = published => {
    const version = item => !item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name || '')
      ? item.tag_name.slice(1).split('.').map(BigInt) : null;
    const observed = [];
    const highest = () => {
      const pages = JSON.parse(invoke(['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp']));
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('invalid release listing for Latest reconciliation');
      // Include the just-verified release while the listing is catching up.
      return [...pages.flat(), published, ...observed].filter(item => item && version(item)).reduce((best, item) => {
        if (!Number.isSafeInteger(item.id) || item.id <= 0) throw new Error('invalid stable release identity');
        if (!best) return item;
        const a = version(item), b = version(best);
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? item : best;
        return best;
      }, null);
    };
    const latest = () => {
      const value = invoke(['api', `repos/${repo}/releases/latest`], true);
      return value === null ? null : JSON.parse(value);
    };
    // Publication jobs share a repository-wide lock. Re-read as well because
    // older workflows and manual publishers do not participate in that lock.
    for (let attempt = 0; attempt < 3; attempt++) {
      // A stale paginated list must not erase a higher stable release already
      // returned by /latest, including one observed in a previous attempt.
      const current = latest();
      if (current) observed.push(current);
      const target = highest();
      if (!target) throw new Error('no stable release is available for Latest');
      if (current?.id !== target.id) invoke(['api', '--method', 'PATCH', `repos/${repo}/releases/${target.id}`, '-f', 'make_latest=true']);
      const confirmed = latest();
      if (confirmed) observed.push(confirmed);
      const refreshed = highest();
      if (confirmed?.id === target.id && confirmed.tag_name === target.tag_name && refreshed.id === target.id) return target.tag_name;
    }
    throw new Error('Latest did not stabilize within the reconciliation budget; published assets retained');
  };
  let release = getRelease();
  let releaseId = release && release.id;
  if (!release) {
    // gh release create returns no id, and a fresh draft is not reliably visible by tag
    // (no tag lookup for drafts, GITHUB_TOKEN viewerPermission is null). Create through the
    // REST API so the response carries the id every later step can read back.
    // The tag already exists and was checked against evidence.commit above.
    // Sending target_commitish as a 40-char SHA makes the releases API answer 404.
    const args = ['api', '--method', 'POST', `repos/${repo}/releases`, '-f', `tag_name=${tag}`, '-f', `name=Qoder-Optimization ${tag.slice(1)}`, '-F', 'draft=true', '-f', 'make_latest=false'];
    const notes = changelogNotes(root, tag.slice(1));
    let dir = null;
    try {
      if (notes) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qo-notes-'));
        const file = path.join(dir, 'notes.md');
        fs.writeFileSync(file, notes + String.fromCharCode(10));
        args.push('-F', `body=@${file}`);
      } else {
        args.push('-F', 'generate_release_notes=true');
      }
      release = JSON.parse(invoke(args));
    } finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
    if (!release || !Number.isSafeInteger(release.id)) throw new Error('release creation returned no id');
    releaseId = release.id;
  }
  if (!release || release.tag_name !== tag || !Array.isArray(release.assets)) {
    release = byId(releaseId);
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
    release = byId(releaseId);
    if (!release || release.assets.length !== assets.length || assets.some(name => !release.assets.some(asset => asset.name === name))) throw new Error('remote asset set is incomplete');
    if (release.draft) invoke(['api', '--method', 'PATCH', `repos/${repo}/releases/${releaseId}`, '-F', 'draft=false', '-f', 'make_latest=false']);
    const published = byId(releaseId);
    if (!published || published.draft || !published.html_url) throw new Error('release publication was not confirmed');
    const latestTag = reconcileLatest(published);
    return { url: published.html_url, sha256: evidence.sha256, assets, latestTag };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { publishRelease, changelogNotes, chineseSummary, composeTagMessage, assertTagMessage, remoteTagMessage };
if (require.main === module) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === '--print-tag-message') {
      if (!/^v\d+\.\d+\.\d+$/.test(argv[1] || '')) throw new Error('usage: node .github/publish-release.js --print-tag-message <vX.Y.Z>');
      process.stdout.write(composeTagMessage(process.cwd(), argv[1].slice(1)));
      process.exit(0);
    }
    const [tag, dest, repo = process.env.GITHUB_REPOSITORY] = argv;
    if (!dest || process.argv.length > 5) throw new Error('usage: node .github/publish-release.js <vX.Y.Z> <dist-dir> [owner/repo]');
    const result = publishRelease({ repo, tag, dest: path.resolve(dest) });
    console.log(`VERIFIED ${result.url} sha256=${result.sha256} latest=${result.latestTag}`);
  } catch (error) { console.error('PUBLISH_FAILED: ' + error.message); process.exitCode = 1; }
}
