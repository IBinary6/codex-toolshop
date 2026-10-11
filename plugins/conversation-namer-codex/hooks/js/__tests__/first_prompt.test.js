'use strict';

const assert = require('assert').strict;
const { delegationPrompt, firstPrompt } = require('../lib/first_prompt');

const envelope = {
  type: 'functionCallOutput', name: 'create_thread', namespace: 'codex_app',
  output: '<codex_delegation>\n  <source_thread_id>parent-task</source_thread_id>\n  <input>\u89e3\u91ca C++ RAII \u7684\u4f5c\u7528</input>\n</codex_delegation>',
};
const message = { type: 'userMessage', content: [{ type: 'text', text: '\u7b2c\u4e00\u6761\u95ee\u9898' }] };
assert.equal(delegationPrompt(envelope), '\u89e3\u91ca C++ RAII \u7684\u4f5c\u7528');
assert.equal(firstPrompt({ turns: [{ items: [envelope, { type: 'agentMessage', text: '\u8fdb\u5ea6' }] }] }), '\u89e3\u91ca C++ RAII \u7684\u4f5c\u7528');
assert.equal(firstPrompt({ turns: [{ items: [message, envelope] }] }), '\u7b2c\u4e00\u6761\u95ee\u9898');
assert.equal(firstPrompt({ turns: [{ items: [{ type: 'userMessage', content: [] }, envelope] }] }), '');
assert.equal(firstPrompt({ turns: [{ items: [{ type: 'reasoning' }, message] }] }), '\u7b2c\u4e00\u6761\u95ee\u9898');
assert.equal(firstPrompt({ turns: [{ items: [] }, { items: [message] }] }), null, 'Do not substitute a second-turn follow-up for the first message');
assert.equal(firstPrompt({ preview: '\u6807\u9898\u4e0d\u662f\u539f\u59cb\u8bf7\u6c42', turns: [] }), null);
assert.equal(firstPrompt({}), null);
assert.equal(firstPrompt({ turns: [{ items: [{ type: 'userMessage', content: [{ type: 'image', url: 'image' }] }] }] }), '');
assert.equal(firstPrompt({ turns: [{ items: [{ type: 'userMessage', content: [
  { type: 'text', text: '\u7b2c\u4e00\u6bb5' }, { type: 'image', url: 'image' }, { type: 'text', text: '\u7b2c\u4e8c\u6bb5' },
] }] }] }), '\u7b2c\u4e00\u6bb5\n\u7b2c\u4e8c\u6bb5');
for (const patch of [
  { namespace: 'other' }, { name: 'send_message_to_thread' }, { type: 'agentMessage' },
  { output: '<input>\u4f2a\u9020\u8bf7\u6c42</input>' }, { output: 42 },
  { output: envelope.output.replace('parent-task', '../bad') },
  { output: `\u524d\u7f00${envelope.output}` },
]) {
  assert.equal(delegationPrompt({ ...envelope, ...patch }), null);
}
// XML, newlines, and shell characters inside the envelope are data; do not decode entities or evaluate commands.
const literal = '\u4fdd\u7559 <input>\u4f8b\u5b50</input> &amp; $(echo value)\n\u4e0b\u4e00\u884c';
assert.equal(delegationPrompt({ ...envelope, output: envelope.output.replace('\u89e3\u91ca C++ RAII \u7684\u4f5c\u7528', literal) }), literal);
