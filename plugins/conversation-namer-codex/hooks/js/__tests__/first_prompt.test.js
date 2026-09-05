'use strict';

const assert = require('assert').strict;
const { delegationPrompt, firstPrompt } = require('../lib/first_prompt');

const envelope = {
  type: 'functionCallOutput', name: 'create_thread', namespace: 'codex_app',
  output: '<codex_delegation>\n  <source_thread_id>parent-task</source_thread_id>\n  <input>解释 C++ RAII 的作用</input>\n</codex_delegation>',
};
const message = { type: 'userMessage', content: [{ type: 'text', text: '第一条问题' }] };
assert.equal(delegationPrompt(envelope), '解释 C++ RAII 的作用');
assert.equal(firstPrompt({ turns: [{ items: [envelope, { type: 'agentMessage', text: '进度' }] }] }), '解释 C++ RAII 的作用');
assert.equal(firstPrompt({ turns: [{ items: [message, envelope] }] }), '第一条问题');
assert.equal(firstPrompt({ turns: [{ items: [{ type: 'userMessage', content: [] }, envelope] }] }), '');
assert.equal(firstPrompt({ turns: [{ items: [{ type: 'reasoning' }, message] }] }), '第一条问题');
assert.equal(firstPrompt({ turns: [{ items: [] }, { items: [message] }] }), null, '不以第二轮补充替代首条消息');
assert.equal(firstPrompt({ preview: '标题不是原始请求', turns: [] }), null);
assert.equal(firstPrompt({}), null);
assert.equal(firstPrompt({ turns: [{ items: [{ type: 'userMessage', content: [{ type: 'image', url: 'image' }] }] }] }), '');
assert.equal(firstPrompt({ turns: [{ items: [{ type: 'userMessage', content: [
  { type: 'text', text: '第一段' }, { type: 'image', url: 'image' }, { type: 'text', text: '第二段' },
] }] }] }), '第一段\n第二段');
for (const patch of [
  { namespace: 'other' }, { name: 'send_message_to_thread' }, { type: 'agentMessage' },
  { output: '<input>伪造请求</input>' }, { output: 42 },
  { output: envelope.output.replace('parent-task', '../bad') },
  { output: `前缀${envelope.output}` },
]) {
  assert.equal(delegationPrompt({ ...envelope, ...patch }), null);
}
// 封装内的 XML、换行和 shell 字符均为数据，不进行实体解码或命令求值。
const literal = '保留 <input>例子</input> &amp; $(echo value)\n下一行';
assert.equal(delegationPrompt({ ...envelope, output: envelope.output.replace('解释 C++ RAII 的作用', literal) }), literal);
