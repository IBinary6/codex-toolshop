'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureCli } = require('../lib/bootstrap');

{
  let installed = null;
  const ok = ensureCli('code-review-graph', 'code-review-graph[all]', '.unused', {
    probe: (cmd) => cmd === 'code-review-graph',
    install: (pkg) => { installed = pkg; return true; },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(installed, null, 'available CLI should not install');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-bootstrap-'));
  let installed = null;
  try {
    const ok = ensureCli('graphify', 'graphifyy[all]', '.unused', {
      probe: () => false,
      install: (pkg) => { installed = pkg; return false; },
      markerPath: path.join(tmp, '.graphify-install-failed'),
    });
    assert.strictEqual(ok, false);
    assert.strictEqual(installed, 'graphifyy[all]', 'graphify command is installed from graphifyy package');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('bootstrap.test.js PASS');
