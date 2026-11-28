'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokens, addMember, renameKey, removeMember } = require('../lib/jsonc');
const { parseJsonc } = require('../lib/checks');

const INPUT_4 = '{\n  // team servers\n  "mcpServers": {\n    "a": { "command": "x" }, // main\n  },\n}\n';
const EXPECTED_4 =
  '{\n  // team servers\n  "mcpServers": {\n    "a": { "command": "x" }, // main\n' +
  '    "b": {\n      "command": "y"\n    }\n  },\n}\n';
const INPUT_5 = '{\n  "mcpServers": {\n    "a": { "command": "x" } // main\n  }\n}\n';
const EXPECTED_5 =
  '{\n  "mcpServers": {\n    "a": { "command": "x" }, // main\n    "b": {\n      "command": "y"\n    }\n  }\n}\n';

test('tokens skips the BOM, whitespace and comments', () => {
  const text = '﻿{ /* c */ "a" : [1, true], // x\n "b\\"": null }';
  const list = tokens(text);
  assert.deepEqual(
    list.map((x) => x.type),
    ['{', 'string', ':', '[', 'value', ',', 'value', ']', ',', 'string', ':', 'value', '}'],
  );
  assert.equal(text.slice(list[1].start, list[1].end), '"a"');
});

test('addMember into an empty object lays the member out like JSON.stringify', () => {
  assert.equal(
    addMember('{}', [], 'mcpServers', { a: { command: 'x' } }),
    JSON.stringify({ mcpServers: { a: { command: 'x' } } }, null, 2),
  );
});

test('addMember into a compact object stays compact', () => {
  assert.equal(
    addMember('{"mcpServers":{"a":{"command":"x"}}}', ['mcpServers'], 'b', { command: 'y' }),
    '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}',
  );
});

test('addMember keeps comments and a trailing comma', () => {
  assert.equal(addMember(INPUT_4, ['mcpServers'], 'b', { command: 'y' }), EXPECTED_4);
});

test('addMember puts the comma before a trailing comment', () => {
  assert.equal(addMember(INPUT_5, ['mcpServers'], 'b', { command: 'y' }), EXPECTED_5);
});

test('addMember keeps CRLF line endings', () => {
  assert.equal(
    addMember(INPUT_5.replace(/\n/g, '\r\n'), ['mcpServers'], 'b', { command: 'y' }),
    EXPECTED_5.replace(/\n/g, '\r\n'),
  );
});

test('addMember into an empty one-line object with a comment', () => {
  assert.equal(addMember('{ /* none */ }', [], 'a', 1), '{ /* none */ "a":1}');
});

test('addMember into a nested empty table', () => {
  assert.equal(
    addMember('{\n  "mcpServers": {}\n}', ['mcpServers'], 'a', { url: 'u' }),
    '{\n  "mcpServers": {\n    "a": {\n      "url": "u"\n    }\n  }\n}',
  );
});

test('renameKey keeps everything else', () => {
  assert.equal(renameKey(INPUT_4, ['mcpServers'], 'a', 'z'), INPUT_4.replace('"a"', '"z"'));
  assert.equal(renameKey('{"a":{"command":"x"},"b":{"url":"u"}}', [], 'b', 'z'), '{"a":{"command":"x"},"z":{"url":"u"}}');
  assert.equal(renameKey('{"x":{"b":1},"b":2}', [], 'b', 'z'), '{"x":{"b":1},"z":2}');
  assert.throws(() => renameKey('{"a":1}', [], 'q', 'z'), /no member q/);
});

test('addMember refuses an mcpServers that is not an object', () => {
  assert.throws(() => addMember('{"mcpServers": []}', ['mcpServers'], 'a', 1), /"mcpServers" is not an object/);
});

const TWO = '{\n  "mcpServers": {\n    "a": { "command": "x" },\n    "b": { "command": "y" }\n  }\n}\n';

test('removeMember removes the last member and its comma, or the first one and its own', () => {
  assert.equal(
    removeMember(TWO, ['mcpServers'], 'b'),
    '{\n  "mcpServers": {\n    "a": { "command": "x" }\n  }\n}\n',
  );
  assert.equal(
    removeMember(TWO, ['mcpServers'], 'a'),
    '{\n  "mcpServers": {\n    "b": { "command": "y" }\n  }\n}\n',
  );
});

test('removeMember keeps the comments that are not the member\'s', () => {
  const above = '{\n  // keep\n  "a": 1,\n  "b": 2\n}\n';
  assert.equal(removeMember(above, [], 'b'), '{\n  // keep\n  "a": 1\n}\n');
  // the comment after the comma of a member that is not last goes with it
  const old = '{\n  "a": 1,\n  "b": {}, // old\n  "c": 3\n}\n';
  assert.equal(removeMember(old, [], 'b'), '{\n  "a": 1,\n  "c": 3\n}\n');
  // a comment on the line of the next member belongs to the next member
  const same = '{"a":1, /* documents b */ "b":2}';
  const out = removeMember(same, [], 'a');
  assert.ok(out.includes('/* documents b */'), out);
  assert.ok(out.includes('"b":2'), out);
  assert.deepEqual(parseJsonc(out), { b: 2 });
  // the comments between the comma before the last member and its key stay
  const between = '{\n  "a": 1, // about a\n  // about b\n  "b": 2\n}\n';
  const kept = removeMember(between, [], 'b');
  assert.ok(kept.includes('// about a') && kept.includes('// about b'), kept);
  assert.deepEqual(parseJsonc(kept), { a: 1 });
  // a trailing comma stays valid
  assert.deepEqual(parseJsonc(removeMember('{ "a": 1, "b": 2, }', [], 'b')), { a: 1 });
  assert.deepEqual(parseJsonc(removeMember('{\n  "a": 1,\n  "b": 2,\n}\n', [], 'a')), { b: 2 });
});

test('removeMember keeps CRLF, compact text and handles duplicates and a missing name', () => {
  assert.equal(
    removeMember(TWO.replace(/\n/g, '\r\n'), ['mcpServers'], 'b'),
    '{\n  "mcpServers": {\n    "a": { "command": "x" }\n  }\n}\n'.replace(/\n/g, '\r\n'),
  );
  assert.equal(removeMember('{"a":1,"b":2}', [], 'a'), '{"b":2}');
  assert.deepEqual(parseJsonc(removeMember('{\n  "a": 1\n}\n', [], 'a')), {});
  assert.equal(removeMember('{"a":1,"a":2,"b":3}', [], 'a'), '{"b":3}');
  assert.equal(removeMember('{"a":1,"b":2,"a":3}', [], 'a'), '{"b":2}');
  assert.equal(removeMember(TWO, ['mcpServers'], 'zzz'), TWO);
  assert.equal(removeMember('{"x":{"a":1},"a":2}', [], 'a'), '{"x":{"a":1}}');
});
