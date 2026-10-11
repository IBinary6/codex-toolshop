'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const OWNER_ENV = 'CODEMAP_SERENA_OWNER';
const OWNER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HELPER = path.join(__dirname, 'serena-processes.py');
const SAFE_ERROR_TYPES = new Set([
  'AccessDenied', 'NoSuchProcess', 'ZombieProcess', 'RuntimeError',
  'ValueError', 'PermissionError', 'ProcessLookupError', 'TimeoutError',
  'OSError', 'FileNotFoundError', 'NotImplementedError', 'TypeError',
  'AttributeError', 'KeyError', 'JSONDecodeError', 'KeyboardInterrupt',
  'ModuleNotFoundError', 'ImportError',
  'UnknownError',
]);
const COMMANDS = new Set(['inspect', 'signal', 'identities']);

function createOwner() {
  return crypto.randomUUID();
}

function assertOwner(owner) {
  if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) {
    throw new Error('Invalid Serena process owner');
  }
}

function helper(python, request, options = {}) {
  if (typeof python !== 'string' || !python) return Promise.reject(new Error('Serena process Python is required'));
  const timeoutMs = options.helperTimeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Invalid Serena helper timeout'));
  const env = { ...process.env };
  delete env[OWNER_ENV];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(python, ['-I', '-B', HELPER], {
        env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
    } catch (_) {
      reject(new Error('Serena process helper failed to start'));
      return;
    }
    let output = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); // Stop only this helper, without touching its process tree.
      finish(new Error('Serena process helper timed out'));
    }, timeoutMs);
    child.once('error', () => finish(new Error('Serena process helper failed to start')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new Error('Serena process helper returned too much data'));
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch (_) { finish(new Error('Serena process helper failed')); return; }
      if (code === 0 && parsed && parsed.ok === true && Array.isArray(parsed.identities)) {
        finish(null, parsed.identities);
        return;
      }
      if (code !== 0 && parsed && parsed.ok === false && SAFE_ERROR_TYPES.has(parsed.error_type)
        && COMMANDS.has(request.command)) {
        finish(new Error(`Serena process helper ${request.command} failed (${parsed.error_type})`));
        return;
      }
      finish(new Error('Serena process helper failed'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...request, callerPid: process.pid }));
  });
}

function inspectOwned(python, owner, options = {}) {
  assertOwner(owner);
  // Generate owner after the current Node caller starts; Linux helpers use OS birth time to exclude unrelated older processes.
  return helper(python, { command: 'inspect', owner }, options);
}

function inspectIdentities(python, identities, options = {}) {
  if (!Array.isArray(identities)) throw new Error('Invalid Serena process identities');
  return helper(python, { command: 'identities', identities }, options);
}

function signalOwned(python, owner, identities, signal, options = {}) {
  assertOwner(owner);
  return helper(python, { command: 'signal', owner, identities, signal }, options);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupOwned(python, owner, options = {}) {
  assertOwner(owner);
  // The same Node caller must own the entire owner lifecycle; do not delegate cleanup to a later independent process.
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 100;
  const termGraceMs = options.termGraceMs ?? 1000;
  if (![timeoutMs, intervalMs, termGraceMs].every((value) => Number.isFinite(value) && value >= 0)
    || timeoutMs === 0 || intervalMs === 0) {
    throw new Error('Invalid Serena cleanup timing');
  }
  const deadline = Date.now() + timeoutMs;
  const killAfter = Date.now() + termGraceMs;
  const seen = new Map();
  const boundedOptions = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Serena process cleanup timed out');
    return { ...options, helperTimeoutMs: Math.min(options.helperTimeoutMs ?? 5000, remaining) };
  };
  let emptyScans = 0;
  let signal = 'TERM';
  while (Date.now() < deadline) {
    const identities = await inspectOwned(python, owner, boundedOptions());
    if (identities.length === 0) {
      if (seen.size > 0) {
        const alive = await inspectIdentities(python, [...seen.values()], boundedOptions());
        if (alive.length > 0) throw new Error('Serena previously owned process remains alive without owner marker');
      }
      emptyScans += 1;
      if (emptyScans >= 2) return;
    } else {
      emptyScans = 0;
      for (const identity of identities) seen.set(`${identity.pid}:${identity.create_time}`, identity);
      if (Date.now() >= killAfter) signal = 'KILL';
      await signalOwned(python, owner, identities, signal, boundedOptions());
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  // Do not start helpers after the total budget expires; one empty scan does not prove quiescence.
  throw new Error('Serena process cleanup timed out before confirming quiescence');
}

module.exports = { OWNER_ENV, createOwner, inspectOwned, inspectIdentities, cleanupOwned };
