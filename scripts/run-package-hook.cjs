#!/usr/bin/env node
'use strict';
// Only a declared hook can be loaded. Bind scope before any helper is required;
// __dirname alone identifies the shared scripts directory, not a CN client.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HOOKS } = require('./workflow-profile.cjs');
try {
  if (process.argv.length !== 3 || process.argv[2].length > 32768 || !/^[A-Za-z0-9_-]+$/.test(process.argv[2])) throw new Error('invalid payload');
  const input = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
  if (!input || Object.keys(input).sort().join(',') !== 'args,client,event,script' || typeof input.client !== 'string' || !path.isAbsolute(input.client)) throw new Error('invalid binding');
  const spec = HOOKS.find(item => item[0] === input.event && item[1] === input.script);
  if (!spec || JSON.stringify(input.args) !== JSON.stringify(spec[4] || [])) throw new Error('unknown hook');
  if (fs.realpathSync.native(path.join(input.client, 'scripts/run-package-hook.cjs')) !== fs.realpathSync.native(__filename)) throw new Error('client binding mismatch');
  const raw = fs.readFileSync(0, 'utf8');
  let event; try { event = JSON.parse(raw).hook_event_name; } catch {}
  if (event !== input.event) throw new Error('event binding mismatch');
  const target = path.join(__dirname, input.script);
  // A child preserves both synchronous readFileSync(0) and asynchronous
  // process.stdin consumers (fact-ledger uses the latter). Never consume stdin
  // then monkey-patch only one API: that silently drops facts for another cwd.
  const result = spawnSync(process.execPath, [target, ...input.args], { env: { ...process.env, QODER_HOME: path.resolve(input.client) }, input: raw, encoding: 'utf8', windowsHide: true, timeout: spec[2] * 1000 - 1500, maxBuffer: 4 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status === null) throw new Error('hook child unavailable: ' + (result.error?.code || result.signal || 'unknown'));
  process.exitCode = result.status;
} catch (error) { process.stderr.write('PACKAGE_HOOK_UNAVAILABLE: ' + error.message + '\n'); process.exitCode = 0; }
