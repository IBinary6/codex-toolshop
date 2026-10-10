'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pluginDataDir } = require('../hooks/js/lib/runtime');
const { killProcessTree } = require('./lazy-mcp.cjs');

const SCHEMA = 2;
const MAX_DATABASE_BYTES = 32 * 1024 * 1024;
const ENV_INPUTS = ['LUDASHI_PC_PUBLIC_ROOT', 'INCLUDE', 'CL', '_CL_', 'WindowsSDKVersion', 'VCToolsVersion', 'TEMP', 'TMP', 'USERPROFILE'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const diag = (code, message) => ({ code, message });
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function canonical(file) { return fs.realpathSync.native(path.resolve(file)); }
function identity(file) { const value = canonical(file); return process.platform === 'win32' ? value.toLowerCase() : value; }
function fileHash(file) { try { return hash(fs.readFileSync(file)); } catch (_) { return null; } }
function probeState(probe) {
  if (!probe || !path.isAbsolute(probe.pattern || '')) return null;
  const normalize = file => process.platform === 'win32' ? file.replace(/\\/g, '/').toLowerCase() : file.replace(/\\/g, '/');
  if (probe.kind === 'path') {
    try { const stat = fs.statSync(probe.pattern); return [stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other']; }
    catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? ['missing'] : null; }
  }
  if (probe.kind !== 'glob' || probe.pattern.includes('**')) return null;
  const parsed = path.parse(probe.pattern);
  const segments = probe.pattern.slice(parsed.root.length).split(/[\\/]/).filter(Boolean);
  if (segments.length > 32) return null;
  let candidates = [parsed.root], visited = 0;
  try {
    for (const segment of segments) {
      const next = [];
      const matcher = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, process.platform === 'win32' ? 'i' : '');
      for (const parent of candidates) {
        if (!/[*?]/.test(segment)) { const literal = path.join(parent, segment); if (fs.existsSync(literal)) next.push(literal); continue; }
        let entries;
        try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
        visited += entries.length;
        if (visited > 8192) return null;
        for (const entry of entries) if (matcher.test(entry.name)) next.push(path.join(parent, entry.name));
      }
      candidates = next;
    }
    return candidates.filter(file => fs.statSync(file).isFile()).map(normalize).sort();
  } catch (_) { return null; }
}

function snapshotMatches(inputs, probes) {
  return Array.isArray(inputs) && inputs.length > 0 && inputs.every(input => input && /^[a-f0-9]{64}$/.test(input.digest) && fileHash(input.file) === input.digest) &&
    Array.isArray(probes) && probes.every(probe => JSON.stringify(probeState(probe)) === JSON.stringify(probe.state));
}
function serenaProjectPaths(root, options = {}) {
  const realRoot = canonical(root);
  const dataRoot = path.resolve(options.pluginDataDir || pluginDataDir(options));
  const projectHome = path.join(dataRoot, 'serena-build', hash(identity(realRoot)).slice(0, 32));
  return { projectHome, configurationPath: path.join(projectHome, 'config.json') };
}
function selectedEnvironment(env, names = ENV_INPUTS) {
  // 仅对求值使用的环境变量取指纹；不会读取或输出整个环境。
  return hash(JSON.stringify([...new Set(names)].sort().map(name => [name, env[name] || ''])));
}

function readDatabase(file) {
  try {
    if (fs.statSync(file).size > MAX_DATABASE_BYTES) return { ok: false };
    const commands = readJson(file);
    if (!Array.isArray(commands) || !commands.length || commands.length > 100000) return { ok: false };
    const seen = new Map();
    for (const row of commands) {
      if (!row || typeof row.directory !== 'string' ||
          typeof row.file !== 'string' || !row.file ||
          !(typeof row.command === 'string' && row.command.trim() || Array.isArray(row.arguments) && row.arguments.length && row.arguments.every(v => typeof v === 'string' && !v.includes('\0')))) return { ok: false };
      const directory = path.resolve(path.dirname(file), row.directory);
      if (!fs.existsSync(directory) || !fs.existsSync(path.resolve(directory, row.file))) return { ok: false };
      const key = identity(path.resolve(directory, row.file));
      const effective = JSON.stringify([directory, row.arguments || row.command]);
      if (seen.has(key) && seen.get(key) !== effective) return { ok: false, conflict: true };
      seen.set(key, effective);
    }
    return { ok: true, commands, hasRelativeDirectories: commands.some(row => !path.isAbsolute(row.directory)),
      normalizedCommands: commands.map(row => ({ ...row, directory: path.resolve(path.dirname(file), row.directory) })), digest: fileHash(file) };
  } catch (_) { return { ok: false }; }
}

function boundedFiles(root, predicate, maxDepth = 3) {
  const found = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (visited++ > 512 || found.length >= 64) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isFile() && predicate(entry.name)) found.push(file);
      else if (entry.isDirectory() && depth < maxDepth && !['.git', '.serena', 'node_modules', 'vendor', 'packages'].includes(entry.name)) walk(file, depth + 1);
      if (found.length >= 64) break;
    }
  };
  walk(root, 0);
  return { files: found, truncated: visited > 512 || found.length >= 64 };
}

function splitList(value) { return String(value || '').split(';').map(v => v.trim()).filter(v => v && !/^%\(.+\)$/.test(v)); }
function splitOptions(value) {
  // Windows 引号规则：保留路径中的反斜线，仅在引号前处理转义。
  const result = [];
  let token = '', quoted = false, started = false;
  const text = String(value || '').replace(/%\(AdditionalOptions\)/g, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      let end = i;
      while (text[end] === '\\') end++;
      const count = end - i;
      if (text[end] === '"') {
        token += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) token += '"'; else quoted = !quoted;
        i = end;
      } else { token += '\\'.repeat(count); i = end - 1; }
      started = true;
    } else if (char === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(char) && !quoted) { if (started) result.push(token); token = ''; started = false; }
    else { token += char; started = true; }
  }
  if (quoted) throw new Error('unterminated quote');
  if (started) result.push(token);
  return result;
}

function appendCompileOptions(args, value, diagnostics) {
  try {
    const options = splitOptions(value);
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      if (/^\/(?:D|U|I|FI)$/.test(option)) { if (!options[i + 1]) throw new Error('missing option operand'); args.push(option, options[++i]); }
      else if (/^\/(?:D|U|I|FI).+/.test(option) || /^\/(?:std:(?:c\+\+(?:14|17|20|23|latest)|c(?:11|17|latest))|Zc:(?:wchar_t|forScope|auto|rvalueCast|strictStrings|implicitNoexcept|threadSafeInit|__cplusplus|alignedNew|twoPhase|sizedDealloc|externConstexpr|preprocessor|ternary|char8_t|inline|enumTypes|lambda|zeroSizeArray)-?|EH(?:sc|s|a|c|s-c-)-?|GR-?|M[DT]d?|arch:(?:SSE|SSE2|AVX|AVX2|AVX512)|favor:(?:blend|AMD64|INTEL64|ATOM)|fp:(?:precise|strict|fast)|permissive-?|utf-8|source-charset:.+|execution-charset:.+|TC|TP|X|u|openmp(?::(?:experimental|llvm))?)$/.test(option)) args.push(option);
      else if (/^\/(?:O[012dx]|Ob[0123]|O[itysg]-?|W[01234]|w[de]\d+|WX-?|Z[iI7]|Zo-?|FS|MP\d*|G[mSywFL]-?|nologo|c|FC|diagnostics:(?:classic|column|caret)|analyze(?::.+)?|errorReport:(?:none|prompt|queue|send)|bigobj)$/.test(option)) args.push(option);
      else diagnostics.push(diag('unsupported_compile_option', '未识别编译选项；为保护环境值，不回显原始参数。'));
    }
  } catch (_) { diagnostics.push(diag('invalid_compile_options', '编译选项引号或参数不完整。')); }
}

/** 将 MSBuild 已求值的逐文件设置转换为 clang-cl 数据库，未知语义拒绝降级为伪参数。 */
function commandsFromEvaluation(evaluation) {
  const diagnostics = [];
  const commands = [];
  const platform = evaluation.platform;
  const targets = { x64: 'x86_64-pc-windows-msvc', Win32: 'i686-pc-windows-msvc', x86: 'i686-pc-windows-msvc', ARM64: 'aarch64-pc-windows-msvc', ARM: 'armv7-pc-windows-msvc' };
  if (!targets[platform]) return { status: 'unsupported', commands, diagnostics: [diag('unsupported_platform', '当前平台没有已验证的 clang-cl 目标映射。')] };
  if (!evaluation.cl || !/^19\.\d+/.test(evaluation.msvcVersion || '')) return { status: 'unsupported', commands, diagnostics: [diag('missing_compiler_identity', '无法确认已选 MSVC 编译器及兼容版本。')] };
  const standards = { stdcpp14: '/std:c++14', stdcpp17: '/std:c++17', stdcpp20: '/std:c++20', stdcpplatest: '/std:c++latest', stdc11: '/std:c11', stdc17: '/std:c17' };
  const projectDir = path.dirname(evaluation.project);
  for (const item of evaluation.sources || []) {
    if (/^(true|1)$/i.test(item.ExcludedFromBuild || '')) continue;
    if (item.ExcludedFromBuild && !/^(false|0)$/i.test(item.ExcludedFromBuild)) diagnostics.push(diag('unsupported_exclusion', 'ClCompile 的 ExcludedFromBuild 不是可识别的布尔值。'));
    const file = path.resolve(projectDir, item.FullPath || item.Include || '');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) diagnostics.push(diag('missing_compile_file', 'ClCompile 源文件不存在；不会通过伪造源文件准备数据库。'));
    const args = [evaluation.cl, '--driver-mode=cl', `/clang:--target=${targets[platform]}`, `/clang:-fms-compatibility-version=${evaluation.msvcVersion}`];
    // MSVC 合同：CL 环境前置，逐文件选项居中，_CL_ 环境后置；同名选项不能去重。
    appendCompileOptions(args, evaluation.clOptions, diagnostics);
    // clang-cl 的 /clang: 包装确保原生 cl.exe 驱动身份也采用 clang 的 target/兼容语义。
    if (item.LanguageStandard) {
      if (standards[item.LanguageStandard]) args.push(standards[item.LanguageStandard]);
      else diagnostics.push(diag('unsupported_standard', `不支持 LanguageStandard=${item.LanguageStandard}。`));
    }
    if (item.LanguageStandard_C) {
      if (standards[item.LanguageStandard_C]) args.push(standards[item.LanguageStandard_C]);
      else diagnostics.push(diag('unsupported_standard', `不支持 LanguageStandard_C=${item.LanguageStandard_C}。`));
    }
    if (item.CompileAs === 'CompileAsC') args.push('/TC');
    else if (item.CompileAs === 'CompileAsCpp') args.push('/TP');
    else if (item.CompileAs && item.CompileAs !== 'Default') diagnostics.push(diag('unsupported_compile_as', '未知 CompileAs 设置。'));
    const runtime = { multithreaded: '/MT', multithreadeddebug: '/MTd', multithreadeddll: '/MD', multithreadeddebugdll: '/MDd' };
    if (item.RuntimeLibrary) { if (runtime[item.RuntimeLibrary.toLowerCase()]) args.push(runtime[item.RuntimeLibrary.toLowerCase()]); else diagnostics.push(diag('unsupported_runtime', '未知 RuntimeLibrary 设置。')); }
    const exceptions = { Sync: '/EHsc', Async: '/EHa', SyncCThrow: '/EHs' };
    if (item.ExceptionHandling && !/^(false|0)$/i.test(item.ExceptionHandling)) {
      if (exceptions[item.ExceptionHandling]) args.push(exceptions[item.ExceptionHandling]); else diagnostics.push(diag('unsupported_exception_mode', '未知 ExceptionHandling 设置。'));
    }
    else if (/^(false|0)$/i.test(item.ExceptionHandling || '')) args.push('/EHs-c-');
    if (/^(false|0)$/i.test(item.RuntimeTypeInfo || '')) args.push('/GR-');
    else if (/^(true|1)$/i.test(item.RuntimeTypeInfo || '')) args.push('/GR');
    if (item.TreatWChar_tAsBuiltInType) {
      if (/^(true|1)$/i.test(item.TreatWChar_tAsBuiltInType)) args.push('/Zc:wchar_t');
      else if (/^(false|0)$/i.test(item.TreatWChar_tAsBuiltInType)) args.push('/Zc:wchar_t-');
      else diagnostics.push(diag('unsupported_wchar_mode', '未知 wchar_t 设置。'));
    }
    if (/^(true|1)$/i.test(item.ConformanceMode || '')) args.push('/permissive-');
    const alignment = { '1Byte': '/Zp1', '2Bytes': '/Zp2', '4Bytes': '/Zp4', '8Bytes': '/Zp8', '16Bytes': '/Zp16' };
    if (item.StructMemberAlignment && item.StructMemberAlignment !== 'Default') {
      if (alignment[item.StructMemberAlignment]) args.push(alignment[item.StructMemberAlignment]); else diagnostics.push(diag('unsupported_alignment', '未知结构体成员对齐设置。'));
    }
    const calling = { Cdecl: '/Gd', FastCall: '/Gr', StdCall: '/Gz', VectorCall: '/Gv' };
    if (item.CallingConvention) { if (calling[item.CallingConvention]) args.push(calling[item.CallingConvention]); else diagnostics.push(diag('unsupported_calling_convention', '未知调用约定。')); }
    const instruction = { StreamingSIMDExtensions: '/arch:SSE', StreamingSIMDExtensions2: '/arch:SSE2', AdvancedVectorExtensions: '/arch:AVX', AdvancedVectorExtensions2: '/arch:AVX2', AdvancedVectorExtensions512: '/arch:AVX512' };
    if (item.EnableEnhancedInstructionSet && item.EnableEnhancedInstructionSet !== 'NoExtensions' && item.EnableEnhancedInstructionSet !== 'NotSet') {
      if (instruction[item.EnableEnhancedInstructionSet]) args.push(instruction[item.EnableEnhancedInstructionSet]); else diagnostics.push(diag('unsupported_instruction_set', '未知指令集选项。'));
    }
    const floating = { Precise: '/fp:precise', Strict: '/fp:strict', Fast: '/fp:fast' };
    if (item.FloatingPointModel) { if (floating[item.FloatingPointModel]) args.push(floating[item.FloatingPointModel]); else diagnostics.push(diag('unsupported_float_mode', '未知浮点模型。')); }
    if (item.CompileAsManaged && !/^(false|0)$/i.test(item.CompileAsManaged)) diagnostics.push(diag('unsupported_managed_compile', '暂不支持 C++/CLI 编译模式。'));
    if (item.CharacterSet === 'Unicode' || evaluation.characterSet === 'Unicode') args.push('/D_UNICODE', '/DUNICODE');
    if (item.CharacterSet === 'MultiByte' || evaluation.characterSet === 'MultiByte') args.push('/D_MBCS');
    for (const value of splitList(item.PreprocessorDefinitions)) args.push(`/D${value}`);
    for (const value of splitList(item.UndefinePreprocessorDefinitions)) args.push(`/U${value}`);
    if (/^(true|1)$/i.test(item.UndefineAllPreprocessorDefinitions || '')) args.push('/u');
    const ignoreStandard = /^(true|1)$/i.test(item.IgnoreStandardIncludePath || '');
    const explicitIncludes = [...splitList(item.AdditionalIncludeDirectories), ...splitList(item.AdditionalExternalIncludeDirectories), ...splitList(item.ExternalIncludePath)];
    const standardIncludes = ignoreStandard ? [] : splitList(evaluation.includePath);
    const includePaths = [...explicitIncludes, ...standardIncludes];
    // clangd 的进程环境未经过选定 vcvars；禁止它自动补入其他 VS/SDK，再注入求值所得 INCLUDE。
    args.push('/X');
    for (const value of [...new Set(explicitIncludes)]) args.push(`/I${path.resolve(projectDir, value.replace(/^"|"$/g, ''))}`);
    for (const value of [...new Set(standardIncludes)]) args.push('/imsvc', path.resolve(projectDir, value.replace(/^"|"$/g, '')));
    for (const value of splitList(item.ForcedIncludeFiles)) args.push(`/FI${value.replace(/^"|"$/g, '')}`);
    for (const value of includePaths) {
      const directory = path.resolve(projectDir, value.replace(/^"|"$/g, ''));
      try { if (!fs.statSync(directory).isDirectory()) throw new Error(); }
      catch (_) { diagnostics.push(diag('missing_include_directory', `求值后的包含目录不存在：${directory}`)); }
    }
    for (const value of splitList(item.ForcedIncludeFiles)) {
      const forced = value.replace(/^"|"$/g, '');
      if (![projectDir, ...includePaths].some(directory => fs.existsSync(path.resolve(projectDir, directory, forced)))) diagnostics.push(diag('missing_forced_include', `强制包含文件不存在：${forced}`));
    }
    if (item.PrecompiledHeader === 'Use' && item.PrecompiledHeaderFile && !splitList(item.ForcedIncludeFiles).length) diagnostics.push(diag('precompiled_header', '项目使用预编译头；数据库保留真实源文件 include，不生成或伪造 PCH。'));
    appendCompileOptions(args, item.AdditionalOptions, diagnostics);
    appendCompileOptions(args, evaluation.trailingClOptions, diagnostics);
    if (args.some(v => /\$\(|%\(/.test(v))) diagnostics.push(diag('unevaluated_compile_parameter', '编译参数中仍有未求值的 MSBuild 表达式。'));
    args.push('/c', file);
    commands.push({ directory: projectDir, file, arguments: args });
  }
  // 同一 TU 多个命令不可被 clangd 随机选择；只准备一个显式选定项目。
  const seen = new Map();
  for (const row of commands) {
    const key = process.platform === 'win32' ? row.file.toLowerCase() : row.file;
    if (seen.has(key) && seen.get(key) !== JSON.stringify(row.arguments)) diagnostics.push(diag('conflicting_translation_unit', '同一源文件存在不同编译参数。'));
    seen.set(key, JSON.stringify(row.arguments));
  }
  const fatal = diagnostics.some(d => d.code !== 'precompiled_header');
  return { status: fatal || !commands.length ? 'unsupported' : 'ready', commands, diagnostics: commands.length ? diagnostics : [...diagnostics, diag('no_compile_items', '选定配置没有有效 ClCompile 项。')] };
}

async function runEvaluation(root, options, selection) {
  if (options.evaluateMsbuild) return options.evaluateMsbuild(root, selection);
  if ((options.platform || process.platform) !== 'win32') return { status: 'unsupported', diagnostics: [diag('msbuild_windows_only', 'VC++ MSBuild 求值需要原生 Windows 工具链。')] };
  const powershell = path.join((options.env || process.env).SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(powershell)) return { status: 'missing_tool', diagnostics: [diag('missing_powershell', '缺少原生 Windows PowerShell 5。')] };
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'export-msbuild.ps1'), '-ProjectFile', selection.project,
    '-HostArchitecture', options.hostArch || process.arch];
  if (selection.configuration) args.push('-Configuration', selection.configuration);
  if (selection.platform) args.push('-Platform', selection.platform);
  return new Promise(resolve => {
    let output = '', settled = false, stopping = false;
    const child = (options.spawn || spawn)(powershell, args, { cwd: root, env: options.env || process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(resolveExit => child.once('exit', resolveExit));
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const stop = async result => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(timer);
      try {
        await (options.killTree || killProcessTree)(child);
        if (child.exitCode == null && child.signalCode == null) {
          let exitTimer;
          try { await Promise.race([exited, new Promise((_, reject) => { exitTimer = setTimeout(() => reject(new Error('root exit timeout')), 5000); })]); }
          finally { clearTimeout(exitTimer); }
        }
        if (child.exitCode == null && child.signalCode == null) throw new Error('root still alive');
        finish(result);
      } catch (_) { finish({ status: 'invalid', diagnostics: [diag('evaluation_cleanup_failed', '求值超限后的自有进程树清理或根进程退出未得到确认。')] }); }
    };
    const timer = setTimeout(() => { void stop({ status: 'missing_tool', diagnostics: [diag('evaluation_timeout', 'MSBuild 求值超过有界预算；自有求值进程树已结束。')] }); }, Math.min(options.evaluationTimeoutMs || 60000, 120000));
    child.stdout.on('data', chunk => {
      if (stopping) return;
      output += chunk;
      if (output.length > (options.maxEvaluationBytes || MAX_DATABASE_BYTES)) void stop({ status: 'unsupported', diagnostics: [diag('evaluation_output_limit', 'MSBuild 求值输出超出限制；自有求值进程树已结束。')] });
    });
    // 不回显工具 stderr，避免环境/项目导入中的敏感文本泄露。
    child.stderr.resume();
    child.on('error', () => finish({ status: 'missing_tool', diagnostics: [diag('evaluation_launch_failed', '无法启动原生 MSBuild 求值进程。')] }));
    child.on('close', code => { if (stopping) return; try { const result = JSON.parse(output.replace(/^\uFEFF/, '').trim()); finish(result); } catch (_) { finish({ status: 'unsupported', diagnostics: [diag('evaluation_failed', `MSBuild 求值未返回有效数据（退出码 ${code}）。`)] }); } });
  });
}

function result(status, values = {}) { return { status, generation: null, databaseDir: null, source: null, configuration: null, platform: null, diagnostics: [], ...values }; }

async function reuseDatabase(root, options, database, directory, diagnostics) {
  if (!database.hasRelativeDirectories) return result('ready', { generation: database.digest, databaseDir: directory, source: 'build', diagnostics });
  const dataRoot = path.resolve(options.pluginDataDir || pluginDataDir(options));
  const relativeData = path.relative(root, dataRoot);
  if (!relativeData.startsWith('..') && !path.isAbsolute(relativeData)) return result('invalid', { diagnostics: [...diagnostics, diag('unsafe_data_directory', '插件私有数据目录不能位于目标工程目录内。')] });
  const projectHome = path.join(dataRoot, 'serena-build', hash(identity(root)).slice(0, 32));
  fs.mkdirSync(projectHome, { recursive: true });
  const release = await acquireLock(path.join(projectHome, 'prepare.lock'), Math.min(options.lockTimeoutMs ?? 5000, 15000));
  if (!release) return result('busy', { diagnostics: [diag('prepare_busy', '项目准备锁在预算内未释放。')] });
  const text = JSON.stringify(database.normalizedCommands, null, 2) + '\n';
  const generation = hash(text).slice(0, 32);
  const destination = path.join(projectHome, generation);
  const staging = path.join(projectHome, `.pending-${crypto.randomUUID()}`);
  try {
    const existing = readDatabase(path.join(destination, 'compile_commands.json'));
    if (!existing.ok || existing.digest !== hash(text)) {
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(staging, 'compile_commands.json'), text);
      if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true });
      fs.renameSync(staging, destination);
    }
    return result('ready', { generation, databaseDir: destination, source: 'build', diagnostics });
  } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); release(); }
}

async function acquireLock(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();
  while (Date.now() <= deadline) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      fs.closeSync(fd);
      return () => { try { if (readJson(file).token === token) fs.unlinkSync(file); } catch (_) {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = readJson(file);
        try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') { fs.unlinkSync(file); continue; } }
      } catch (_) { /* 正在写入/不可识别锁不能抢占。 */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  return null;
}

/**
 * 准备项目语义数据库。root 是真实目标目录；只向插件私有 data 写入。
 * options 支持 pluginDataDir、project/configuration/platformSelection（或 msbuildPlatform）、
 * databaseDir 以及 evaluationTimeoutMs/lockTimeoutMs。platform 仅用于宿主 OS 测试覆盖。
 */
async function prepareSerenaProjectImpl(root, options = {}) {
  let rootPath;
  try { rootPath = canonical(root); if (!fs.statSync(rootPath).isDirectory()) throw new Error(); }
  catch (_) { return result('invalid', { diagnostics: [diag('invalid_root', '目标项目目录不存在或不可访问。')] }); }
  const diagnostics = [];
  const rootDb = path.join(rootPath, 'compile_commands.json');
  if (fs.existsSync(rootDb)) {
    const database = readDatabase(rootDb);
    if (database.ok) return result('ready', { generation: database.digest, databaseDir: rootPath, source: 'root', nativeRootDatabase: true });
    diagnostics.push(diag('invalid_root_database', '根目录 compile_commands.json 无效，保留原文件并尝试其他来源。'));
  }
  const dataRoot = path.resolve(options.pluginDataDir || pluginDataDir(options));
  if (dataRoot === rootPath || !path.relative(rootPath, dataRoot).startsWith('..') && !path.isAbsolute(path.relative(rootPath, dataRoot))) return result('invalid', { diagnostics: [...diagnostics, diag('unsafe_data_directory', '插件私有数据目录不能位于目标工程目录内。')] });
  const { projectHome, configurationPath } = serenaProjectPaths(rootPath, options);
  let privateConfig = {};
  try {
    if (fs.existsSync(configurationPath)) privateConfig = readJson(configurationPath);
    if (!privateConfig || Array.isArray(privateConfig) || typeof privateConfig !== 'object' ||
        ['project', 'configuration', 'platform', 'databaseDir'].some(key => privateConfig[key] !== undefined && typeof privateConfig[key] !== 'string')) throw new Error();
  } catch (_) { return result('invalid', { configurationPath, diagnostics: [...diagnostics, diag('invalid_private_config', '项目私有准备配置不是有效 JSON 或含不支持的字段类型。')] }); }
  const selectedDatabase = options.databaseDir || privateConfig.databaseDir;
  if (selectedDatabase) {
    const directory = path.resolve(rootPath, selectedDatabase);
    const db = readDatabase(path.join(directory, 'compile_commands.json'));
    return db.ok ? reuseDatabase(rootPath, options, db, directory, diagnostics) : result('invalid', { diagnostics: [...diagnostics, diag('invalid_selected_database', '显式选定数据库无效。')] });
  }
  const buildRoot = path.join(rootPath, 'build');
  if (fs.existsSync(buildRoot) && fs.statSync(buildRoot).isDirectory()) {
    const discovery = boundedFiles(buildRoot, name => name === 'compile_commands.json');
    const valid = discovery.files.map(file => ({ file, ...readDatabase(file) })).filter(db => db.ok);
    if (valid.length > 1 || discovery.truncated) return result('ambiguous', { configurationPath, diagnostics: [...diagnostics, diag('ambiguous_build_databases', 'build 下有多个有效数据库或搜索达到边界，请显式选择 databaseDir。')] });
    if (valid.length === 1) return reuseDatabase(rootPath, options, valid[0], path.dirname(valid[0].file), diagnostics);
  }
  const selectedProject = options.project || privateConfig.project;
  const discovery = selectedProject ? { files: [path.resolve(rootPath, selectedProject)] } : boundedFiles(rootPath, name => /\.vcxproj$/i.test(name), 2);
  if (!discovery.files.length) return result('unsupported', { diagnostics: [...diagnostics, diag('no_compile_database', '未找到有效编译数据库或 VC++ MSBuild 项目。')] });
    if (discovery.files.length > 1 || discovery.truncated) return result('ambiguous', { configurationPath, diagnostics: [...diagnostics, diag('ambiguous_msbuild_projects', '多个 VC++ 项目需要在私有配置中显式选择 project，避免同一源文件混用宏。')] });
  const project = discovery.files[0];
  try { const relative = path.relative(rootPath, canonical(project)); if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.vcxproj$/i.test(project)) throw new Error(); }
  catch (_) { return result('invalid', { diagnostics: [...diagnostics, diag('invalid_selected_project', '选定 project 必须是目标目录内已有的 .vcxproj 文件。')] }); }
  const selection = { project, configuration: options.configuration || privateConfig.configuration || '', platform: options.platformSelection || options.msbuildPlatform || privateConfig.platform || '' };
  const selectionKey = hash(JSON.stringify([SCHEMA, selection, options.hostArch || process.arch, fileHash(__filename), fileHash(path.join(__dirname, 'export-msbuild.ps1'))]));
  fs.mkdirSync(projectHome, { recursive: true });
  const release = await acquireLock(path.join(projectHome, 'prepare.lock'), Math.min(options.lockTimeoutMs ?? 5000, 15000));
  if (!release) return result('busy', { diagnostics: [...diagnostics, diag('prepare_busy', '项目准备锁在预算内未释放。')] });
  try {
    const currentFile = path.join(projectHome, 'current.json');
    try {
      const current = readJson(currentFile);
      if (!/^[a-f0-9]{32}$/.test(current.generation)) throw new Error();
      const manifest = readJson(path.join(projectHome, current.generation, 'manifest.json'));
      const databaseDir = path.join(projectHome, current.generation);
      const database = readDatabase(path.join(databaseDir, 'compile_commands.json'));
      const importsValid = manifest.cacheReusable === true && snapshotMatches(manifest.inputs, manifest.importProbes);
      if (manifest.schema === SCHEMA && manifest.selectionKey === selectionKey && importsValid && database.ok && database.digest === manifest.databaseHash &&
          manifest.environmentHash === selectedEnvironment(options.env || process.env, manifest.environmentNames)) return result('ready', { generation: current.generation, databaseDir, source: 'msbuild', configuration: manifest.configuration, platform: manifest.platform, diagnostics: [...diagnostics, ...(manifest.diagnostics || [])] });
    } catch (_) { /* 旧产物无效时必须重新求值，不能声称 fresh。 */ }
    let evaluated;
    for (let attempt = 0; attempt < 2; attempt++) {
      evaluated = await runEvaluation(rootPath, options, selection);
      if (evaluated.status !== 'ready') break;
      if (!Array.isArray(evaluated.inputSnapshot) || !Array.isArray(evaluated.importProbes)) return result('unsupported', { source: 'msbuild', diagnostics: [...diagnostics, diag('missing_evaluation_snapshot', '求值器未提供与参数对应的输入快照；不能发布当前有效数据库。')] });
      const expected = [...new Set([project, ...(evaluated.imports || []), ...(evaluated.toolchainFiles || [])])];
      if (!expected.every(file => evaluated.inputSnapshot.some(input => input.file === file && /^[a-f0-9]{64}$/.test(input.digest)))) return result('unsupported', { source: 'msbuild', diagnostics: [...diagnostics, diag('incomplete_evaluation_snapshot', '求值器的输入快照不覆盖项目、导入和选定工具链。')] });
      if (snapshotMatches(evaluated.inputSnapshot, evaluated.importProbes)) break;
      evaluated = { status: 'invalid', diagnostics: [diag('evaluation_inputs_changed', '求值后项目输入或 import 探测结果发生变化；未发布旧参数。')] };
    }
    if (evaluated.status !== 'ready') return result(evaluated.status || 'unsupported', { source: 'msbuild', diagnostics: [...diagnostics, ...(evaluated.diagnostics || [])] });
    const converted = commandsFromEvaluation(evaluated);
    if (converted.status !== 'ready') return result(converted.status, { source: 'msbuild', configuration: evaluated.configuration, platform: evaluated.platform, diagnostics: [...diagnostics, ...(evaluated.diagnostics || []), ...converted.diagnostics] });
    const inputs = evaluated.inputSnapshot;
    const importProbes = evaluated.importProbes;
    const environmentNames = [...new Set([...ENV_INPUTS, ...(evaluated.environmentNames || [])])];
    const environmentHash = selectedEnvironment(options.env || process.env, environmentNames);
    const generation = hash(JSON.stringify([selectionKey, inputs, importProbes, environmentHash, evaluated.toolchainFingerprint || '', converted.commands])).slice(0, 32);
    const databaseDir = path.join(projectHome, generation);
    const staging = path.join(projectHome, `.pending-${crypto.randomUUID()}`);
    fs.mkdirSync(staging);
    try {
      const databaseText = JSON.stringify(converted.commands, null, 2) + '\n';
      fs.writeFileSync(path.join(staging, 'compile_commands.json'), databaseText);
      const manifest = { schema: SCHEMA, selectionKey, inputs, importProbes, cacheReusable: evaluated.cacheReusable === true, environmentNames, environmentHash, configuration: evaluated.configuration, platform: evaluated.platform,
        databaseHash: hash(databaseText), diagnostics: [...(evaluated.diagnostics || []), ...converted.diagnostics] };
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      if (!snapshotMatches(inputs, importProbes)) return result('invalid', { diagnostics: [...diagnostics, diag('evaluation_inputs_changed', '原子发布前输入或 import 探测结果发生变化；未发布旧参数。')] });
      if (fs.existsSync(databaseDir)) {
        // 同一指纹产物若损坏，只在受锁保护的私有目录内替换。
        const existing = readDatabase(path.join(databaseDir, 'compile_commands.json'));
        if (!existing.ok || existing.digest !== hash(databaseText)) fs.rmSync(databaseDir, { recursive: true });
        else { fs.rmSync(staging, { recursive: true }); }
      }
      if (fs.existsSync(staging)) fs.renameSync(staging, databaseDir);
      const pointer = path.join(projectHome, `.current-${crypto.randomUUID()}.json`);
      fs.writeFileSync(pointer, JSON.stringify({ generation }));
      fs.renameSync(pointer, currentFile);
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); }
    return result('ready', { generation, databaseDir, source: 'msbuild', configuration: evaluated.configuration, platform: evaluated.platform, diagnostics: [...diagnostics, ...(evaluated.diagnostics || []), ...converted.diagnostics] });
  } catch (_) { return result('invalid', { diagnostics: [...diagnostics, diag('preparation_failed', '项目准备失败；旧数据库未被标记为当前有效结果。')] }); }
  finally { release(); }
}

async function prepareSerenaProject(root, options = {}) {
  try { return await prepareSerenaProjectImpl(root, options); }
  catch (_) { return result('invalid', { diagnostics: [diag('preparation_io_failed', '项目准备目录或数据库不可访问；未发布新的当前产物。')] }); }
}

module.exports = { prepareSerenaProject, serenaProjectPaths, commandsFromEvaluation, readDatabase, splitOptions };
