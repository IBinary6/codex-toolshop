#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = path.resolve(__dirname, '..');
const providers = require('./providers.json');
const catalog = require('../scripts/catalog.json');
const engine = require('../package.json');
const { PROFILES, template } = require('../scripts/config.cjs');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const commands = new Set(['context7', 'exa', 'tavily']);
const allowed = ['context7-codex', 'exa-codex', 'tavily-codex', 'microsoft-learn-codex', 'fetch-codex', 'sequential-thinking-codex'];

function plans() {
  if (JSON.stringify(providers.map(p => p.name)) !== JSON.stringify(allowed)) throw new Error('Invalid provider package list.');
  return providers.map(provider => {
    const selected = PROFILES[provider.provider];
    if (!selected || selected.name !== provider.name) throw new Error('Configuration profile does not match package name.');
    const files = new Map();
    const cli = commands.has(provider.provider);
    const version = '0.1.2';
    const copy = file => {
      const actual = fs.realpathSync(path.join(source, file));
      if (!actual.startsWith(fs.realpathSync(source) + path.sep)) throw new Error('Maintenance source file is outside the package.');
      files.set(file, fs.readFileSync(actual));
    };
    for (const name of ['config', 'setup', 'child-transport', ...(cli ? ['command', 'command-client'] : ['gateway', 'server'])]) copy(`scripts/${name}.cjs`);
    if (provider.provider === 'fetch') copy('scripts/local-backends.cjs');
    if (provider.provider === 'sequentialthinking') {
      copy('scripts/sequential-core.cjs');
      const base = 'vendor/sequential-thinking';
      const provenance = require('../vendor/sequential-thinking/provenance.json');
      for (const file of [...Object.keys(provenance.sha256), 'package.json', 'provenance.json', 'LICENSE']) copy(`${base}/${file}`);
    }
    files.set('config.example.json', json(template(provider.provider)));
    files.set('scripts/catalog.json', json({ providers: { [provider.provider]: catalog.providers[provider.provider] } }));
    files.set('package.json', json({ name: provider.name, version, private: true, description: provider.description,
      researchToolsProvider: provider.provider, engines: { node: provider.provider === 'context7' ? '>=22.13.0' : '>=20' }, scripts: { setup: 'node scripts/setup.cjs', doctor: 'node scripts/setup.cjs --doctor', ...(cli ? { list: 'node scripts/command.cjs --list', call: 'node scripts/command.cjs' } : {}) } }));
    if (!cli) files.set('.mcp.json', json({ mcpServers: { [provider.provider]: {
      type: 'stdio', command: 'node', args: ['scripts/server.cjs', '--provider', provider.provider], cwd: '.', startup_timeout_sec: 30, tool_timeout_sec: 240
    } } }));
    files.set('.codex-plugin/plugin.json', json({ name: provider.name, version, description: provider.description,
      author: { name: 'IBinary6' }, keywords: [provider.provider, 'codex'], skills: './skills/', ...(!cli ? { mcpServers: './.mcp.json' } : {}),
      interface: { displayName: provider.displayName, shortDescription: provider.description, longDescription: cli ? 'Skill and per-call command entry points, with no persistent MCP; enable independently on the plugin page.' : 'Self-contained on-demand MCP plugin; enable independently on the plugin page with entirely local tool discovery.', developerName: 'IBinary6', category: 'Productivity', capabilities: ['Read'], defaultPrompt: [`Use ${provider.displayName}.`], brandColor: '#2563EB' } }));
    const tools = catalog.providers[provider.provider].map(tool => '`' + tool.name + '`').join(', ');
    const invocation = cli ? `\n\nFind this package's root two directories above the directory containing this SKILL.md (the filename is not a directory). Run \`node <absolute-package-root>/scripts/command.cjs\` by absolute path. Write one JSON object \`{"name":"command_alias","arguments":{...}}\` to stdin and close it, or use \`--input-file <absolute-JSON-file-path>\`. Do not rely on the session cwd. \`--list\` locally lists ${tools} and their original parameter schemas; \`--help\` explains the protocol. stdout contains one JSON object with content and structuredContent; isError or a nonzero exit means failure. Read keys only from private JSON; never put them in a request, command line, or log.\n\nThis package has no MCP entry point. If a command is missing, check this package's path and runtime using the README. Do not fall back to an old CC Switch MCP, log in automatically, or run official setup.${provider.provider === 'context7' ? ' query-docs also accepts a language string, forwarded as the official --language option. The official ctx7 0.6.0 package is prepared in this plugin runtime on the first live call. An empty apiKey uses anonymous access; inherited matching environment keys are cleared and host OAuth is isolated.' : ''}${provider.provider === 'tavily' ? ' research creates a job and polls until completed/failed by default; top-level research:{wait:false} only creates the job and returns request_id. To resume, use {name:"tavily_research",arguments:{},research:{requestId:"original-id"}}, which sends only GET. A local timeout or cancellation does not cancel the server job; retain its ID to resume without creating a duplicate.' : ''}` : '';
    const adapterNotes = provider.provider === 'exa'
      ? '\n\nSearch explicitly requests contents.highlights:true. A standalone category:people or category:company marker in query becomes the REST category and is removed from search text; other text stays intact. The default objective still uses the first 4096 characters of the original query, and an explicit objective is preserved. Use web_fetch_exa for full text when excerpts are insufficient.'
      : provider.provider === 'tavily'
        ? '\n\nAfter a valid research ID is obtained, failures while waiting (HTTP, network, parsing, unknown status, local cancellation, or timeout) return redacted structuredContent with request_id, resume:true, and a safe error. isError is true and the CLI exits 1. Keep the ID and resume with the requestId form above, which sends only GET and avoids a duplicate POST. Invalid creation IDs provide no resume information.'
        : '';
    files.set(`skills/${provider.name}/SKILL.md`, Buffer.from(`---\nname: ${provider.name}\ndescription: ${provider.description}\n---\n\n${provider.usage}${invocation}${adapterNotes}\n\n${provider.config}\n\nFor configuration or runtime problems, read [README.md](../../README.md) and run this package's setup/doctor. Report only redacted status. Check tool results against sources and stop calling tools once the task has sufficient evidence.\n`));
    const boundary = cli ? `Requires Node.js ${provider.provider === 'context7' ? '≥22.13.0 (per the published ctx7 0.6.0 package engines) and npm' : '≥20'}. There is no MCP entry point, startup hook, or background installer; loading the plugin does not start Node. Each live call launches a short-lived command that exits when finished. --list/--help are entirely local and do not access the network or prepare dependencies.` : 'Requires Node.js ≥20. This package starts one Node gateway. initialize, ping, and tools/list are entirely local: they do not access the network, start a backend, or prepare dependencies. There are no startup hooks.';
    const sources = provider.provider === 'context7' ? '[Official CLI](https://context7.com/docs/clients/cli), [pinned release](https://registry.npmjs.org/ctx7/0.6.0). The first call installs ctx7@0.6.0 with npm --prefix and --ignore-scripts, then runs the official entry point directly with Node; it does not run login/setup. The runtime defaults to CODEX_HOME/context7-codex/runtime (falling back to ~/.codex). The package cache and officially supported XDG credentials/state are isolated there. The package creates its empty credential file with wx only, preserving existing files. Live commands receive the private JSON key through CONTEXT7_API_KEY and set CTX7_TELEMETRY_DISABLED=1. Verification of the official package requires npm to be discoverable in the Node distribution or PATH; if it is missing, an installation hint is returned.' : provider.provider === 'exa' ? '[Official Search](https://exa.ai/docs/reference/search), [official Contents](https://exa.ai/docs/reference/get-contents), [official agent skills](https://github.com/exa-labs/agent-skills). Requests POST directly to api.exa.ai/search or /contents, with x-api-key only in the request header. An explicit objective is preserved; the default is the first 4096 characters of query. urls maps to ids, and maxCharacters maps to text.maxCharacters (default 3000). Response results, statuses, and pagination fields are preserved. Pages are not appended automatically and requests are not retried.' : provider.provider === 'tavily' ? '[Official API](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Research create](https://docs.tavily.com/documentation/api-reference/endpoint/research), [Research lookup](https://docs.tavily.com/documentation/api-reference/endpoint/research-get). Requests POST directly to api.tavily.com/search, extract, crawl, map, or research, with the Bearer key only in the request header. After creation, research polls with GET using request_id. Top-level research:{wait:false} only creates a job; research:{requestId:"original-id"} only resumes lookup (arguments:{}). Local cancellation or timeout does not cancel a created server job. Keep the returned ID to query without creating a duplicate. A failed job returns isError.' : '';
    const runtimeNotes = cli ? '' : '\n\nBefore creating the gateway, create and switch to the runtime directory beside the selected private configuration file. An absolute configuration override also determines this runtime directory. The Fetch backend inherits a stable cwd. Startup does not write to the plugin cache, and active Windows processes do not lock the cache directory and prevent upgrade renames through cwd.';
    const values = { DISPLAY_NAME: provider.displayName, PACKAGE_VERSION: version, PLUGIN_NAME: provider.name, OVERRIDE_ENV: selected.override, TEMPLATE: selected.key ? '{ "version": 1, "apiKey": "" }' : '{ "version": 1 }', TOOLS: tools, USAGE: provider.usage, CONFIG: provider.config, ENGINE_VERSION: engine.version, BOUNDARY: boundary + runtimeNotes, SOURCES: sources + adapterNotes, INVOCATION: cli ? 'Run `node <absolute-package-root>/scripts/command.cjs` with one `{name,arguments}` JSON object on stdin and then close input, or use `--input-file <absolute-JSON-path>`. `--list` shows this package\'s commands and parameters. It returns one `{content,structuredContent?,isError?}` JSON object and exits 1 on failure.' : 'Call this package through its MCP tools.' };
    const readme = fs.readFileSync(path.join(__dirname, 'README.template.md'), 'utf8').replace(/{{([A-Z_]+)}}/g, (_, key) => values[key]);
    files.set('README.md', Buffer.from(readme));
    const state = { generator: 'research-tools-codex', engineVersion: engine.version, mode: cli ? 'command' : 'mcp', files: Object.fromEntries([...files].map(([file, bytes]) => [file, hash(bytes)])) };
    files.set('.generated.json', json(state));
    return { ...provider, files };
  });
}

function inventory(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Generated directory contains a symlink; update stopped.');
    if (entry.isDirectory()) result.push(...inventory(path.join(directory, entry.name), file + '/'));
    else result.push(file);
  }
  return result;
}

function generate(options = {}) {
  const outputRoot = path.resolve(options.outputRoot || path.join(source, '..'));
  if (!fs.existsSync(outputRoot)) {
    if (options.check) throw new Error('Generated root directory does not exist.');
    fs.mkdirSync(outputRoot, { recursive: true });
  }
  const work = plans();
  // Check all six packages before writing; refuse to overwrite unknown files or manual edits that differ from the previous snapshot.
  for (const plan of work) {
    const directory = path.join(outputRoot, plan.name);
    if (!fs.existsSync(directory)) { if (options.check) throw new Error(`${plan.name} has not been generated.`); continue; }
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Generated target must be a regular directory.');
    if (fs.realpathSync(directory) !== path.join(fs.realpathSync(outputRoot), plan.name) || fs.realpathSync(directory) === fs.realpathSync(source)) throw new Error('Generated target resolves outside the allowed path.');
    plan.obsolete = [];
    let old;
    const marker = path.join(directory, '.generated.json');
    if (fs.existsSync(marker)) {
      old = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (old.generator !== 'research-tools-codex' || !old.files || typeof old.files !== 'object') throw new Error('Invalid generation snapshot.');
    }
    for (const file of inventory(directory)) {
      const desired = plan.files.get(file);
      const current = fs.readFileSync(path.join(directory, file));
      if (!desired) {
        if (!Object.hasOwn(old?.files || {}, file)) throw new Error(`${plan.name} contains unknown file ${file}; update stopped.`);
        if (hash(current) !== old.files[file]) throw new Error(`${plan.name}/${file} contains manual changes; deletion stopped.`);
        if (options.check) throw new Error(`${plan.name}/${file} is an obsolete generated file.`);
        plan.obsolete.push(file);
        continue;
      }
      if (options.check && !current.equals(desired)) throw new Error(`${plan.name}/${file} differs from the maintenance source.`);
      if (!options.check && file !== '.generated.json' && !current.equals(desired) && hash(current) !== old?.files?.[file]) throw new Error(`${plan.name}/${file} contains manual changes; overwrite stopped.`);
    }
    if (options.check) for (const file of plan.files.keys()) if (!fs.existsSync(path.join(directory, file))) throw new Error(`${plan.name}/${file} is missing.`);
  }
  if (!options.check) for (const plan of work) {
    for (const file of plan.obsolete || []) fs.unlinkSync(path.join(outputRoot, plan.name, file));
    for (const [file, bytes] of plan.files) {
    const target = path.join(outputRoot, plan.name, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) fs.writeFileSync(target, bytes);
    }
  }
  return work.map(plan => plan.name);
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--check') || args.length > 1) throw new Error('Only --check is supported.');
    const names = generate({ check: args.includes('--check') });
    console.log(`Six self-contained plugins ${args.length ? 'passed consistency checks' : 'generated'}: ${names.join(', ')}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { providers, plans, generate };
