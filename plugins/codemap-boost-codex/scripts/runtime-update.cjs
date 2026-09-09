'use strict';

const {
  adoptedUpdateLock,
  runRuntimeUpdates,
  runtimeUpdateDoctor,
  updatesDisabled,
} = require('../hooks/js/lib/runtime-updates');

function parseArgs(argv) {
  const args = { background: false, checkNow: false, doctor: false, lockToken: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--background') args.background = true;
    else if (value === '--check-now') args.checkNow = true;
    else if (value === '--doctor') args.doctor = true;
    else if (value === '--lock-token') args.lockToken = argv[++index] || '';
    else throw new Error(`未知参数：${value}`);
  }
  if (args.doctor && (args.background || args.checkNow || args.lockToken)) throw new Error('--doctor 必须保持只读');
  if (args.background && !args.lockToken) throw new Error('--background 仅供内部调度使用');
  return args;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const write = dependencies.write || ((text) => process.stdout.write(text));
  const isDisabled = dependencies.updatesDisabled || updatesDisabled;
  const doctor = dependencies.runtimeUpdateDoctor || runtimeUpdateDoctor;
  const run = dependencies.runRuntimeUpdates || runRuntimeUpdates;
  const adopt = dependencies.adoptedUpdateLock || adoptedUpdateLock;
  if (args.doctor) {
    write(`${JSON.stringify(doctor())}\n`);
    return 0;
  }
  if (isDisabled()) {
    if (!args.background) write(`${JSON.stringify({ status: 'disabled', reason: 'CODEMAP_BOOST_DISABLE_RUNTIME_UPDATES=1' })}\n`);
    return 0;
  }
  const lock = args.lockToken ? adopt(args.lockToken) : null;
  if (args.lockToken && !lock) throw new Error('后台更新锁已失效或不属于当前调度');
  const result = await run({ force: args.checkNow, lock });
  if (!args.background) write(`${JSON.stringify(result)}\n`);
  return result.status === 'ok' || result.status === 'busy' ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`[codemap-boost-codex] runtime update failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
