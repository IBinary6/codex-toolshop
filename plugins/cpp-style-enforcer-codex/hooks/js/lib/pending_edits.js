'use strict';

const fs = require('node:fs');
const path = require('node:path');

function safePart(value, fallback) {
  const text = String(value || fallback).replace(/[^A-Za-z0-9._-]/g, '_');
  return text === '.' || text === '..' ? fallback : text.slice(0, 120) || fallback;
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

function readPendingPaths(input) {
  const dir = pendingDir(input);
  const paths = new Set();
  const files = [];
  if (!dir) return { paths, files };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { paths, files };
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const values = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(values) || !values.every((value) => typeof value === 'string' && path.isAbsolute(value))) {
      throw new Error('Invalid legacy C++ pending edit record');
    }
    files.push(file);
    for (const value of values) paths.add(path.resolve(value));
  }
  return { paths, files };
}

function clearPendingFiles(files) {
  for (const file of files) {
    try { fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

module.exports = { recordPendingPaths, readPendingPaths, clearPendingFiles };
