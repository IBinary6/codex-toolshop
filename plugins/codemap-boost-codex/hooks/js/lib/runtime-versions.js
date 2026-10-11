'use strict';

// The active version is a validated version number, never an external path that could redirect startup through the state file.
const fs = require('fs');
const path = require('path');
const { pluginDataDir } = require('./runtime');

const VERSION_FILE = 'runtime-versions.json';
const VERSION_RE = /^\d+(?:\.\d+){1,3}$/;

function runtimeVersionsPath(options = {}) {
  return path.join(options.pluginDataDir || pluginDataDir(options), VERSION_FILE);
}

function isRuntimeVersion(value) {
  return typeof value === 'string' && VERSION_RE.test(value);
}

function readRuntimeVersions(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeVersionsPath(options), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function activeRuntimeVersion(kind, options = {}) {
  const versions = readRuntimeVersions(options);
  const value = versions && versions.active && versions.active[kind];
  return isRuntimeVersion(value) ? value : '';
}

function writeRuntimeVersions(value, options = {}) {
  const target = runtimeVersionsPath(options);
  const next = value && typeof value === 'object' ? value : {};
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${VERSION_FILE}.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

function promoteRuntimeVersion(kind, version, options = {}) {
  if (!isRuntimeVersion(version)) throw new Error(`Invalid runtime version: ${version}`);
  const current = readRuntimeVersions(options);
  const active = current.active && typeof current.active === 'object' && !Array.isArray(current.active)
    ? { ...current.active } : {};
  active[kind] = version;
  writeRuntimeVersions({ ...current, active }, options);
}

function compareVersions(left, right) {
  if (!isRuntimeVersion(left) || !isRuntimeVersion(right)) throw new Error('Version comparison supports stable numeric versions only');
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta > 0 ? 1 : -1;
  }
  return 0;
}

module.exports = {
  VERSION_FILE,
  activeRuntimeVersion,
  compareVersions,
  isRuntimeVersion,
  promoteRuntimeVersion,
  readRuntimeVersions,
  runtimeVersionsPath,
  writeRuntimeVersions,
};
