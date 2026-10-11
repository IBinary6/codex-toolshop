'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const hooks = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'hooks.json'), 'utf8'));

// Codex may compile matchers as regular expressions, so a bare "*" would fail to parse.
for (const [event, groups] of Object.entries(hooks.hooks)) {
  for (const group of groups) {
    if (group.matcher !== undefined) {
      assert.doesNotThrow(() => new RegExp(group.matcher), `${event} matcher ${group.matcher} must be a valid regular expression`);
    }
  }
}
assert.equal(hooks.hooks.SubagentStart[0].matcher, '.*', 'SubagentStart matches every agent type');
