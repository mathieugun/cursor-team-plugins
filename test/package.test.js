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
    'extension/resources/walkthrough-git.md',
    'extension/resources/walkthrough-repository.md',
    'extension/resources/walkthrough-plugins.md',
  ]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.some((n) => n.startsWith('extension/test/') || n.startsWith('extension/scripts/')));
  const manifest = entries.find((e) => e.name === 'extension.vsixmanifest').data.toString('utf8');
  assert.ok(manifest.includes('Id="cursor-team-plugins"'));
  assert.ok(manifest.includes('Publisher="mathieugun"'));
  assert.ok(manifest.includes(`Version="${require('../package.json').version}"`));
  assert.ok(manifest.includes('<Icon>extension/resources/icon.png</Icon>'));
  assert.ok(manifest.includes('Path="extension/LICENSE.txt"'));
});

// The README is the extension's details page, which opens only http, https and mailto links (Cursor 3.31): a relative
// link to a file (or any other scheme) does nothing when clicked.
test('the README links only to web pages', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  for (const l of links) {
    assert.match(l, /^(https?|mailto):/i, `${l} can't be opened from the extension's details page`);
  }
});

test("the walkthrough's files and commands exist", () => {
  const root = path.join(__dirname, '..');
  const pkg = require('../package.json');
  const commands = new Set(pkg.contributes.commands.map((c) => c.command));
  commands.add('workbench.view.extension.teamPlugins');
  const commandLinks = (text) => [...text.matchAll(/\(command:([\w.]+)\)/g)].map((m) => m[1]);
  assert.ok(pkg.contributes.walkthroughs.length > 0);
  for (const w of pkg.contributes.walkthroughs) {
    for (const s of w.steps) {
      for (const file of [s.media.markdown, s.media.image].filter(Boolean)) {
        assert.ok(fs.existsSync(path.join(root, file)), `${w.id}/${s.id}: ${file} is missing`);
      }
      if (s.media.markdown) {
        const md = fs.readFileSync(path.join(root, s.media.markdown), 'utf8');
        for (const l of [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])) {
          assert.match(l, /^https:/i, `${s.media.markdown}: ${l}`);
        }
      }
      for (const id of commandLinks(s.description)) {
        assert.ok(commands.has(id), `${w.id}/${s.id}: unknown command ${id}`);
      }
    }
  }
  for (const v of pkg.contributes.viewsWelcome) {
    for (const id of commandLinks(v.contents)) {
      assert.ok(commands.has(id), `viewsWelcome: unknown command ${id}`);
    }
  }
});
