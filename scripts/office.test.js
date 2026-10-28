#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const { resolveSkillFile } = require('./client-root.js');

const real = resolveSkillFile('office-docs', 'scripts/office.js');
const r = spawnSync(process.execPath, [real, '--selftest'], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
