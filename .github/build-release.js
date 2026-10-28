#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PUBLIC_PATHS, isPublicFile } = require('../scripts/pack-share-extras.cjs');
const { checkRelease, walk } = require('./check-release.js');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed (exit=${result.status}): ${(result.stderr || result.error?.message || result.stdout || '').slice(0, 1000)}`);
  return result.stdout;
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function windowsLineEndings(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10 && bytes[i - 1] !== 13) out.push(13);
    out.push(bytes[i]);
  }
  return Buffer.from(out);
}

function verifyZip(zip, name, expectedFiles) {
  run('unzip', ['-tqq', zip], path.dirname(zip));
  const names = run('unzip', ['-Z1', zip], path.dirname(zip)).trim().split(/\r?\n/);
  const prefix = name + '/';
  for (const entry of names) {
    if (entry === prefix) continue;
    if (!entry.startsWith(prefix) || !isPublicFile(entry.slice(prefix.length).replace(/\/$/, ''))) throw new Error('unexpected ZIP entry: ' + entry);
  }
  const actual = names.filter(entry => !entry.endsWith('/')).map(entry => entry.slice(prefix.length)).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify([...expectedFiles].sort())) throw new Error('ZIP file set differs from the approved source');
  return actual;
}

function buildRelease({ root, tag, dest, ref = tag }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) throw new Error('tag must be vX.Y.Z');
  if (!/^(?:HEAD|v\d+\.\d+\.\d+|[a-f0-9]{40})$/.test(ref || '')) throw new Error('ref must be HEAD, a release tag or a full commit SHA');
  root = path.resolve(root);
  dest = path.resolve(dest);
  const relative = path.relative(root, dest);
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('build destination must be outside the repository');
  const commit = run('git', ['rev-parse', '--verify', ref + '^{commit}'], root).trim();
  const epoch = run('git', ['show', '-s', '--format=%ct', commit], root).trim();
  const tree = run('git', ['ls-tree', '-rz', '--full-tree', commit], root).split('\0').filter(Boolean).map(line => {
    const match = line.match(/^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/s);
    if (!match) throw new Error('unreadable Git tree');
    return { mode: match[1], type: match[2], name: match[4] };
  }).filter(entry => !entry.name.startsWith('.github/'));
  for (const entry of tree) {
    if (!isPublicFile(entry.name) || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error('unapproved tracked file: ' + entry.name);
  }
  const sourceFiles = tree.map(entry => entry.name).sort();
  if (!sourceFiles.length) throw new Error('empty release source');
  const name = 'Qoder-Optimization-' + tag.slice(1);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of [name, name + '.zip', name + '.zip.sha256', 'build.json']) {
    if (fs.existsSync(path.join(dest, file))) throw new Error('output already exists; use a fresh directory: ' + file);
  }
  const temp = fs.mkdtempSync(path.join(dest, '.build-'));
  try {
    const packageDir = path.join(temp, name);
    fs.mkdirSync(packageDir);
    const selected = PUBLIC_PATHS.filter(item => sourceFiles.some(file => file === item || file.startsWith(item + '/')));
    run('git', ['archive', '--format=tar', '--output=' + path.join(temp, 'source.tar'), commit, '--', ...selected], root);
    run('tar', ['-xf', 'source.tar', '-C', name], temp);
    for (const file of sourceFiles.filter(file => /\.(cmd|bat|ps1)$/i.test(file))) {
      const full = path.join(packageDir, file);
      fs.writeFileSync(full, windowsLineEndings(fs.readFileSync(full)));
    }
    const result = checkRelease(packageDir, tag);
    if (result.problems.length) throw new Error('release gate failed:\n' + result.problems.join('\n'));
    if (JSON.stringify(result.files) !== JSON.stringify(sourceFiles)) throw new Error('archive file set differs from Git');
    const zip = path.join(temp, name + '.zip');
    run(process.execPath, [path.join(packageDir, 'scripts', 'pack-folder.js'), packageDir, zip], temp, { ...process.env, SOURCE_DATE_EPOCH: epoch });
    verifyZip(zip, name, sourceFiles);
    const verification = path.join(temp, 'verify');
    fs.mkdirSync(verification);
    run('unzip', ['-q', zip, '-d', verification], temp);
    const extracted = path.join(verification, name);
    if (JSON.stringify(walk(extracted)) !== JSON.stringify(sourceFiles)) throw new Error('extracted file set differs from Git');
    const hashes = {};
    for (const file of sourceFiles) {
      hashes[file] = sha256(path.join(packageDir, file));
      if (hashes[file] !== sha256(path.join(extracted, file))) throw new Error('extracted content differs: ' + file);
    }
    const digest = sha256(zip);
    fs.copyFileSync(zip, path.join(dest, name + '.zip'), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(dest, name + '.zip.sha256'), `${digest}  ${name}.zip\n`, { flag: 'wx' });
    fs.renameSync(packageDir, path.join(dest, name));
    const evidence = { tag, commit, epoch: Number(epoch), package: name, sha256: digest, files: hashes };
    fs.writeFileSync(path.join(dest, 'build.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    return evidence;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { buildRelease, verifyZip, windowsLineEndings, sha256 };
if (require.main === module) {
  try {
    const [tag, dest, ref] = process.argv.slice(2);
    if (!dest || process.argv.length > 5) throw new Error('usage: node .github/build-release.js <vX.Y.Z> <outside-dist-dir> [commit-or-HEAD]');
    const result = buildRelease({ root: process.cwd(), tag, dest, ref: ref || tag });
    console.log(`BUILT ${result.package}.zip commit=${result.commit} files=${Object.keys(result.files).length} sha256=${result.sha256}`);
  } catch (error) { console.error('BUILD_FAILED: ' + error.message); process.exitCode = 1; }
}
