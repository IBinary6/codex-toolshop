'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cleanCrgMcpConfig,
  cleanLegacyCrgGitHook,
  cleanLegacyCrgHooks,
  registerCrgMcp,
} = require('../lib/codemap');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
                command: 'cat >/dev/null || true; code-review-graph update --skip-flows || true',
              },
            ],
          },
        ],
      },
    });

    assert.strictEqual(cleanLegacyCrgHooks(home), true);
    const cleaned = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(!cleaned.hooks.SessionStart, 'legacy SessionStart CRG hook is removed');
    assert.strictEqual(cleaned.hooks.PostToolUse.length, 1, 'unrelated user hook is preserved');
    assert.strictEqual(cleaned.hooks.PostToolUse[0].hooks[0].command, 'node keep-me.js');
    assert.strictEqual(cleanLegacyCrgHooks(home), false, 'cleanup is idempotent');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-clean-mcp-'));
  try {
    const home = path.join(tmp, 'codex-home');
    const config = path.join(home, 'config.toml');
    mkdirp(home);
    fs.writeFileSync(config, [
      '[mcp_servers.deepwiki-cross-platform]',
      'type = "stdio"',
      'command = "npx"',
      'args = ["-y", "mcp-deepwiki@latest"]',
      '',
      '[mcp_servers.code-review-graph]',
      'type = "stdio"',
      'command = "uvx"',
      'args = ["code-review-graph", "serve"]',
      '',
      '[notice]',
      'hide_full_access_warning = true',
      '',
    ].join('\n'), 'utf8');

    assert.strictEqual(cleanCrgMcpConfig(home), true);
    const cleaned = fs.readFileSync(config, 'utf8');
    assert.ok(cleaned.includes('[mcp_servers.deepwiki-cross-platform]'), 'unrelated MCP config is preserved');
    assert.ok(!cleaned.includes('[mcp_servers.code-review-graph]'), 'code-review-graph MCP config is removed');
    assert.ok(cleaned.includes('[notice]'), 'following config sections are preserved');
    assert.strictEqual(cleanCrgMcpConfig(home), false, 'MCP cleanup is idempotent');
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

    let call = null;
    assert.strictEqual(registerCrgMcp({
      canUseCrg: () => true,
      spawnSync: (cmd, args, options) => {
        call = { cmd, args, options };
        return { status: 0 };
      },
    }), true);
    assert.strictEqual(call.cmd, 'code-review-graph');
    const args = call.args;
    assert.deepStrictEqual(args, [
      'install',
      '--platform',
      'codex',
      '--no-hooks',
      '--no-instructions',
      '--no-skills',
      '--yes',
    ]);
    assert.strictEqual(call.options.stdio, 'ignore');
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
