'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256 } = require('./build-release.js');
const { verifyDelivery, validateManifest } = require('./verify-delivery.js');
const { isPublicFile } = require('../scripts/pack-share-extras.cjs');
const repository = 'liushikuan63/Qoder-Optimization';

// This platform-specific companion was built separately. Verify the exact
// published bytes before carrying them forward; never build it implicitly.
const ocrPin = Object.freeze({
  repository,
  tag: 'v0.2.3',
  asset: 'Qoder-Optimization-0.2.3-ocr-bundle-cp314-win_amd64.zip',
  size: 138538825,
  sha256: 'c630a988bbfdbdfe727d4e2001f85f2880a1b86d5282ee223199a81f4f9cae91',
});
const automatedChecks = {
  frozenCheckout: 'QODER_FROZEN_CHECKOUT',
  ubuntuSelfTests: 'QODER_UBUNTU_SELF_TESTS',
  windowsSelfTests: 'QODER_WINDOWS_SELF_TESTS',
  committedBuild: 'QODER_COMMITTED_BUILD',
  skillReferences: 'QODER_SKILL_REFERENCES',
  packageContract: 'QODER_PACKAGE_CONTRACT',
  secretScan: 'QODER_SECRET_SCAN',
  machinePathScan: 'QODER_MACHINE_PATH_SCAN',
};
const nativeAcceptance = { qoderDesktop: 'not-run', offlineCuaWindows: 'not-run', ocrWindowsCp314: 'not-run' };
const packagePattern = /^Qoder-Optimization-\d+\.\d+\.\d+$/;
const evidenceFile = name => name + '-release-evidence.json';
const ocrFile = name => name + '-ocr-bundle-cp314-win_amd64.zip';
const canonical = record => JSON.stringify(record, null, 2) + '\n';

function buildProjection(manifest) {
  const artifacts = validateManifest(manifest);
  if (!Number.isSafeInteger(manifest.epoch) || manifest.epoch <= 0) throw new Error('invalid source timestamp');
  for (const artifact of artifacts) {
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 ||
        artifact.files.some(file => !isPublicFile(file) || file.startsWith('mcp/offline/') !== artifact.name.endsWith('-offline.zip'))) {
      throw new Error('invalid public artifact partition');
    }
  }
  for (const value of Object.values(manifest.files)) if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid public member digest');
  return {
    source: { repository, tag: manifest.tag, commit: manifest.commit, sourceDateEpoch: manifest.epoch },
    package: manifest.package,
    artifacts: artifacts.map(({ name, sha256, size, files }) => ({ name, sha256, size, files: [...files].sort() })),
    files: Object.fromEntries(Object.keys(manifest.files).sort().map(file => [file, manifest.files[file]])),
  };
}

function pinnedOcr(name) {
  const { size, sha256, repository, tag, asset } = ocrPin;
  return { name: ocrFile(name), size, sha256, source: { repository, tag, asset } };
}

function checksumLine(digest, name) { return digest + '  ' + name + '\n'; }
function checkPinnedOcr(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size !== ocrPin.size || sha256(file) !== ocrPin.sha256) {
    throw new Error('pinned OCR size or SHA256 mismatch');
  }
}

function fetchPinnedOcr(directory) {
  const target = path.join(directory, ocrPin.asset);
  const result = spawnSync(process.env.GH_EXECUTABLE || 'gh', [
    'release', 'download', ocrPin.tag, '--repo', ocrPin.repository, '--pattern', ocrPin.asset, '--output', target,
  ], { timeout: 300000, windowsHide: true });
  // Do not expose transport output (it can include credential-bearing URLs).
  if (result.error || result.status !== 0) throw new Error('could not download the pinned OCR archive from its official release');
  checkPinnedOcr(target);
  return target;
}

function buildChecks(ci, commit, ocr) {
  if (ci && (process.env.GITHUB_ACTIONS !== 'true' || process.env.QODER_SOURCE_COMMIT !== commit ||
      Object.values(automatedChecks).some(key => process.env[key] !== 'success'))) throw new Error('missing successful CI gate or tested source mismatch');
  return {
    archiveMembers: 'passed',
    ocrArchiveDigest: ocr ? 'passed' : 'not-run',
    ...Object.fromEntries(Object.keys(automatedChecks).map(key => [key, ci ? 'passed' : 'not-run'])),
  };
}

function writeOnce(file, text) {
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(Buffer.from(text))) throw new Error('existing evidence or checksum has different bytes');
  } else fs.writeFileSync(file, text, { flag: 'wx' });
}

function writeEvidence(directory, { ocrInput, fetchOcr, ci } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'build.json'), 'utf8'));
  const projection = buildProjection(manifest);
  verifyDelivery(manifest, directory);
  const ocr = ocrInput || fetchOcr ? pinnedOcr(projection.package) : null;
  const checks = buildChecks(ci, projection.source.commit, ocr);
  if (ocr) {
    // A private staging directory keeps the input asset outside the final set.
    const temp = fetchOcr ? fs.mkdtempSync(path.join(directory, '.ocr-input-')) : null;
    try {
      const input = fetchOcr ? fetchPinnedOcr(temp) : ocrInput;
      checkPinnedOcr(input);
      const target = path.join(directory, ocr.name);
      if (!fs.existsSync(target)) fs.copyFileSync(input, target, fs.constants.COPYFILE_EXCL);
      checkPinnedOcr(target);
      writeOnce(target + '.sha256', checksumLine(ocr.sha256, ocr.name));
    } finally {
      if (temp) fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  const record = { schema: 1, ...projection, ocr, checks, nativeAcceptance };
  const text = canonical(record);
  const name = evidenceFile(projection.package);
  const target = path.join(directory, name);
  writeOnce(target, text);
  writeOnce(target + '.sha256', checksumLine(sha256(target), name));
  return name;
}

function verifyEvidence(directory, { packageName, build, requireRelease = false } = {}) {
  if (!packageName) {
    const names = fs.readdirSync(directory).filter(name => /^Qoder-Optimization-\d+\.\d+\.\d+-release-evidence\.json$/.test(name));
    if (names.length !== 1) throw new Error('expected one public release evidence record');
    packageName = names[0].slice(0, -'-release-evidence.json'.length);
  }
  if (!packagePattern.test(packageName)) throw new Error('invalid public evidence package name');
  const name = evidenceFile(packageName);
  const file = path.join(directory, name);
  const text = fs.readFileSync(file, 'utf8');
  if (fs.readFileSync(file + '.sha256', 'utf8') !== checksumLine(sha256(file), name)) throw new Error('public evidence checksum mismatch');
  const record = JSON.parse(text);
  const { source, artifacts, files } = record;
  const manifest = { tag: source?.tag, commit: source?.commit, epoch: source?.sourceDateEpoch, package: packageName, artifacts, files };
  const projection = buildProjection(manifest);
  if (build && canonical(projection) !== canonical(buildProjection(build))) throw new Error('public evidence does not match the release build');
  const ocr = record.ocr === null ? null : pinnedOcr(packageName);
  const ci = Object.keys(automatedChecks).every(key => record.checks?.[key] === 'passed');
  const checks = {
    archiveMembers: 'passed',
    ocrArchiveDigest: ocr ? 'passed' : 'not-run',
    ...Object.fromEntries(Object.keys(automatedChecks).map(key => [key, ci ? 'passed' : 'not-run'])),
  };
  if (text !== canonical({ schema: 1, ...projection, ocr, checks, nativeAcceptance })) throw new Error('invalid public evidence fields');
  if (requireRelease && (!ci || !ocr || artifacts.length !== 2)) {
    throw new Error('release requires complete CI checks and both companion archives');
  }
  const result = verifyDelivery(manifest, directory);
  if (ocr) {
    checkPinnedOcr(path.join(directory, ocr.name));
    if (fs.readFileSync(path.join(directory, ocr.name + '.sha256'), 'utf8') !== checksumLine(ocr.sha256, ocr.name)) throw new Error('OCR checksum file mismatch');
  }
  return {
    ...result,
    supplementary: [...(ocr ? [ocr.name, ocr.name + '.sha256'] : []), name, name + '.sha256'],
  };
}

module.exports = { verifyEvidence, writeEvidence };
if (require.main === module) try {
  const [action, directory, ...flags] = process.argv.slice(2);
  const usage = () => new Error('usage: node .github/release-evidence.js <write|verify> <dist> [--ci] [--ocr <zip>|--fetch-ocr]');
  if (!directory || !['write', 'verify'].includes(action) || (action === 'verify' && flags.length)) throw usage();
  const options = {};
  while (flags.length) {
    const flag = flags.shift();
    if (flag === '--ci' && !options.ci) options.ci = true;
    else if (flag === '--fetch-ocr' && !options.fetchOcr && !options.ocrInput) options.fetchOcr = true;
    else if (flag === '--ocr' && !options.ocrInput && !options.fetchOcr && flags[0] && !flags[0].startsWith('--')) options.ocrInput = flags.shift();
    else throw usage();
  }
  if (action === 'write') console.log('PUBLIC_EVIDENCE ' + writeEvidence(path.resolve(directory), options));
  else console.log('EVIDENCE_VERIFIED ' + JSON.stringify(verifyEvidence(path.resolve(directory))));
} catch (error) { console.error('EVIDENCE_FAILED: ' + error.message); process.exitCode = 1; }
