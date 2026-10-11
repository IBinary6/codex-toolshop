'use strict';

const childProcess = require('node:child_process');

const realSpawnSync = childProcess.spawnSync;

/**
 * Fail only `git diff --cached` to verify fail-closed staged enumeration.
 *
 * @param {string} command Executable command
 * @param {string[]} args Command arguments
 * @param {object} options spawnSync options
 * @returns {object} Simulated or real subprocess result
 */
childProcess.spawnSync = function failStagedDiff(command, args, options) {
  if (/^git(?:\.exe)?$/i.test(String(command))
      && Array.isArray(args) && args[0] === 'diff' && args.includes('--cached')) {
    return {
      status: 128,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('simulated git diff failure', 'utf8'),
      error: undefined,
    };
  }
  return realSpawnSync.call(childProcess, command, args, options);
};
