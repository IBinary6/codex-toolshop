'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureCli, ensureCrg, pythonCandidates } = require('../lib/bootstrap');

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

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-bootstrap-uv-'));
  const marker = path.join(tmp, '.crg-install-failed');
  const installers = [];
  try {
    const ok = ensureCrg({
      probe: () => false,
      uvProbe: () => true,
      uvInstall: (pkg) => {
        installers.push(`uv:${pkg}`);
        return true;
      },
      install: (pkg) => {
        installers.push(`pip:${pkg}`);
        return false;
      },
      markerPath: marker,
    });
    assert.strictEqual(ok, false, 'a failed post-install probe remains a failure');
    assert.deepStrictEqual(installers, ['uv:code-review-graph[all]', 'pip:code-review-graph[all]']);
    assert.ok(fs.existsSync(marker), 'failed dependency bootstrap writes a marker');
    assert.match(fs.readFileSync(marker, 'utf8'), /uv tool install/);
    assert.match(fs.readFileSync(marker, 'utf8'), /pip/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-bootstrap-pip-'));
  const marker = path.join(tmp, '.crg-install-failed');
  const installers = [];
  let available = false;
  try {
    const ok = ensureCrg({
      probe: () => available,
      uvProbe: () => false,
      uvInstall: () => {
        installers.push('uv');
        return false;
      },
      install: (pkg) => {
        installers.push(`pip:${pkg}`);
        available = true;
        return true;
      },
      markerPath: marker,
    });
    assert.strictEqual(ok, true, 'pip fallback enables code-review-graph');
    assert.deepStrictEqual(installers, ['pip:code-review-graph[all]']);
    assert.ok(!fs.existsSync(marker), 'successful fallback does not write a failure marker');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-bootstrap-fail-'));
  const marker = path.join(tmp, '.crg-install-failed');
  try {
    const ok = ensureCrg({
      probe: () => false,
      uvProbe: () => false,
      install: () => false,
      markerPath: marker,
    });
    assert.strictEqual(ok, false, 'all dependency installers failing is reported');
    assert.match(fs.readFileSync(marker, 'utf8'), /code-review-graph/);
    assert.match(fs.readFileSync(marker, 'utf8'), /重新运行|rerun/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const oldPython = process.env.CODEMAP_BOOST_PYTHON;
  const oldArgs = process.env.CODEMAP_BOOST_PYTHON_ARGS;
  try {
    process.env.CODEMAP_BOOST_PYTHON = 'custom-python';
    process.env.CODEMAP_BOOST_PYTHON_ARGS = '-3.12 -Xutf8';
    assert.deepStrictEqual(pythonCandidates()[0], ['custom-python', ['-3.12', '-Xutf8']]);
  } finally {
    if (oldPython === undefined) delete process.env.CODEMAP_BOOST_PYTHON;
    else process.env.CODEMAP_BOOST_PYTHON = oldPython;
    if (oldArgs === undefined) delete process.env.CODEMAP_BOOST_PYTHON_ARGS;
    else process.env.CODEMAP_BOOST_PYTHON_ARGS = oldArgs;
  }
}

console.log('bootstrap.test.js PASS');
