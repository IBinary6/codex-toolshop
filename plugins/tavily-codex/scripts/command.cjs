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
    else throw new SafeError('Command accepts --input-file absolute-path, --list, and --help.');
  }
  if (!SUPPORTED.includes(provider)) throw new SafeError('This entry point supports only Context7, Exa, and Tavily.');
  if (help) { console.log(JSON.stringify({ provider, usage: 'Use JSON on stdin or --input-file with an absolute path; request {name,arguments}; --list shows this package commands.' })); return; }
  if (list) { console.log(JSON.stringify({ provider, commands: require('./catalog.json').providers[provider] })); return; }
  const client = new CommandClient(provider);
  const controller = new AbortController();
  let readingInput = inputFile === undefined;
  const abort = () => { controller.abort(); if (readingInput) process.stdin.destroy(new SafeError('Call was cancelled or timed out.')); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, abort);
  try {
    let bytes;
    if (inputFile !== undefined) {
      if (!path.isAbsolute(inputFile)) throw new SafeError('Input file path must be absolute.');
      if (fs.statSync(inputFile).size > MAX) throw new SafeError('Input exceeds the 8 MiB limit.');
      bytes = fs.readFileSync(inputFile);
    } else {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX) throw new SafeError('Input exceeds the 8 MiB limit.'); chunks.push(chunk); }
      bytes = Buffer.concat(chunks);
    }
    readingInput = false;
    let params;
    try { params = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new SafeError('Input JSON is invalid.'); }
    const result = await client.call(params, controller.signal);
    console.log(JSON.stringify(result));
    if (result.isError) process.exitCode = 1;
  } finally { client.close(); for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, abort); }
}

if (require.main === module) main().catch(error => { console.log(JSON.stringify({ content: [{ type: 'text', text: error instanceof SafeError ? error.message : 'Command failed; check this package configuration, input file, or runtime.' }], isError: true })); process.exitCode = 1; });
module.exports = { main };
