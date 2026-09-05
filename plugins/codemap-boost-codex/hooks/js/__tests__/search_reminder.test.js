'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const reminder = require('../lib/search_reminder');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-reminder-'));
  const previous = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = dir;
  const input = { session_id: 'private-session', turn_id: 'turn-1', cwd: '/private/repo' };
  const candidate = (command) => reminder.looksLikeCodeSearch({ tool_name: 'Bash', tool_input: { command } });
  try {
    for (const command of ['rg Auth src', 'cd src && rg Auth .', 'command rg Auth src', '"/tools/rg" Auth src', 'grep -R Auth src', 'findstr /s Auth *.cpp', 'pwd\nrg Auth src', '# Search implementation\nrg Auth src', 'rg --files src\nrg Auth src', 'rg "settings.json"', 'rg -F "settings.json"', 'rg Auth src README.md']) {
      assert.equal(candidate(command), true, command);
    }
    for (const command of ['rg --files src', 'rg --help', 'rg title README.md', 'rg timeout config.toml', 'rg ERROR app.log', "echo 'rg Auth src; rg Foo src'", 'echo ready\\; rg Auth src', 'echo ready # comment; rg Auth src', 'node --check src/a.js', 'cat src/a.cc']) {
      assert.equal(candidate(command), false, command);
    }
    assert.equal(candidate('rg Auth a.cpp README.md'), true);
    assert.equal(reminder.looksLikeCodeSearch({ tool_name: 'mcp__x', tool_input: { command: 'rg Auth src' } }), false);
    assert.equal(reminder.claimSearchReminder(input), true);
    assert.equal(reminder.claimSearchReminder(input), false);
    reminder.resetSearchReminder(input);
    assert.equal(reminder.claimSearchReminder(input), true, 'same-turn user input resets the reminder');
    assert.equal(reminder.claimSearchReminder({ ...input, session_id: 'other' }), true);
    assert.equal(reminder.claimSearchReminder({ ...input, turn_id: 'turn-2' }), true);
    assert.equal(reminder.claimSearchReminder({ ...input, agent_id: 'child' }), true);
    assert.equal(reminder.claimSearchReminder({}), true);
    assert.equal(reminder.claimSearchReminder({}), true, 'missing IDs must not share suppression');

    reminder.resetSearchReminder(input);
    const modulePath = require.resolve('../lib/search_reminder');
    const code = 'const r = require(process.argv[1]); process.stdout.write(String(r.claimSearchReminder(JSON.parse(process.argv[2]))));';
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code, modulePath, JSON.stringify(input)], { env: process.env });
      let stdout = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.on('error', reject);
      child.on('close', (exit) => exit === 0 ? resolve(stdout) : reject(new Error(`child exit ${exit}`)));
    })));
    assert.equal(results.filter((result) => result === 'true').length, 1, 'parallel searches claim once');
    for (const entry of fs.readdirSync(path.join(dir, 'search-reminders'))) {
      assert.match(entry, /^[a-f0-9]{64}$/);
      assert.equal(fs.readFileSync(path.join(dir, 'search-reminders', entry), 'utf8'), '');
    }
    process.env.PLUGIN_DATA = path.join(dir, 'unwritable');
    fs.writeFileSync(process.env.PLUGIN_DATA, 'file instead of directory');
    assert.equal(reminder.claimSearchReminder(input), true, 'storage failure still allows a soft reminder');
    console.log('search reminder tests passed');
  } finally {
    if (previous === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
