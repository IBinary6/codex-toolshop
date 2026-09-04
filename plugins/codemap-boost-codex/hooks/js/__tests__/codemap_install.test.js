'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MCP_STARTUP_TIMEOUT_SEC } = require('../lib/bootstrap');

const {
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  isLegacyUvxCrgMcpConfig,
  isPluginManagedLegacyCrgMcpConfig,
  isNativeCrgMcpConfig,
  parseMcpJson,
  readBootstrapFailure,
  removeLegacyCrgMcp,
  resolveCodexCommand,
  runCodexMcp,
  startAutoBootstrap,
  startCrgBuild,
  startCrgUpdate,
} = require('../lib/codemap');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const healthyUvx = {
  name: 'code-review-graph',
  enabled: true,
  transport: {
    type: 'stdio',
    command: 'uvx',
    args: ['code-review-graph', 'serve'],
    cwd: null,
  },
};
const managedCommand = process.platform === 'win32'
  ? 'C:\\Users\\tester\\.codex\\plugins\\data\\codemap-boost-codex-codex-toolshop\\crg-runtime\\Scripts\\code-review-graph.exe'
  : '/home/tester/.codex/plugins/data/codemap-boost-codex-codex-toolshop/crg-runtime/bin/code-review-graph';
const healthyManaged = {
  name: 'code-review-graph',
  enabled: true,
  transport: {
    type: 'stdio',
    command: managedCommand,
    args: ['serve'],
    cwd: null,
  },
};

{
  assert.strictEqual(isLegacyUvxCrgMcpConfig(healthyUvx), true, 'old uvx registration is diagnosed');
  assert.strictEqual(isPluginManagedLegacyCrgMcpConfig(healthyUvx), false, 'ownership-ambiguous uvx registration is preserved');
  assert.strictEqual(isPluginManagedLegacyCrgMcpConfig(healthyManaged), true, 'old plugin-managed absolute registration is migrated');
  assert.strictEqual(isPluginManagedLegacyCrgMcpConfig({
    enabled: true,
    transport: {
      type: 'stdio',
      command: process.platform === 'win32' ? 'C:\\tools\\code-review-graph.exe' : '/opt/tools/code-review-graph',
      args: ['serve'],
      cwd: null,
    },
  }), false, 'unrelated user-managed CRG registration is preserved');
}

{
  const native = {
    type: 'stdio',
    command: 'node',
    args: ['scripts/mcp-server.cjs'],
    cwd: '.',
    startup_timeout_sec: MCP_STARTUP_TIMEOUT_SEC,
  };
  assert.strictEqual(isNativeCrgMcpConfig(native, { allowRelativeCwd: true }), true);
  for (const timeout of [100, MCP_STARTUP_TIMEOUT_SEC - 1, MCP_STARTUP_TIMEOUT_SEC + 1]) {
    assert.strictEqual(
      isNativeCrgMcpConfig({ ...native, startup_timeout_sec: timeout }, { allowRelativeCwd: true }),
      false,
      `native MCP rejects unexpected startup timeout ${timeout}`
    );
  }
}

{
  const windowsManaged = {
    enabled: true,
    transport: {
      type: 'stdio',
      command: 'C:\\Users\\tester\\.codex\\plugins\\data\\codemap-boost-codex-codex-toolshop\\crg-runtime\\Scripts\\code-review-graph.exe',
      args: ['serve'],
    },
  };
  const macManaged = {
    enabled: true,
    transport: {
      type: 'stdio',
      command: '/Users/tester/.codex/plugins/data/codemap-boost-codex-codex-toolshop/crg-runtime/bin/code-review-graph',
      args: ['serve'],
    },
  };
  assert.strictEqual(isPluginManagedLegacyCrgMcpConfig(windowsManaged), true, 'Windows private runtime paths are recognized');
  assert.strictEqual(isPluginManagedLegacyCrgMcpConfig(macManaged), true, 'macOS private runtime paths are recognized');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-codex-path-'));
  try {
    const brokenBin = path.join(tmp, 'broken-bin');
    const healthyBin = path.join(tmp, 'healthy %TEMP% bin');
    mkdirp(brokenBin);
    mkdirp(healthyBin);
    const fileName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    const broken = path.join(brokenBin, fileName);
    const healthy = path.join(healthyBin, fileName);
    if (process.platform === 'win32') {
      fs.writeFileSync(broken, '@echo off\r\nexit /b 1\r\n', 'utf8');
      fs.writeFileSync(healthy, '@echo off\r\necho codex-cli test\r\nexit /b 0\r\n', 'utf8');
    } else {
      fs.writeFileSync(broken, '#!/bin/sh\nexit 1\n', 'utf8');
      fs.writeFileSync(healthy, '#!/bin/sh\necho codex-cli test\nexit 0\n', 'utf8');
      fs.chmodSync(broken, 0o755);
      fs.chmodSync(healthy, 0o755);
    }
    const env = {
      ...process.env,
      PATH: `${brokenBin}${path.delimiter}${healthyBin}`,
      PATHEXT: '.CMD',
    };
    assert.strictEqual(resolveCodexCommand({ env, cwd: tmp }), healthy);
    const version = runCodexMcp(['--version'], { codexCommand: healthy, env, cwd: tmp });
    assert.strictEqual(version.status, 0);
    assert.match(version.stdout, /codex-cli test/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const calls = [];
  const result = removeLegacyCrgMcp({
    codexCommand: 'codex',
    spawnSync: (cmd, args) => {
      calls.push([cmd, args]);
      if (args[1] === 'get') return { status: 0, stdout: JSON.stringify(healthyManaged), stderr: '' };
      if (args[1] === 'remove') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    },
  });
  assert.deepStrictEqual(result, { ok: true, changed: true });
  assert.deepStrictEqual(calls, [
    ['codex', ['mcp', 'get', 'code-review-graph', '--json']],
    ['codex', ['mcp', 'remove', 'code-review-graph']],
  ]);
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-background-command-'));
  try {
    const repo = path.join(tmp, 'repo');
    mkdirp(repo);
    const init = require('node:child_process').spawnSync('git', ['init'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });
    assert.strictEqual(init.status, 0, init.stderr);

    const launches = [];
    const options = {
      isCodeMapEnabled: () => true,
      crgCommand: () => managedCommand,
      spawnDetached: (command, args, spawnOptions) => {
        launches.push({ command, args, spawnOptions });
        return require('node:child_process').spawnSync(command, args, {
          cwd: spawnOptions.cwd,
          encoding: 'utf8',
          windowsHide: process.platform === 'win32',
        });
      },
    };
    assert.strictEqual(startCrgBuild(repo, options), true);
    mkdirp(path.join(repo, '.code-review-graph'));
    assert.strictEqual(startCrgUpdate(repo, options), true);
    assert.strictEqual(launches.length, 2);
    assert.strictEqual(launches[0].command, process.execPath);
    assert.ok(launches[0].args[1].includes(JSON.stringify(managedCommand)), 'initial build embeds the managed absolute CRG path');
    assert.strictEqual(launches[1].command, process.execPath);
    assert.ok(launches[1].args[1].includes('refreshCrgUnlocked'), 'background update reuses the managed runtime resolver and refresh logic');
    assert.ok(launches[1].args[1].includes(JSON.stringify(managedCommand)), 'background update embeds the managed absolute CRG path');
    assert.ok(!launches[1].args[1].includes("spawnSync('code-review-graph'"), 'background refresh must not use PATH CRG');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-bootstrap-launch-failed-'));
  const oldPluginData = process.env.PLUGIN_DATA;
  try {
    const repo = path.join(tmp, 'repo');
    const data = path.join(tmp, 'plugin-data');
    mkdirp(repo);
    process.env.PLUGIN_DATA = data;
    const init = require('node:child_process').spawnSync('git', ['init'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });
    assert.strictEqual(init.status, 0, init.stderr);
    assert.strictEqual(startAutoBootstrap(repo, {
      canUseCrg: () => false,
      spawnDetached: () => null,
    }), false);
    const diagnostic = fs.readFileSync(path.join(data, '.codemap-bootstrap-failed'), 'utf8');
    assert.match(diagnostic, /无法启动后台/);
    assert.match(diagnostic, /setup/);
  } finally {
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = oldPluginData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const parsed = parseMcpJson('\u001b[32mINFO mcp config:\u001b[0m ' + JSON.stringify(healthyUvx));
  assert.deepStrictEqual(parsed, healthyUvx, 'MCP JSON parser accepts ANSI and prefixed output');
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-bootstrap-diagnostic-'));
  const oldPluginData = process.env.PLUGIN_DATA;
  try {
    process.env.PLUGIN_DATA = tmp;
    fs.writeFileSync(path.join(tmp, '.codemap-bootstrap-failed'), '1', 'utf8');
    fs.writeFileSync(path.join(tmp, '.crg-install-failed'), 'uv 和 pip 安装均失败\n', 'utf8');
    assert.strictEqual(
      readBootstrapFailure(),
      'uv 和 pip 安装均失败',
      'SessionStart surfaces the dependency installer diagnostic instead of a legacy marker'
    );
  } finally {
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = oldPluginData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-clean-hooks-'));
  try {
    const home = path.join(tmp, 'codex-home');
    const hooksPath = path.join(home, 'hooks.json');
    writeJson(hooksPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: "cat >/dev/null || true; code-review-graph status || true",
              },
            ],
          },
          {
            hooks: [
              {
                type: 'command',
                command: 'node keep-session.js',
              },
              {
                type: 'command',
                command: 'code-review-graph status || true',
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: 'Write',
            hooks: [
              {
                type: 'command',
                command: 'node keep-me.js',
              },
            ],
          },
          {
            matcher: 'Write|Edit|Bash',
            hooks: [
              {
                type: 'command',
                command: 'echo keep-user && code-review-graph update --skip-flows || true',
              },
            ],
          },
        ],
      },
    });

    assert.strictEqual(cleanLegacyCrgHooks(home), true);
    const cleaned = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.strictEqual(cleaned.hooks.SessionStart.length, 1, 'mixed SessionStart group is preserved');
    assert.strictEqual(cleaned.hooks.SessionStart[0].hooks.length, 1, 'only legacy command is removed from mixed group');
    assert.strictEqual(cleaned.hooks.SessionStart[0].hooks[0].command, 'node keep-session.js');
    assert.strictEqual(cleaned.hooks.PostToolUse.length, 2, 'unrelated and mixed user hooks are preserved');
    assert.strictEqual(cleaned.hooks.PostToolUse[0].hooks[0].command, 'node keep-me.js');
    assert.strictEqual(cleaned.hooks.PostToolUse[1].hooks[0].command, 'echo keep-user && code-review-graph update --skip-flows || true');
    assert.strictEqual(cleanLegacyCrgHooks(home), false, 'cleanup is idempotent');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-clean-git-hook-'));
  try {
    const repo = path.join(tmp, 'repo');
    mkdirp(repo);
    const init = require('node:child_process').spawnSync('git', ['init'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });
    assert.strictEqual(init.status, 0, init.stderr);

    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, [
      '#!/bin/sh',
      '# Installed by code-review-graph. Remove this file to disable pre-commit graph checks.',
      'code-review-graph update || true',
      '',
    ].join('\n'), 'utf8');
    assert.strictEqual(cleanLegacyCrgGitHook(repo), true);
    assert.ok(!fs.existsSync(hook), 'legacy code-review-graph git hook is removed');

    fs.writeFileSync(hook, [
      '#!/bin/sh',
      '# Installed by code-review-graph. Remove this file to disable pre-commit graph checks.',
      'code-review-graph update || true',
      'echo keep-me',
      '',
    ].join('\n'), 'utf8');
    assert.strictEqual(cleanLegacyCrgGitHook(repo), true);
    assert.ok(fs.existsSync(hook), 'mixed user git hook is preserved');
    assert.strictEqual(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\necho keep-me\n');

    fs.writeFileSync(hook, [
      '#!/bin/sh',
      '# Installed by code-review-graph. Remove this file to disable pre-commit graph checks.',
      'code-review-graph update || true && echo keep-me',
      '',
    ].join('\n'), 'utf8');
    assert.strictEqual(cleanLegacyCrgGitHook(repo), true);
    assert.ok(fs.existsSync(hook), 'same-line mixed user git hook is preserved');
    assert.strictEqual(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\ncode-review-graph update || true && echo keep-me\n');

    fs.writeFileSync(hook, [
      '#!/bin/sh',
      '# user hook',
      'echo keep-me',
      '',
    ].join('\n'), 'utf8');
    assert.strictEqual(cleanLegacyCrgGitHook(repo), false);
    assert.ok(fs.existsSync(hook), 'unrelated user git hook is preserved');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-clean-linked-worktree-hook-'));
  try {
    const repo = path.join(tmp, 'repo');
    const linked = path.join(tmp, 'linked worktree');
    mkdirp(repo);
    const init = require('node:child_process').spawnSync('git', ['init'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });
    assert.strictEqual(init.status, 0, init.stderr);
    const commit = require('node:child_process').spawnSync('git', [
      '-c', 'user.name=CodeMap Test',
      '-c', 'user.email=codemap@example.invalid',
      'commit', '--allow-empty', '-m', 'initial',
    ], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });
    assert.strictEqual(commit.status, 0, commit.stderr);
    const add = require('node:child_process').spawnSync('git', ['worktree', 'add', '-b', 'linked-test', linked], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });
    assert.strictEqual(add.status, 0, add.stderr);

    const resolved = require('node:child_process').spawnSync('git', ['rev-parse', '--git-path', 'hooks/pre-commit'], {
      cwd: linked,
      encoding: 'utf8',
      windowsHide: process.platform === 'win32',
    });
    assert.strictEqual(resolved.status, 0, resolved.stderr);
    const hook = path.isAbsolute(resolved.stdout.trim())
      ? resolved.stdout.trim()
      : path.resolve(linked, resolved.stdout.trim());
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, [
      '#!/bin/sh',
      '# Installed by code-review-graph. Remove this file to disable pre-commit graph checks.',
      'code-review-graph update || true',
      '',
    ].join('\n'), 'utf8');

    assert.strictEqual(cleanLegacyCrgGitHook(linked), true, 'linked worktree resolves the shared Git hooks path');
    assert.ok(!fs.existsSync(hook), 'legacy hook is removed through git rev-parse --git-path');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('codemap_install.test.js PASS');
