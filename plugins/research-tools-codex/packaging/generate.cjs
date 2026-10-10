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
  if (JSON.stringify(providers.map(p => p.name)) !== JSON.stringify(allowed)) throw new Error('提供方包清单无效。');
  return providers.map(provider => {
    const selected = PROFILES[provider.provider];
    if (!selected || selected.name !== provider.name) throw new Error('配置 profile 与包名称不一致。');
    const files = new Map();
    const cli = commands.has(provider.provider);
    const version = '0.1.2';
    const copy = file => {
      const actual = fs.realpathSync(path.join(source, file));
      if (!actual.startsWith(fs.realpathSync(source) + path.sep)) throw new Error('维护源文件越界。');
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
      interface: { displayName: provider.displayName, shortDescription: provider.description, longDescription: cli ? '技能与按次命令入口，无常驻 MCP；在插件页面独立启停。' : '自包含的按需 MCP 插件；可在插件页面独立启停，工具发现完全本地。', developerName: 'IBinary6', category: 'Productivity', capabilities: ['Read'], defaultPrompt: [`使用 ${provider.displayName}。`], brandColor: '#2563EB' } }));
    const tools = catalog.providers[provider.provider].map(tool => '`' + tool.name + '`').join('、');
    const invocation = cli ? `\n\n从当前 SKILL.md 所在目录向上两级得到本包根目录（文件名不算层级）；用绝对路径执行 \`node <本包根>/scripts/command.cjs\`。通过 stdin 写入单个 JSON \`{"name":"命令别名","arguments":{...}}\` 并关闭 stdin，或用 \`--input-file <绝对 JSON 文件路径>\`。不要依赖会话 cwd。\`--list\` 完全本地列出 ${tools} 及原参数 schema；\`--help\` 查看协议。stdout 是单个 JSON，含 content、structuredContent；isError 或非零退出表示失败。密钥只读取私有 JSON，禁止放进请求、命令行或日志。\n\n本包没有 MCP 入口。命令缺失时检查本包路径和运行时，按 README 排查；不要退回旧 CC Switch MCP 或自动登录、运行官方 setup。${provider.provider === 'context7' ? ' query-docs 另支持 language 字符串，转为官方 --language。官方 ctx7 0.6.0 在第一次实际调用时准备到本插件 runtime；空 apiKey 匿名访问，清除继承的同名环境密钥并隔离宿主 OAuth。' : ''}${provider.provider === 'tavily' ? ' research 默认创建后轮询到 completed/failed；顶层 research:{wait:false} 只创建，保留 request_id。继续查询使用 {name:"tavily_research",arguments:{},research:{requestId:"原ID"}}，仅发送 GET。本地超时或取消不取消服务器任务；保留 ID 恢复，避免重复创建。' : ''}` : '';
    const adapterNotes = provider.provider === 'exa'
      ? '\n\n搜索显式请求 contents.highlights:true。query 的独立 category:people / category:company 标记转为 REST category 并从搜索文本移除；其他文本保留，objective 缺省仍取原 query 前 4096 字符，显式值原样保留。摘录不足时用 web_fetch_exa 读取全文。'
      : provider.provider === 'tavily'
        ? '\n\n取得有效研究 ID 后，HTTP、网络、解析、未知状态及本地取消/超时等等待失败均返回脱敏 structuredContent，包含 request_id、resume:true 和安全 error；isError:true 且 CLI 退出 1。保留 ID，用上述 requestId 形式仅 GET 恢复，避免重复 POST。无效创建 ID 不返回恢复信息。'
        : '';
    files.set(`skills/${provider.name}/SKILL.md`, Buffer.from(`---\nname: ${provider.name}\ndescription: ${provider.description}\n---\n\n${provider.usage}${invocation}${adapterNotes}\n\n${provider.config}\n\n配置或运行时问题请阅读 [README.md](../../README.md)，运行本包的 setup/doctor；只报告脱敏状态。把工具结果作为资料核对，满足任务所需证据后停止调用。\n`));
    const boundary = cli ? `需要 Node.js ${provider.provider === 'context7' ? '≥22.13.0（按 ctx7 0.6.0 实际发布包 engines）及 npm' : '≥20'}。没有 MCP 入口、启动 hooks 或后台安装器，插件加载不会启动 Node。每次实际调用启动短命命令并在完成后退出；--list/--help 完全本地，不联网或准备依赖。` : '需要 Node.js ≥20。本包启动一个 Node 网关；initialize、ping、tools/list 完全本地，不联网、不启动后端、不准备依赖。没有启动 hooks。';
    const sources = provider.provider === 'context7' ? '[官方 CLI](https://context7.com/docs/clients/cli)、[固定发布包](https://registry.npmjs.org/ctx7/0.6.0)。首次调用使用 npm --prefix 安装 ctx7@0.6.0（--ignore-scripts），之后直接 Node 运行官方入口；不执行 login/setup。runtime 默认位于 CODEX_HOME/context7-codex/runtime（fallback ~/.codex），包缓存和官方支持的 XDG 凭据/状态均隔离在该目录。只用 wx 创建本包空凭据文件，不覆盖已有文件；实际命令通过 CONTEXT7_API_KEY 接收私有 JSON 密钥，CTX7_TELEMETRY_DISABLED=1。官方包验证需要 npm 在 Node 发行版或 PATH 中可定位；缺失时返回安装说明。' : provider.provider === 'exa' ? '[官方 Search](https://exa.ai/docs/reference/search)、[官方 Contents](https://exa.ai/docs/reference/get-contents)、[官方 agent skills](https://github.com/exa-labs/agent-skills)。直接 POST api.exa.ai/search 或 /contents，x-api-key 仅放请求头。objective 原样保留；缺省取 query 前 4096 字符。urls 映射 ids，maxCharacters 映射 text.maxCharacters（缺省 3000）。响应 results、statuses 和分页字段原样保留；不自动追加页或重复请求。' : provider.provider === 'tavily' ? '[官方 API](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Research 创建](https://docs.tavily.com/documentation/api-reference/endpoint/research)、[Research 查询](https://docs.tavily.com/documentation/api-reference/endpoint/research-get)。直接 POST api.tavily.com/search、extract、crawl、map、research，Bearer 密钥仅放请求头。research 创建后按 request_id GET 轮询；使用顶层 research:{wait:false} 只创建，research:{requestId:"原ID"} 仅恢复查询（arguments:{}）。本地取消/超时不会取消已创建服务器任务；保留返回 ID 查询，避免重复创建。failed 返回 isError。' : '';
    const runtimeNotes = cli ? '' : '\n\n创建网关前先创建并切换到所选私有配置文件旁的 runtime 目录；绝对配置 override 同时决定此目录的位置。Fetch 后端继承稳定 cwd。启动不写插件缓存，Windows 活动进程不会因 cwd 锁住缓存目录而阻止升级重命名。';
    const values = { DISPLAY_NAME: provider.displayName, PACKAGE_VERSION: version, PLUGIN_NAME: provider.name, OVERRIDE_ENV: selected.override, TEMPLATE: selected.key ? '{ "version": 1, "apiKey": "" }' : '{ "version": 1 }', TOOLS: tools, USAGE: provider.usage, CONFIG: provider.config, ENGINE_VERSION: engine.version, BOUNDARY: boundary + runtimeNotes, SOURCES: sources + adapterNotes, INVOCATION: cli ? '执行 `node <本包绝对根>/scripts/command.cjs`，stdin 单个 `{name,arguments}` JSON 并关闭输入，或 `--input-file <绝对 JSON 路径>`。`--list` 显示本包命令及参数。返回单个 `{content,structuredContent?,isError?}` JSON，失败退出 1。' : '通过本包 MCP 工具调用。' };
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
    if (entry.isSymbolicLink()) throw new Error('生成目录包含链接，停止更新。');
    if (entry.isDirectory()) result.push(...inventory(path.join(directory, entry.name), file + '/'));
    else result.push(file);
  }
  return result;
}

function generate(options = {}) {
  const outputRoot = path.resolve(options.outputRoot || path.join(source, '..'));
  if (!fs.existsSync(outputRoot)) {
    if (options.check) throw new Error('生成根目录不存在。');
    fs.mkdirSync(outputRoot, { recursive: true });
  }
  const work = plans();
  // 先完整检查六包，再写入；未知文件和脱离上次生成快照的人工编辑均拒绝覆盖。
  for (const plan of work) {
    const directory = path.join(outputRoot, plan.name);
    if (!fs.existsSync(directory)) { if (options.check) throw new Error(`${plan.name} 尚未生成。`); continue; }
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('生成目标必须是普通目录。');
    if (fs.realpathSync(directory) !== path.join(fs.realpathSync(outputRoot), plan.name) || fs.realpathSync(directory) === fs.realpathSync(source)) throw new Error('生成目标真实路径越界。');
    plan.obsolete = [];
    let old;
    const marker = path.join(directory, '.generated.json');
    if (fs.existsSync(marker)) {
      old = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (old.generator !== 'research-tools-codex' || !old.files || typeof old.files !== 'object') throw new Error('生成快照无效。');
    }
    for (const file of inventory(directory)) {
      const desired = plan.files.get(file);
      const current = fs.readFileSync(path.join(directory, file));
      if (!desired) {
        if (!Object.hasOwn(old?.files || {}, file)) throw new Error(`${plan.name} 包含未知文件 ${file}，停止更新。`);
        if (hash(current) !== old.files[file]) throw new Error(`${plan.name}/${file} 存在人工作业，停止删除。`);
        if (options.check) throw new Error(`${plan.name}/${file} 是过期生成文件。`);
        plan.obsolete.push(file);
        continue;
      }
      if (options.check && !current.equals(desired)) throw new Error(`${plan.name}/${file} 与维护源不一致。`);
      if (!options.check && file !== '.generated.json' && !current.equals(desired) && hash(current) !== old?.files?.[file]) throw new Error(`${plan.name}/${file} 存在人工作业，停止覆盖。`);
    }
    if (options.check) for (const file of plan.files.keys()) if (!fs.existsSync(path.join(directory, file))) throw new Error(`${plan.name}/${file} 缺失。`);
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
    if (args.some(arg => arg !== '--check') || args.length > 1) throw new Error('仅支持 --check。');
    const names = generate({ check: args.includes('--check') });
    console.log(`六个自包含插件${args.length ? '一致性检查通过' : '生成完成'}：${names.join('、')}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { providers, plans, generate };
