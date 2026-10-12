'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

// Every hook entry exports main(input) and does nothing when it is only required.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dispatch-entry-'));
process.env.PLUGIN_DATA = path.join(root, 'data');
const written = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
try {
  const hooks = ['session_start', 'user_prompt_submit', 'pre_tool_use', 'subagent_start']
    .map((name) => [name, require(path.join(__dirname, '..', `${name}.js`))]);
  assert.deepEqual(written, [], 'requiring a hook produces no output');
  assert.ok(!fs.existsSync(process.env.PLUGIN_DATA), 'requiring a hook writes no state');
  for (const [name, hook] of hooks) assert.equal(typeof hook.main, 'function', `${name} exports main`);

  // main takes the parsed input directly, so a hook can be exercised without stdin.
  const subagent = hooks.find(([name]) => name === 'subagent_start')[1];
  subagent.main({ cwd: root });
  assert.match(written.join(''), /SubagentStart/, 'main(input) emits the hook output');
} finally {
  process.stdout.write = realWrite;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('entry_contract.test.js PASS');
