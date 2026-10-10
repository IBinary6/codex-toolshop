'use strict';

const { readStdinJson, passSilent } = require('./lib/runtime');

async function main() {
  await readStdinJson({ timeoutMs: 2000 });
  // 编辑和 worktree 创建不启动图进程，也不清除已验证 provenance。
  // 实际读取前的源码、运行时和数据库指纹会决定是否需要刷新。
  return passSilent();
}

if (require.main === module) main().catch(() => passSilent());

module.exports = { main };
