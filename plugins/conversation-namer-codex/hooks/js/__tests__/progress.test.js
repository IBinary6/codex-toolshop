'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deliverAtStop, deliverAfterTool } = require('../desktop_delivery');
const { armSession, readState, writeState } = require('../lib/state');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'namer-progress-'));
const env = { ...process.env, PLUGIN_DATA: temporary };
delete env.CONVERSATION_NAMER_WORKER;
const subject = '1107｜Chrome 启动页恢复';
const update = (stage, focus = null) => ({ focus, stage });

function conversation(id, { source = 'vscode', managed = true } = {}) {
  armSession({ source: 'startup', session_id: id }, env);
  writeState(id, { status: 'done', title: subject, firstTurnId: 'first',
    ...(managed ? { baseTitle: subject } : {}) }, env);
  const task = { title: subject, generations: 0, writes: 0, opens: 0, closes: 0 };
  task.stop = (turnId, classify, { active = false, latest = turnId, response = '实现已提交，回归待跑。' } = {}) => {
    return deliverAtStop({ session_id: id, turn_id: turnId, stop_hook_active: active,
      last_assistant_message: response }, { env, clientFactory(settings) {
      assert.equal(settings.timeoutMs, 12000);
      task.opens += 1;
      return {
        async readThreadName() { return { originalTitle: task.title, source }; },
        async readLatestTurn() { return { id: latest, items: [{
          type: 'userMessage', content: [{ type: 'text', text: '继续' }],
        }] }; },
        async classifyProgress(evidence) {
          task.generations += 1;
          assert.equal(evidence.subject, subject);
          assert.equal(evidence.request, '继续');
          assert.equal(evidence.response, response);
          return classify(evidence);
        },
        async writeThreadName(_, title) { task.writes += 1; task.title = title; },
        async close() { task.closes += 1; },
      };
    } });
  };
  task.ack = (request, turnId, { failed = false } = {}) => {
    const args = JSON.parse(request.reason.split('\n')[2]);
    assert.equal(args.threadId, id);
    if (!failed) task.title = args.title;
    assert.equal(deliverAfterTool({ session_id: id, turn_id: turnId,
      tool_name: 'mcp__codex_app__set_thread_title', tool_input: args,
      tool_response: { ...args, isError: failed },
    }, { env }), null);
  };
  return task;
}

async function main() {
  const desktop = conversation('desktop');
  const unused = () => assert.fail('unexpected classification');
  assert.equal(await desktop.stop('first', unused), null);
  assert.equal(await desktop.stop('continuation', unused, { active: true }), null);
  assert.equal(await desktop.stop('no-response', unused, { response: null }), null);
  assert.equal(desktop.opens, 0);
  assert.equal(await desktop.stop('stale', unused, { latest: 'newer' }), null);
  assert.equal(desktop.generations, 0);

  const results = await Promise.all([
    desktop.stop('fix', () => update('verify', '启动页删除回归')),
    desktop.stop('fix', () => update('verify', '启动页删除回归')),
  ]);
  const request = results.find(Boolean);
  assert.ok(request);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(desktop.generations, 1);
  assert.equal(desktop.writes, 0);
  assert.equal(readState('desktop', env).title, subject);
  desktop.ack(request, 'fix', { failed: true });
  assert.equal(readState('desktop', env).progressStage, undefined);
  desktop.ack(request, 'wrong-turn');
  assert.equal(readState('desktop', env).title, subject);
  desktop.ack(request, 'fix');
  assert.equal(readState('desktop', env).title, `${subject} - 启动页删除回归 · 待验证`);
  assert.equal(readState('desktop', env).progressFocus, '启动页删除回归');
  assert.equal(readState('desktop', env).pendingProgress, undefined);
  assert.equal(await desktop.stop('fix', unused), null);
  assert.equal(await desktop.stop('repeat', ({ previousStage, previousFocus }) => update(previousStage, previousFocus)), null);
  assert.equal(await desktop.stop('unrelated', () => update('keep')), null);
  desktop.ack(await desktop.stop('test', () => update('review')), 'test');
  assert.equal(readState('desktop', env).title, `${subject} - 启动页删除回归 · 待验收`);
  desktop.ack(await desktop.stop('accepted', () => update('done')), 'accepted');
  assert.equal(readState('desktop', env).title, `${subject} - 启动页删除回归 · 已完成`);
  desktop.ack(await desktop.stop('new-focus', () => update('keep', 'Edge 策略兼容性')), 'new-focus');
  assert.equal(readState('desktop', env).title, `${subject} - Edge 策略兼容性`);
  assert.equal(readState('desktop', env).progressStage, undefined);
  desktop.ack(await desktop.stop('return-to-subject', () => update('working', '')), 'return-to-subject');
  assert.equal(readState('desktop', env).title, `${subject} - 处理中`);
  assert.equal(readState('desktop', env).baseTitle, subject);
  assert.equal(desktop.opens, desktop.closes);

  const manual = conversation('manual');
  manual.title = '我手动改的名字';
  assert.equal(await manual.stop('manual-rename', unused), null);
  assert.equal(manual.generations, 0);
  const changedDuring = conversation('changed-during');
  assert.equal(await changedDuring.stop('manual-during-inference', () => {
    changedDuring.title = '我手动改的名字';
    return update('verify', '恢复回归');
  }), null);
  assert.equal(readState('changed-during', env).pendingProgress, undefined);

  const locked = conversation('user-title', { managed: false });
  assert.equal(await locked.stop('later', unused), null);
  assert.equal(locked.opens, 0);
  const optOut = conversation('opt-out');
  assert.equal(await optOut.stop('disable', () => update('disable')), null);
  assert.equal(readState('opt-out', env).progressDisabled, true);
  assert.equal(await optOut.stop('later', unused), null);

  const cli = conversation('cli', { source: 'cli' });
  assert.equal(await cli.stop('cli-error', () => { throw new Error('app_server_timeout'); }), null);
  assert.equal(cli.writes, 0);
  assert.equal(await cli.stop('cli-blocked', () => update('blocked')), null);
  assert.equal(cli.writes, 1);
  assert.equal(cli.title, `${subject} - 受阻`);
  assert.equal(readState('cli', env).title, cli.title);
  assert.equal(cli.opens, cli.closes);

  const previousVersion = conversation('previous-version');
  previousVersion.title = `${subject}｜待验收`;
  writeState('previous-version', { ...readState('previous-version', env), title: previousVersion.title,
    progressStage: 'review' }, env);
  assert.equal(await previousVersion.stop('same-stage', () => update('keep')), null);
  previousVersion.ack(await previousVersion.stop('deliver', () => update('done')), 'deliver');
  assert.equal(previousVersion.title, `${subject} - 已完成`);
}

main().finally(() => fs.rmSync(temporary, { recursive: true, force: true }))
  .catch((error) => { console.error(error); process.exitCode = 1; });
