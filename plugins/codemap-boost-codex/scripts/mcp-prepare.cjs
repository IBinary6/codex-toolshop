'use strict';

// Run the synchronous installer in a separate process so the stdio frontend can handle ping, cancellation, and progress.
const { prepareMcpServer } = require('./mcp-server.cjs');
const { enterMcpDataDir } = require('./mcp-cwd.cjs');

if (require.main === module) {
  try {
    const options = JSON.parse(process.argv[2] || '{}');
    const prepared = prepareMcpServer(enterMcpDataDir(options));
    process.stdout.write(`${JSON.stringify(prepared)}\n`);
    process.exitCode = prepared.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, diagnostic: error.message })}\n`);
    process.exitCode = 1;
  }
}
