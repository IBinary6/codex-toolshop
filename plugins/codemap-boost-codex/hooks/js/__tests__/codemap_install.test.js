'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  ensureCrgMcp,
  isCrgMcpConfigHealthy,
  parseMcpJson,
  readBootstrapFailure,
  registerCrgMcp,
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

{
  const parsed = parseMcpJson('\u001b[32mINFO mcp config:\u001b[0m ' + JSON.stringify(healthyUvx));
  assert.deepStrictEqual(parsed, healthyUvx, 'MCP JSON parser accepts ANSI and prefixed output');
  assert.strictEqual(isCrgMcpConfigHealthy(parsed, { command: 'uvx', args: ['code-review-graph', 'serve'] }), true);
}

function exerciseRepair(config, options = {}) {
  const calls = [];
  let getCalls = 0;
  const result = ensureCrgMcp({
    spawnSync: (cmd, args) => {
      calls.push([cmd, args]);
      if (args[1] === 'get') {
        getCalls += 1;
        if (getCalls > 1) {
          const expected = options.uvxAvailable === false
            ? { ...healthyUvx, transport: { ...healthyUvx.transport, command: 'code-review-graph', args: ['serve'] } }
            : healthyUvx;
          return options.finalGetResult || { status: 0, stdout: JSON.stringify(expected) };
        }
        return options.getResult || { status: 0, stdout: JSON.stringify(config) };
      }
      if (args[1] === 'remove') return options.removeResult || { status: 0, stdout: '' };
      if (args[1] === 'add') return options.addResult || { status: 0, stdout: '' };
      return { status: 1, stdout: '', error: new Error('unexpected command') };
    },
    canUseCrg: () => true,
    uvxProbe: () => options.uvxAvailable !== false,
    markerPath: options.markerPath,
  });
  return { calls, result };
}

{
  const flat = {
    enabled: true,
    transport: 'stdio',
    command: 'uvx',
    args: ['code-review-graph', 'serve'],
    cwd: null,
  };
  assert.strictEqual(isCrgMcpConfigHealthy(flat, { command: 'uvx', args: ['code-review-graph', 'serve'] }), true);
}

{
  const healthy = exerciseRepair(healthyUvx);
  assert.strictEqual(healthy.result.ok, true, 'healthy MCP config is accepted');
  assert.deepStrictEqual(healthy.calls, [['codex', ['mcp', 'get', 'code-review-graph', '--json']]], 'healthy config is not rewritten');
}

for (const config of [
  null,
  { ...healthyUvx, enabled: false },
  { ...healthyUvx, transport: { ...healthyUvx.transport, cwd: 'D:\\old-repo' } },
  { ...healthyUvx, transport: { ...healthyUvx.transport, command: 'python', args: ['-m', 'code_review_graph'] } },
]) {
  const repaired = exerciseRepair(config);
  assert.strictEqual(repaired.result.ok, true, 'invalid MCP config is repaired');
  assert.deepStrictEqual(repaired.calls[1], ['codex', ['mcp', 'remove', 'code-review-graph']]);
  assert.deepStrictEqual(repaired.calls[2], ['codex', ['mcp', 'add', 'code-review-graph', '--', 'uvx', 'code-review-graph', 'serve']]);
}

{
  const fallback = exerciseRepair(null, { uvxAvailable: false });
  assert.strictEqual(fallback.result.ok, true, 'MCP repair falls back when uvx is unavailable');
  assert.deepStrictEqual(fallback.calls[2], ['codex', ['mcp', 'add', 'code-review-graph', '--', 'code-review-graph', 'serve']]);
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-register-failed-'));
  const marker = path.join(tmp, '.crg-codex-register-failed');
  try {
    const failed = exerciseRepair(null, {
      markerPath: marker,
      addResult: { status: 1, stdout: 'unable to write mcp config', error: new Error('add failed') },
    });
    assert.strictEqual(failed.result.ok, false, 'failed MCP repair is reported');
    assert.ok(fs.existsSync(marker), 'failed MCP repair writes a marker');
    assert.match(failed.result.diagnostic, /codex mcp add/);
    assert.match(failed.result.diagnostic, /新开|new task/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-register-crg-'));
  const oldPluginData = process.env.PLUGIN_DATA;
  try {
    const data = path.join(tmp, 'data');
    mkdirp(data);

    process.env.PLUGIN_DATA = data;

    const calls = [];
    assert.strictEqual(registerCrgMcp({
      canUseCrg: () => true,
      uvxProbe: () => true,
      spawnSync: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { status: 0, stdout: JSON.stringify(healthyUvx), stderr: '' };
      },
    }), true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, 'codex');
    assert.deepStrictEqual(calls[0].args, ['mcp', 'get', 'code-review-graph', '--json']);
    assert.strictEqual(calls[0].options.stdio[1], 'pipe');
  } finally {
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = oldPluginData;
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

console.log('codemap_install.test.js PASS');
