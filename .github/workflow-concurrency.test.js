'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
