#!/usr/bin/env node
'use strict';

const { PROVIDERS, SafeError, configPath, readConfig, createConfig, profile } = require('./config.cjs');
const { researchToolsProvider: PACKAGE_PROFILE } = require('../package.json');

function main(args = process.argv.slice(2)) {
  let provider = PACKAGE_PROFILE;
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1] && provider === undefined) provider = args[++i];
    else if (['--doctor', '--help'].includes(args[i]) && !flags.includes(args[i])) flags.push(args[i]);
    else throw new SafeError('支持参数：--provider 提供方、--doctor、--help。');
  }
  const selected = profile(provider);
  if (args.includes('--help')) {
    console.log(`node scripts/setup.cjs [--doctor]\n默认创建 CODEX_HOME/${selected ? selected.name : 'research-tools'}/config.json（仅文件不存在时）；doctor 只显示配置状态。`);
    return;
  }
  const file = configPath(process.env, undefined, provider);
  if (!flags.includes('--doctor')) console.log(createConfig(file, provider) ? '已创建空白私有配置。' : '私有配置已存在，保持原内容。');
  const config = readConfig(file, provider);
  console.log(`配置文件：${file}`);
  if (selected && !selected.key) console.log(`${selected.name}：无需密钥`);
  else for (const name of selected ? [provider] : PROVIDERS) console.log(`${name}：${config[name].apiKey ? '已配置（已隐藏）' : name === 'context7' ? '匿名访问' : '未配置密钥'}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error instanceof SafeError ? error.message : 'Research Tools 配置检查失败。'); process.exitCode = 1; }
}
module.exports = { main };
