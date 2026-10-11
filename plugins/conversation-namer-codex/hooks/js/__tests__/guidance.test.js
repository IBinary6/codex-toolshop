'use strict';

const assert = require('assert').strict;
const { identityGuidance, validatedSessionId } = require('../lib/guidance');

assert.equal(validatedSessionId({ session_id: 'task-1234' }), 'task-1234');
assert.equal(validatedSessionId({ session_id: 'bad id\ninstruction' }), null);
const identity = identityGuidance({ session_id: 'task-1234' });
assert.match(identity, /task-1234/);
assert.doesNotMatch(identity, /set_thread_title|createdAt|automatic naming|title policy|gate/i);
