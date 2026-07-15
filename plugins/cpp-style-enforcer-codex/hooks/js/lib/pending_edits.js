'use strict';

const fs = require('node:fs');
const path = require('node:path');

function safePart(value, fallback) {
  const text = String(value || fallback).replace(/[^A-Za-z0-9._-]/g, '_');
  return text.slice(0, 120) || fallback;
}

function pendingDir(input) {
  const dataDir = process.env.PLUGIN_DATA;
  if (!dataDir) return null;
  return path.join(
    path.resolve(dataDir),
    'pending-edits',
    safePart(input && input.session_id, 'session'),
    safePart(input && input.turn_id, 'turn'),
  );
}

function recordPendingPaths(input, filePaths) {
  const dir = pendingDir(input);
  if (!dir || !Array.isArray(filePaths) || filePaths.length === 0) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const id = safePart(input && input.tool_use_id, `${process.pid}-${Date.now()}-${Math.random()}`);
    const target = path.join(dir, `${id}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(filePaths.map((filePath) => path.resolve(filePath))), 'utf8');
    fs.renameSync(temp, target);
    return true;
  } catch (_) {
    return false;
  }
}

function consumePendingPaths(input) {
  const dir = pendingDir(input);
  if (!dir) return [];
  const paths = new Set();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const values = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          if (typeof value === 'string' && value) paths.add(path.resolve(value));
        }
      } catch (_) {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    return [];
  }
  return [...paths];
}

module.exports = { recordPendingPaths, consumePendingPaths, pendingDir };
