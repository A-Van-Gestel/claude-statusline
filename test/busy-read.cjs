/** Preload: reads of the state file fail with EBUSY, as during another process's rename. */
'use strict';

const fs = require('node:fs');

const original = fs.readFileSync;
fs.readFileSync = function readFileSync(file, ...rest) {
  if (String(file).endsWith('.statusline-state.json')) {
    throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
  }
  return original.call(this, file, ...rest);
};
