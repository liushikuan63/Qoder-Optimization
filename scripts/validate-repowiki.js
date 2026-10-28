#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const { resolveSkillFile } = require('./client-root.js');

const real = resolveSkillFile('write-repowiki', 'scripts/validate-repowiki.js');
const r = spawnSync(process.execPath, [real, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
