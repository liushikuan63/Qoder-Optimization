'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { metadataFor } = require('../scripts/pack-share-extras.cjs');

test('current source metadata excludes test fixture directories from installable scripts', () => {
  const generated = metadataFor(path.resolve(__dirname, '..'));
  assert.ok(generated.catalog.entries.some(entry => entry.id === 'script:context-governor.cjs'));
  assert.ok(!generated.catalog.entries.some(entry => entry.source.startsWith('scripts/fixtures')));
});
