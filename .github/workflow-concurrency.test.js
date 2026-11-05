'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function job(name) {
  const lines = fs.readFileSync(path.join(__dirname, 'workflows/release.yml'), 'utf8').split(/\r?\n/);
  const start = lines.indexOf('  ' + name + ':');
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^  [A-Za-z][\w-]*:/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

function sourceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-config'), GIT_TERMINAL_PROMPT: '0' });
  const git = args => {
    const result = spawnSync('git', ['-c', 'user.name=Workflow Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(root, 'owned.txt'), 'event A'); git(['add', '--', 'owned.txt']); git(['commit', '-qm', 'A']);
  const a = git(['rev-parse', 'HEAD']); git(['tag', '-a', 'v0.0.1', '-m', 'fixture', a]);
  fs.writeFileSync(path.join(root, 'owned.txt'), 'new B'); git(['add', '--', 'owned.txt']); git(['commit', '-qm', 'B']);
  const b = git(['rev-parse', 'HEAD']);
  const resolve = extra => {
    const block = job('source');
    const match = block.match(/^        run: \|\n((?:          .*\n|\n)*)(?:          .*)?/m);
    assert.ok(match, 'the actual source resolver must be present');
    const script = block.slice(block.indexOf('        run: |\n') + '        run: |\n'.length).split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const output = path.join(root, 'github-output-' + Math.random());
    const executable = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    const result = spawnSync(executable, ['-c', script], { cwd: root, env: { ...env, GITHUB_SHA: a, GITHUB_EVENT_NAME: 'push', REQUESTED_TAG: '', GITHUB_OUTPUT: output.replace(/\\/g, '/'), ...extra }, encoding: 'utf8', timeout: 30000 });
    const text = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
    return { ...result, commit: text.match(/^commit=([a-f0-9]{40})$/m)?.[1] };
  };
  return { a, b, git, resolve };
}

test('manual completion and tag pushes serialize publication of the same tag', () => {
  const workflow = fs.readFileSync(path.join(__dirname, 'workflows/release.yml'), 'utf8');
  const expression = workflow.match(/^  group: release-\$\{\{ (.+) \}\}$/m)?.[1];
  assert.ok(expression, 'workflow must declare a publication concurrency key');
  const key = (event, ref, tag) => vm.runInNewContext(expression, {
    github: { event_name: event, ref_name: ref }, inputs: { tag },
  }, { timeout: 100 });
  assert.equal(key('workflow_dispatch', 'main', 'v0.0.15'), key('push', 'v0.0.15'));
  assert.equal(key('workflow_dispatch', 'other-branch', 'v0.0.15'), 'v0.0.15');
  assert.notEqual(key('push', 'main'), key('push', 'v0.0.15'));
  assert.notEqual(key('workflow_dispatch', 'main', 'v0.0.16'), key('push', 'v0.0.15'));
  assert.match(workflow, /cancel-in-progress: false/);
});

test('runner context never appears in a job-level env block', () => {
  const workflow = fs.readFileSync(path.join(__dirname, 'workflows/release.yml'), 'utf8');
  const jobEnv = workflow.match(/^    env:\n((?:      .*\n)*)/gm) || [];
  for (const block of jobEnv) assert.doesNotMatch(block, /\$\{\{\s*runner\./, 'runner context is only available inside steps');
  assert.match(workflow, /- name: Isolated self-tests and release contracts\n(?:\s+#[^\n]*\n)+\s+env:\n\s+TEMP: \$\{\{ runner\.temp \}\}/, 'windows tests must run with the runner temp on the non-system drive');
});

test('all publication versions share a lock while validation runs stay independent', () => {
  const expression = job('publish').match(/^      group: release-publish-\$\{\{ (.+) \}\}$/m)?.[1];
  assert.ok(expression, 'publication needs a repository-wide writer lock');
  const key = (event, ref, run) => vm.runInNewContext(expression, {
    startsWith: (value, prefix) => value.startsWith(prefix),
    github: { event_name: event, ref, run_id: run, repository: 'example/project' },
  });
  assert.equal(key('push', 'refs/tags/v0.0.1', 1), key('push', 'refs/tags/v0.0.2', 2));
  assert.equal(key('workflow_dispatch', 'refs/heads/main', 3), key('push', 'refs/tags/v0.0.2', 2));
  assert.notEqual(key('push', 'refs/heads/main', 4), key('pull_request', 'refs/pull/5/merge', 5));
  assert.notEqual(key('push', 'refs/heads/main', 4), key('push', 'refs/tags/v0.0.2', 2));
  const block = job('publish');
  const queue = block.match(/^      queue: (\w+)$/m)?.[1] || 'single';
  // GitHub's default single queue replaces the previous pending job. With one
  // version publishing, two more versions must both remain eligible to publish.
  const pending = [];
  for (const tag of ['v0.0.2', 'v0.0.3']) { if (queue === 'single') pending.length = 0; pending.push(tag); }
  assert.deepEqual(pending, ['v0.0.2', 'v0.0.3']);
  assert.match(block, /^      cancel-in-progress: false$/m);
});

test('checkout references cannot substitute a newer real branch tree for the recorded source', t => {
  const f = sourceFixture(t);
  for (const name of ['windows', 'publish']) {
    const expression = job(name).match(/^          ref: \$\{\{ (.+) \}\}$/m)?.[1];
    const selected = vm.runInNewContext(expression, { needs: { source: { outputs: { commit: f.a } } }, github: { sha: f.a, ref: 'refs/heads/main', event_name: 'push' }, inputs: {} });
    assert.equal(f.git(['rev-parse', selected + '^{commit}']), f.a, name + ' checkout must retain the tested event tree');
  }
});

test('push resolution and both checkouts stay on event A after the branch advances to B', t => {
  const f = sourceFixture(t), result = f.resolve();
  assert.equal(result.status, 0, result.stderr); assert.equal(result.commit, f.a);
  for (const name of ['windows', 'publish']) {
    const expression = job(name).match(/^          ref: \$\{\{ (.+) \}\}$/m)?.[1];
    const selected = vm.runInNewContext(expression, { needs: { source: { outputs: { commit: result.commit } } }, github: { sha: f.b, ref: 'refs/heads/main', event_name: 'push' }, inputs: {} });
    assert.equal(selected, f.a, name + ' must test the same immutable commit that is built');
  }
});

test('manual tag resolution is frozen once for both platforms', t => {
  const f = sourceFixture(t), result = f.resolve({ GITHUB_SHA: f.b, GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED_TAG: 'v0.0.1' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.commit, f.a);
  f.git(['tag', '-f', 'v0.0.1', f.b]);
  for (const name of ['windows', 'publish']) {
    const expression = job(name).match(/^          ref: \$\{\{ (.+) \}\}$/m)?.[1];
    assert.equal(vm.runInNewContext(expression, { needs: { source: { outputs: { commit: result.commit } } }, github: { sha: f.b, ref: 'refs/heads/main', event_name: 'workflow_dispatch' }, inputs: { tag: 'v0.0.1' } }), f.a);
  }
});

test('source resolution rejects invalid tags and commits before output', t => {
  const f = sourceFixture(t);
  for (const extra of [{ GITHUB_SHA: 'absent-commit' }, { GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED_TAG: 'v0.0.99' }, { GITHUB_EVENT_NAME: 'workflow_dispatch', REQUESTED_TAG: 'v0.0.1;exit 0' }]) {
    const result = f.resolve(extra); assert.notEqual(result.status, 0); assert.equal(result.commit, undefined);
  }
});
