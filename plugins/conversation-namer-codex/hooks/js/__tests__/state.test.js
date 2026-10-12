'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readState, writeState } = require('../lib/state');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'namer-state-'));
const env = { PLUGIN_DATA: temporary };
fs.mkdirSync(path.join(temporary, 'sessions'), { recursive: true });

// Windows reports a short sharing violation while another process replaces or reads the file; both sides retry.
function failing(name, code, times) {
  const real = fs[name];
  let left = times;
  fs[name] = function patched(...args) {
    if (left > 0) { left -= 1; const error = new Error(`${code}: simulated`); error.code = code; throw error; }
    return real.apply(this, args);
  };
  return () => { fs[name] = real; return times - left; };
}

try {
  let restore = failing('renameSync', 'EPERM', 3);
  writeState('retry-write', { status: 'started' }, env);
  assert.equal(restore(), 3, 'three transient rename failures were retried');
  assert.equal(readState('retry-write', env).status, 'started');
  assert.ok(!fs.readdirSync(path.join(temporary, 'sessions')).some((name) => name.endsWith('.tmp')));

  restore = failing('readFileSync', 'EBUSY', 4);
  assert.equal(readState('retry-write', env).status, 'started');
  assert.equal(restore(), 4, 'four transient read failures were retried');

  // A missing file is still "no state", and lasting or unrelated failures are still reported.
  assert.equal(readState('never-written', env), null);
  restore = failing('readFileSync', 'EBUSY', 1000);
  assert.throws(() => readState('retry-write', env), { code: 'EBUSY' });
  restore();
  restore = failing('readFileSync', 'EIO', 1);
  assert.throws(() => readState('retry-write', env), { code: 'EIO' });
  assert.equal(restore(), 1, 'an unrelated error is not retried');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log('state.test.js PASS');
