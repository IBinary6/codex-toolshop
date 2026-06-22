'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ENABLED_MARKER,
  enableCodeMap,
  isCodeMapEnabled,
} = require('../lib/codemap');
const { markerPath } = require('../lib/runtime');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-activation-'));
const oldPluginData = process.env.PLUGIN_DATA;
const oldAssume = process.env.CODEMAP_BOOST_ASSUME_CRG;
const oldDisable = process.env.CODEMAP_BOOST_DISABLE_GRAPH;

try {
  process.env.PLUGIN_DATA = path.join(tmp, 'data');
  delete process.env.CODEMAP_BOOST_ASSUME_CRG;
  delete process.env.CODEMAP_BOOST_DISABLE_GRAPH;

  assert.strictEqual(fs.existsSync(markerPath(ENABLED_MARKER)), false, 'setup marker starts absent');

  process.env.CODEMAP_BOOST_ASSUME_CRG = '1';
  assert.strictEqual(isCodeMapEnabled(), false, 'available CLI alone does not enable CodeMap hooks');

  process.env.CODEMAP_BOOST_DISABLE_GRAPH = '1';
  assert.strictEqual(isCodeMapEnabled(), false, 'disable env override wins');

  delete process.env.CODEMAP_BOOST_DISABLE_GRAPH;
  enableCodeMap();
  assert.strictEqual(fs.existsSync(markerPath(ENABLED_MARKER)), true, 'setup marker is written for diagnostics');
  assert.strictEqual(isCodeMapEnabled(), true, 'setup marker plus available CLI enables hooks');

  console.log('activation.test.js PASS');
} finally {
  if (oldPluginData === undefined) delete process.env.PLUGIN_DATA;
  else process.env.PLUGIN_DATA = oldPluginData;
  if (oldAssume === undefined) delete process.env.CODEMAP_BOOST_ASSUME_CRG;
  else process.env.CODEMAP_BOOST_ASSUME_CRG = oldAssume;
  if (oldDisable === undefined) delete process.env.CODEMAP_BOOST_DISABLE_GRAPH;
  else process.env.CODEMAP_BOOST_DISABLE_GRAPH = oldDisable;
  fs.rmSync(tmp, { recursive: true, force: true });
}
