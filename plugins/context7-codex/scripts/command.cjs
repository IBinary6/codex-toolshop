#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CommandClient, SUPPORTED, MAX } = require('./command-client.cjs');
const { SafeError } = require('./config.cjs');
const { researchToolsProvider: PROFILE } = require('../package.json');

async function main(argv = process.argv.slice(2)) {
  let provider = PROFILE, inputFile, list = false, help = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider' && argv[i + 1] && provider === undefined) provider = argv[++i];
    else if (argv[i] === '--input-file' && argv[i + 1] && inputFile === undefined) inputFile = argv[++i];
    else if (argv[i] === '--list' && !list) list = true;
    else if (argv[i] === '--help' && !help) help = true;
    else throw new SafeError('命令支持 --input-file 绝对路径、--list、--help。');
  }
  if (!SUPPORTED.includes(provider)) throw new SafeError('此入口只支持 Context7、Exa、Tavily。');
  if (help) { console.log(JSON.stringify({ provider, usage: 'stdin JSON 或 --input-file 绝对路径；请求 {name,arguments}；--list 查看本包命令。' })); return; }
  if (list) { console.log(JSON.stringify({ provider, commands: require('./catalog.json').providers[provider] })); return; }
  const client = new CommandClient(provider);
  const controller = new AbortController();
  let readingInput = inputFile === undefined;
  const abort = () => { controller.abort(); if (readingInput) process.stdin.destroy(new SafeError('调用已取消或超时。')); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, abort);
  try {
    let bytes;
    if (inputFile !== undefined) {
      if (!path.isAbsolute(inputFile)) throw new SafeError('输入文件必须是绝对路径。');
      if (fs.statSync(inputFile).size > MAX) throw new SafeError('输入超过 8 MiB 限制。');
      bytes = fs.readFileSync(inputFile);
    } else {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX) throw new SafeError('输入超过 8 MiB 限制。'); chunks.push(chunk); }
      bytes = Buffer.concat(chunks);
    }
    readingInput = false;
    let params;
    try { params = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new SafeError('输入 JSON 格式无效。'); }
    const result = await client.call(params, controller.signal);
    console.log(JSON.stringify(result));
    if (result.isError) process.exitCode = 1;
  } finally { client.close(); for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, abort); }
}

if (require.main === module) main().catch(error => { console.log(JSON.stringify({ content: [{ type: 'text', text: error instanceof SafeError ? error.message : '命令执行失败；请检查本包配置、输入文件或运行时。' }], isError: true })); process.exitCode = 1; });
module.exports = { main };
