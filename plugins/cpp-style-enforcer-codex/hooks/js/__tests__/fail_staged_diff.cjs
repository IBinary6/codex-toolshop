'use strict';

const childProcess = require('node:child_process');

const realSpawnSync = childProcess.spawnSync;

/**
 * 仅让 `git diff --cached` 失败，用于验证暂存区枚举的 fail-closed 语义。
 *
 * @param {string} command 可执行命令
 * @param {string[]} args 命令参数
 * @param {object} options spawnSync 选项
 * @returns {object} 模拟或真实的子进程结果
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
