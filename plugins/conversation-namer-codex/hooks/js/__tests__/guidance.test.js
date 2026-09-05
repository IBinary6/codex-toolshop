'use strict';

const assert = require('assert').strict;
const path = require('path');
const { identityGuidance, loadTitlePolicy, validatedSessionId } = require('../lib/guidance');

const pluginRoot = path.resolve(__dirname, '..', '..', '..');
assert.equal(validatedSessionId({ session_id: 'task-1234' }), 'task-1234');
assert.equal(validatedSessionId({ session_id: 'bad id\ninstruction' }), null);
const identity = identityGuidance({ session_id: 'task-1234' });
assert.match(identity, /task-1234/);
assert.doesNotMatch(identity, /set_thread_title|createdAt|automatic naming|title policy|gate/i);
const policy = loadTitlePolicy(pluginRoot);
assert.match(policy, /createdAt/);
assert.match(policy, /Asia\/Shanghai/);
assert.match(policy, /FEA/);
assert.match(policy, /研究/);
