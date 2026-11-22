'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createZip, readZip } = require('../scripts/zip');
const { buildVsix } = require('../scripts/package');
const { tmpDir, rmDir } = require('./helpers');

test('zip round trip', () => {
  const big = Buffer.from('repeated text line\n'.repeat(5500)); // ~100 KB
  const zip = createZip([
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'dir/big.txt', data: big },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['empty.txt', 'dir/big.txt']);
  assert.equal(entries[0].data.length, 0);
  assert.ok(entries[1].data.equals(big));
});

test('buildVsix', (t) => {
  const dir = tmpDir();
  t.after(() => rmDir(dir));
  const out = buildVsix(path.join(dir, 'x.vsix'));
  const entries = readZip(fs.readFileSync(out));
  const names = entries.map((e) => e.name);
  for (const n of [
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/package.json',
    'extension/extension.js',
    'extension/README.md',
    'extension/LICENSE.txt',
    'extension/lib/catalog.js',
    'extension/resources/activity.svg',
    'extension/resources/icon.png',
  ]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.some((n) => n.startsWith('extension/test/') || n.startsWith('extension/scripts/')));
  const manifest = entries.find((e) => e.name === 'extension.vsixmanifest').data.toString('utf8');
  assert.ok(manifest.includes('Id="cursor-team-plugins"'));
  assert.ok(manifest.includes('Publisher="mg"'));
  assert.ok(manifest.includes(`Version="${require('../package.json').version}"`));
  assert.ok(manifest.includes('<Icon>extension/resources/icon.png</Icon>'));
  assert.ok(manifest.includes('Path="extension/LICENSE.txt"'));
});
