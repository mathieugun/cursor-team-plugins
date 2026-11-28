'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tokens, addMember, renameKey } = require('../lib/jsonc');

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
