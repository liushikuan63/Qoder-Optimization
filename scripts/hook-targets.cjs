'use strict';

const fs = require('node:fs');
const path = require('node:path');

function scriptsInCommand(command) {
  if (typeof command !== 'string' || !command) return [];
  const found = new Set();
  for (const match of command.matchAll(/["']([^"']*[\\/]scripts[\\/][A-Za-z0-9._-]+\.(?:c?js|mjs))["']/g)) found.add(match[1]);
  for (const match of command.matchAll(/([A-Za-z]:[\\/][^"'\s]*[\\/]scripts[\\/][A-Za-z0-9._-]+\.(?:c?js|mjs))/g)) found.add(match[1]);
  return [...found];
}

function targetExists(target, scriptsDir) {
  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\\\')) return fs.existsSync(target);
  const name = target.split(/[\\/]/).pop();
  return fs.existsSync(path.join(scriptsDir, name));
}

function findMissingHookTargets(settingsFile, scriptsDir) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
  catch { return []; }
  if (!settings || typeof settings !== 'object' || !settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return [];
  const missing = new Set();
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (!hook || typeof hook.command !== 'string') continue;
        for (const target of scriptsInCommand(hook.command)) {
          if (!targetExists(target, scriptsDir)) missing.add(target.split(/[\\/]/).pop());
        }
      }
    }
  }
  return [...missing].sort();
}

module.exports = { scriptsInCommand, findMissingHookTargets };
