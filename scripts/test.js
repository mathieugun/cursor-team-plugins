'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.resolve(__dirname, '..', 'test');
const files = fs
  .readdirSync(dir)
  .filter((n) => n.endsWith('.test.js'))
  .sort()
  .map((n) => path.join(dir, n));

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: process.env });
process.exit(result.status === null ? 1 : result.status);
