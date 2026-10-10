#!/usr/bin/env node
'use strict';

const { Gateway, runStdio } = require('./gateway.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { SafeError, configPath } = require('./config.cjs');
const { researchToolsProvider: PROFILE } = require('../package.json');

function parseArgs(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--provider') return { provider: args[1] };
  throw new SafeError('Research Tools 入口仅支持 --provider 提供方。');
}

if (require.main === module) {
  if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1);
  try {
    const options = parseArgs(process.argv.slice(2));
    const configFile = configPath(process.env, undefined, options.provider ?? PROFILE);
    // Windows 的进程 cwd 会锁住目录。先转到私有配置旁的稳定 runtime，
    // 再创建网关；Fetch 子进程也继承此 cwd，插件缓存可在运行中替换。
    const runtime = path.join(path.dirname(configFile), 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    process.chdir(runtime);
    const gateway = new Gateway({ ...options, configFile });
    const stdio = runStdio(gateway, { onClose: () => { process.exit(0); } });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stdio.close(); });
  } catch { process.exitCode = 1; }
}

module.exports = { parseArgs };
