'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { prepareSerenaProject, serenaProjectPaths, commandsFromEvaluation } = require('../../../scripts/serena-project.cjs');
const { killProcessTree } = require('../../../scripts/lazy-mcp.cjs');

async function waitForTreeFixture(pidFile, parent) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, ''));
      if (Number.isInteger(pids.parent) && pids.parent > 0 && Number.isInteger(pids.child) && pids.child > 0) return pids;
    } catch (error) {
      // The fixture publishes the file atomically (write, then rename), so only "not there yet" is expected.
      if (error.code !== 'ENOENT') throw error;
    }
    if (parent.spawnError) throw parent.spawnError;
    if (parent.exitCode != null || parent.signalCode != null) throw new Error('PowerShell tree fixture exited before ready');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('PowerShell tree fixture did not become ready within 30 seconds');
}

async function main() {
  // Temporary directories may use Windows short paths or a macOS /var symlink; derive expectations from the production real-path contract.
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'serena-project-')));
  const root = path.join(temp, 'project');
  const data = path.join(temp, 'private');
  fs.mkdirSync(root);
  const source = path.join(root, 'main.cpp');
  fs.writeFileSync(source, 'int main() {}');
  const native = [{ directory: root, file: source, arguments: ['clang++', '-c', source] }];
  const options = { pluginDataDir: data, platform: 'win32' };
  try {
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(native));
    const original = fs.readFileSync(path.join(root, 'compile_commands.json'));
    let result = await prepareSerenaProject(root, options);
    assert.equal(result.status, 'ready');
    assert.equal(result.source, 'root');
    assert.equal(result.nativeRootDatabase, true);
    assert.deepEqual(fs.readFileSync(path.join(root, 'compile_commands.json')), original);
    const alias = path.join(temp, 'project-alias');
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const aliased = await prepareSerenaProject(alias, options);
      assert.equal(aliased.status, 'ready');
      assert.equal(aliased.databaseDir, root, 'alias input resolves to the canonical root database');
      assert.equal(serenaProjectPaths(alias, options).projectHome, serenaProjectPaths(root, options).projectHome,
        'different paths to the same project share its private preparation identity');
      assert.deepEqual(fs.readFileSync(path.join(alias, 'compile_commands.json')), original);
    } finally { fs.unlinkSync(alias); }
    fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([{ directory: '.', file: 'main.cpp', arguments: ['clang++', '-c', 'main.cpp'] }]));
    result = await prepareSerenaProject(root, options);
    assert.equal(result.status, 'ready');
    assert.equal(result.nativeRootDatabase, true);
    fs.writeFileSync(path.join(root, 'compile_commands.json'), '[]');
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'build', 'compile_commands.json'), JSON.stringify(native));
    result = await prepareSerenaProject(root, options);
    assert.equal(result.source, 'build');
    assert.ok(result.diagnostics.some(d => d.code === 'invalid_root_database'));
    const relativeBuild = JSON.stringify([{ directory: '..', file: 'main.cpp', arguments: ['clang++', '-c', 'main.cpp'] }]);
    fs.writeFileSync(path.join(root, 'build', 'compile_commands.json'), relativeBuild);
    result = await prepareSerenaProject(root, options);
    assert.equal(result.status, 'ready');
    assert.ok(result.databaseDir.startsWith(data));
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.databaseDir, 'compile_commands.json')))[0].directory, root);
    assert.equal(fs.readFileSync(path.join(root, 'build', 'compile_commands.json'), 'utf8'), relativeBuild);
    fs.mkdirSync(path.join(root, 'build', 'other'));
    fs.writeFileSync(path.join(root, 'build', 'other', 'compile_commands.json'), JSON.stringify(native));
    result = await prepareSerenaProject(root, options);
    assert.equal(result.status, 'ambiguous');
    const paths = serenaProjectPaths(root, options);
    fs.mkdirSync(paths.projectHome, { recursive: true });
    fs.writeFileSync(paths.configurationPath, JSON.stringify({ databaseDir: 'build' }));
    result = await prepareSerenaProject(root, options);
    assert.equal(result.status, 'ready', 'private explicit database selection precedes ambiguous automatic scan');
    fs.unlinkSync(paths.configurationPath);
    fs.rmSync(path.join(root, 'build'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app.vcxproj'), '<Project/>');
    fs.writeFileSync(path.join(root, 'settings.props'), '<Project/>');
    const includeDirectory = path.join(temp, 'include');
    fs.mkdirSync(includeDirectory);
    fs.writeFileSync(path.join(includeDirectory, 'pre.h'), '#pragma once');
    let calls = 0;
    const inputSnapshot = files => files.map(file => ({ file, digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
    const evaluate = () => {
      calls++;
      return { status: 'ready', project: path.join(root, 'app.vcxproj'), configuration: 'Release', platform: 'x64',
        cl: 'C:/VS/cl.exe', msvcVersion: '19.16', includePath: includeDirectory, imports: [path.join(root, 'settings.props')],
        inputSnapshot: inputSnapshot([path.join(root, 'app.vcxproj'), path.join(root, 'settings.props')]), importProbes: [], cacheReusable: true,
        sources: [{ FullPath: source, PreprocessorDefinitions: 'APP=1;UNICODE', AdditionalIncludeDirectories: includeDirectory,
          LanguageStandard: 'stdcpp17', ForcedIncludeFiles: 'pre.h', ExcludedFromBuild: 'false' }] };
    };
    const injected = { ...options, evaluateMsbuild: evaluate };
    result = await prepareSerenaProject(root, injected);
    assert.equal(result.status, 'ready');
    assert.equal(result.source, 'msbuild');
    const database = JSON.parse(fs.readFileSync(path.join(result.databaseDir, 'compile_commands.json')));
    assert.ok(database[0].arguments.includes('/DAPP=1'));
    assert.ok(database[0].arguments.includes('/std:c++17'));
    assert.ok(database[0].arguments.includes('/clang:--target=x86_64-pc-windows-msvc'));
    const generation = result.generation;
    fs.writeFileSync(source, 'int main() { return 1; }');
    result = await prepareSerenaProject(root, injected);
    assert.equal(result.generation, generation);
    assert.equal(calls, 1, 'ordinary source edits must not rerun MSBuild evaluation');
    fs.writeFileSync(path.join(root, 'settings.props'), '<Project><!-- changed --></Project>');
    result = await prepareSerenaProject(root, injected);
    assert.equal(calls, 2);
    assert.notEqual(result.generation, generation);
    fs.writeFileSync(path.join(root, 'settings.props'), '<Project><!-- concurrent --></Project>');
    const concurrent = await Promise.all([prepareSerenaProject(root, injected), prepareSerenaProject(root, injected)]);
    assert.equal(calls, 3, 'concurrent preparation must evaluate once under the bounded lock');
    assert.equal(concurrent[0].generation, concurrent[1].generation);
    result = concurrent[0];
    fs.writeFileSync(path.join(result.databaseDir, 'compile_commands.json'), 'broken');
    result = await prepareSerenaProject(root, injected);
    assert.equal(calls, 4, 'corrupt generated database must not be reused as fresh');
    const clean = JSON.parse(fs.readFileSync(path.join(result.databaseDir, 'compile_commands.json')));
    clean[0].arguments.push('/DWRONG_VALID_PARAMETER=1');
    fs.writeFileSync(path.join(result.databaseDir, 'compile_commands.json'), JSON.stringify(clean));
    result = await prepareSerenaProject(root, injected);
    assert.equal(calls, 5, 'well-formed but changed generated parameters must be repaired');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(result.databaseDir, 'compile_commands.json')))[0].arguments.includes('/DWRONG_VALID_PARAMETER=1'));
    result = await prepareSerenaProject(root, { ...injected, env: { ...process.env, LUDASHI_PC_PUBLIC_ROOT: path.join(temp, 'changed-root') } });
    assert.equal(calls, 6, 'selected environment changes must invalidate evaluated cache');
    fs.writeFileSync(path.join(paths.projectHome, 'prepare.lock'), JSON.stringify({ pid: process.pid, token: 'occupied' }));
    result = await prepareSerenaProject(root, { ...injected, lockTimeoutMs: 10 });
    assert.equal(result.status, 'busy');
    fs.unlinkSync(path.join(paths.projectHome, 'prepare.lock'));
    const optional = path.join(root, 'optional.props');
    const parts = path.join(root, 'parts');
    fs.mkdirSync(parts);
    let probeCalls = 0;
    const evaluateProbes = () => {
      probeCalls++;
      const base = evaluate();
      const partFiles = fs.readdirSync(parts).filter(file => file.endsWith('.props')).map(file => path.join(parts, file)).sort();
      base.imports = [...base.imports, ...partFiles, ...(fs.existsSync(optional) ? [optional] : [])];
      base.sources[0].PreprocessorDefinitions = `OPTIONAL=${fs.existsSync(optional) ? 1 : 0};PARTS=${partFiles.length}`;
      base.inputSnapshot = inputSnapshot([base.project, ...base.imports]);
      base.importProbes = [{ kind: 'path', pattern: optional, state: [fs.existsSync(optional) ? 'file' : 'missing'] },
        { kind: 'glob', pattern: path.join(parts, '*.props'), state: partFiles.map(file => process.platform === 'win32' ? file.replace(/\\/g, '/').toLowerCase() : file.replace(/\\/g, '/')) }];
      return base;
    };
    const probeOptions = { ...options, evaluateMsbuild: evaluateProbes, configuration: 'Probe' };
    result = await prepareSerenaProject(root, probeOptions);
    const noOptionalGeneration = result.generation;
    fs.writeFileSync(optional, '<Project/>');
    result = await prepareSerenaProject(root, probeOptions);
    assert.equal(probeCalls, 2, 'previously missing optional import must invalidate cache when it appears');
    assert.notEqual(result.generation, noOptionalGeneration);
    fs.unlinkSync(optional);
    result = await prepareSerenaProject(root, probeOptions);
    assert.equal(probeCalls, 3, 'optional import removal must invalidate cache');
    fs.writeFileSync(path.join(parts, 'new.props'), '<Project/>');
    result = await prepareSerenaProject(root, probeOptions);
    assert.equal(probeCalls, 4, 'wildcard import membership changes must invalidate cache');
    let itemCalls = 0;
    const itemOptions = { ...options, configuration: 'ItemGlob', evaluateMsbuild() {
      itemCalls++;
      const base = evaluate();
      const files = fs.readdirSync(root).filter(file => file.endsWith('.cpp')).map(file => path.join(root, file)).sort();
      base.sources = files.map(file => ({ FullPath: file }));
      base.importProbes = [{ kind: 'glob', pattern: path.join(root, '*.cpp'), state: files.map(file => process.platform === 'win32' ? file.replace(/\\/g, '/').toLowerCase() : file.replace(/\\/g, '/')) }];
      return base;
    } };
    result = await prepareSerenaProject(root, itemOptions);
    fs.appendFileSync(source, '\n// ordinary edit');
    await prepareSerenaProject(root, itemOptions);
    assert.equal(itemCalls, 1, 'editing an existing glob member must preserve the cached TU set');
    fs.writeFileSync(path.join(root, 'b.cpp'), 'int b;');
    result = await prepareSerenaProject(root, itemOptions);
    assert.equal(itemCalls, 2, 'new ClCompile glob member must invalidate the TU set');
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.databaseDir, 'compile_commands.json'))).length, 2);
    fs.unlinkSync(path.join(root, 'b.cpp'));
    await prepareSerenaProject(root, itemOptions);
    assert.equal(itemCalls, 3, 'removed ClCompile glob member must invalidate the TU set');
    let dynamicCalls = 0;
    const dynamicOptions = { ...options, configuration: 'DynamicExpression', evaluateMsbuild() {
      dynamicCalls++;
      return { ...evaluate(), cacheReusable: false, environmentNames: ['IMPORT_DIR'], diagnostics: [{ code: 'dynamic_import_revalidation', message: 'unknown instance property function' }] };
    } };
    await prepareSerenaProject(root, dynamicOptions);
    await prepareSerenaProject(root, dynamicOptions);
    assert.equal(dynamicCalls, 2, 'unknown property functions must force evaluation on each query');
    const drifting = { ...options, configuration: 'Drift', evaluateMsbuild() {
      const evaluated = evaluate();
      fs.appendFileSync(path.join(root, 'settings.props'), '<!-- drift after evaluation -->');
      return evaluated;
    } };
    result = await prepareSerenaProject(root, drifting);
    assert.notEqual(result.status, 'ready', 'cannot label post-evaluation hashes as the snapshot corresponding to older arguments');
    assert.ok(result.diagnostics.some(d => d.code === 'evaluation_inputs_changed'));
    result = await prepareSerenaProject(root, { ...options, configuration: 'MissingSnapshot', evaluateMsbuild() { const evaluated = evaluate(); delete evaluated.inputSnapshot; return evaluated; } });
    assert.notEqual(result.status, 'ready', 'an evaluator without an input snapshot must not publish a fresh database');
    fs.writeFileSync(path.join(root, 'second.vcxproj'), '<Project/>');
    result = await prepareSerenaProject(root, injected);
    assert.equal(result.status, 'ambiguous');
    const conversion = commandsFromEvaluation({ ...evaluate(), sources: [
      { FullPath: source, ExcludedFromBuild: 'true' },
      { FullPath: source, AdditionalOptions: '/unknownCriticalFlag' }
    ] });
    assert.equal(conversion.status, 'unsupported');
    assert.ok(conversion.diagnostics.some(d => d.code === 'unsupported_compile_option'));
    const defaultRuntime = commandsFromEvaluation({ ...evaluate(), sources: [{ FullPath: source, RuntimeLibrary: 'MultiThreadedDll' }] });
    assert.equal(defaultRuntime.status, 'ready');
    assert.ok(defaultRuntime.commands[0].arguments.includes('/MD'));
    const missingInclude = commandsFromEvaluation({ ...evaluate(), includePath: path.join(temp, 'missing-include') });
    assert.equal(missingInclude.status, 'unsupported');
    assert.ok(missingInclude.diagnostics.some(d => d.code === 'missing_include_directory'));
    const split = commandsFromEvaluation({ ...evaluate(), sources: [{ FullPath: source, AdditionalOptions: '/I "first" /I "second" /D A /D B' }] });
    assert.deepEqual(split.commands[0].arguments.slice(-10, -2), ['/I', 'first', '/I', 'second', '/D', 'A', '/D', 'B']);
    const precedence = commandsFromEvaluation({ ...evaluate(), clOptions: '/DSOURCE=CL /D CL_SEPARATE', trailingClOptions: '/DSOURCE=TAIL',
      sources: [{ FullPath: source, PreprocessorDefinitions: 'SOURCE=PROJECT', AdditionalOptions: '/DADDITIONAL=1' }] });
    assert.deepEqual(precedence.commands[0].arguments.filter(arg => arg.startsWith('/DSOURCE=')), ['/DSOURCE=CL', '/DSOURCE=PROJECT', '/DSOURCE=TAIL']);
    const noTail = commandsFromEvaluation({ ...evaluate(), clOptions: '/DSOURCE=CL', sources: [{ FullPath: source, PreprocessorDefinitions: 'SOURCE=PROJECT' }] });
    assert.deepEqual(noTail.commands[0].arguments.filter(arg => arg.startsWith('/DSOURCE=')), ['/DSOURCE=CL', '/DSOURCE=PROJECT']);
    if (process.platform === 'win32') {
      if (process.argv.includes('--native-msbuild-temp')) {
        // Explicit native regression entry point: do not build; verify that GetTempPath implicit environment dependencies cannot be cached as a pure function.
        const nativeRoot = path.join(temp, 'native-temp-project');
        fs.mkdirSync(nativeRoot);
        fs.writeFileSync(path.join(nativeRoot, 'main.cpp'), 'int native_temp;');
        fs.writeFileSync(path.join(nativeRoot, 'native.vcxproj'), '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><ItemGroup Label="ProjectConfigurations"><ProjectConfiguration Include="Release|x64"><Configuration>Release</Configuration><Platform>x64</Platform></ProjectConfiguration></ItemGroup><PropertyGroup Label="Globals"><WindowsTargetPlatformVersion>8.1</WindowsTargetPlatformVersion></PropertyGroup><Import Project="$(VCTargetsPath)Microsoft.Cpp.Default.props"/><PropertyGroup Label="Configuration"><ConfigurationType>StaticLibrary</ConfigurationType><PlatformToolset>v141</PlatformToolset><UseDebugLibraries>false</UseDebugLibraries></PropertyGroup><Import Project="$(VCTargetsPath)Microsoft.Cpp.props"/><ItemDefinitionGroup><ClCompile><AdditionalIncludeDirectories>$([System.IO.Path]::GetTempPath())</AdditionalIncludeDirectories></ClCompile></ItemDefinitionGroup><ItemGroup><ClCompile Include="main.cpp"/></ItemGroup><Import Project="$(VCTargetsPath)Microsoft.Cpp.targets"/></Project>');
        const nativeEvidence = [];
        for (const choice of ['a', 'b']) {
          const selectedTemp = path.join(temp, `native-temp-${choice}`);
          fs.mkdirSync(selectedTemp);
          const prepared = await prepareSerenaProject(nativeRoot, { pluginDataDir: data, env: { ...process.env, TMP: selectedTemp, TEMP: selectedTemp } });
          assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
          assert.ok(prepared.diagnostics.some(d => d.code === 'dynamic_import_revalidation'));
          const manifest = JSON.parse(fs.readFileSync(path.join(prepared.databaseDir, 'manifest.json')));
          const commands = JSON.parse(fs.readFileSync(path.join(prepared.databaseDir, 'compile_commands.json')));
          assert.equal(manifest.cacheReusable, false, 'GetTempPath cannot be treated as pure');
          assert.ok(commands[0].arguments.some(arg => arg.startsWith('/I') && path.resolve(arg.slice(2)) === selectedTemp), 'MSBuild must evaluate the selected native temporary include directory');
          nativeEvidence.push({ choice, generation: prepared.generation, cacheReusable: false, includeMatches: true, diagnostic: 'dynamic_import_revalidation' });
        }
        assert.notEqual(nativeEvidence[0].generation, nativeEvidence[1].generation);
        const nativeProject = path.join(nativeRoot, 'native.vcxproj');
        fs.writeFileSync(nativeProject, fs.readFileSync(nativeProject, 'utf8').replace('<AdditionalIncludeDirectories>$([System.IO.Path]::GetTempPath())</AdditionalIncludeDirectories>', ''));
        const standard = await prepareSerenaProject(nativeRoot, { pluginDataDir: data });
        assert.equal(standard.status, 'ready', JSON.stringify(standard));
        assert.equal(JSON.parse(fs.readFileSync(path.join(standard.databaseDir, 'manifest.json'))).cacheReusable, true, 'Target-only ClCompile dependencies must not contaminate the evaluation input closure');
        fs.appendFileSync(path.join(nativeRoot, 'main.cpp'), '\n// ordinary edit');
        const cachedStandard = await prepareSerenaProject(nativeRoot, { pluginDataDir: data });
        assert.equal(cachedStandard.generation, standard.generation);
        console.log(`native GetTempPath validation ${JSON.stringify(nativeEvidence)}`);
      }
      // A native PowerShell parent creates a separate PowerShell child so Node job cleanup cannot hide a leaked process tree.
      const treeEvidence = [];
      for (const mode of ['timeout', 'output']) {
        const pidFile = path.join(temp, `tree-${mode}.json`);
        const childCode = Buffer.from('Start-Sleep -Seconds 120', 'utf16le').toString('base64');
        const parentCode = `$child=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${childCode}');@{parent=$PID;child=$child.Id}|ConvertTo-Json -Compress|Set-Content -LiteralPath '${pidFile.replace(/'/g, "''")}.tmp' -Encoding UTF8;Move-Item -LiteralPath '${pidFile.replace(/'/g, "''")}.tmp' -Destination '${pidFile.replace(/'/g, "''")}' -Force;$go=[Console]::ReadLine();if($go -ne 'GO'){exit 3};${mode === 'output' ? "[Console]::WriteLine(('x'*100000))" : ''};Start-Sleep -Seconds 120`;
        const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const parent = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parentCode, 'utf16le').toString('base64')],
          { cwd: root, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        parent.once('error', error => { parent.spawnError = error; });
        parent.stdin.on('error', () => {});
        try {
          const pids = await waitForTreeFixture(pidFile, parent);
          result = await prepareSerenaProject(root, { ...options, project: 'app.vcxproj', configuration: `Tree-${mode}`,
            evaluationTimeoutMs: 3500, maxEvaluationBytes: mode === 'output' ? 1024 : undefined,
            spawn(executable) {
              assert.equal(executable, powershell);
              // Release the ready fixture only after the evaluator listener is installed so output mode cannot lose the first data batch.
              setImmediate(() => parent.stdin.end('GO\n'));
              return parent;
            } });
          assert.ok(result.diagnostics.some(d => d.code === (mode === 'output' ? 'evaluation_output_limit' : 'evaluation_timeout')), JSON.stringify(result));
          for (const pid of Object.values(pids)) { assert.throws(() => process.kill(pid, 0), `owned PS process ${pid} remains alive after ${mode}`); }
          treeEvidence.push({ mode, parent: pids.parent, child: pids.child, rootExited: true, childExited: true });
        } finally {
          // Own and clean only this run’s live ChildProcess; never taskkill a saved PID again.
          if (Number.isInteger(parent.pid)) await killProcessTree(parent);
        }
      }
      console.log(`owned PowerShell tree cleanup ${JSON.stringify(treeEvidence)}`);
    }
    console.log('serena_project PASS');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
