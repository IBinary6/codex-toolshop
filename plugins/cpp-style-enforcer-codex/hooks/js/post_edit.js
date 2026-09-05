'use strict';

const { readStdinJson } = require('./lib/stdin');
const { passSilent, diag } = require('./lib/protocol');
const { resolveFilePaths, shouldHandle } = require('./lib/target');
const { recordPendingPaths } = require('./lib/pending_edits');

async function main() {
  const input = await readStdinJson({ timeoutMs: 5000 });
  if (!input) return passSilent();
  const result = input.tool_response || input.tool_output || {};
  if (input.is_error === true || input.isError === true || result.is_error === true
      || result.isError === true || result.success === false
      || (Number.isInteger(result.exit_code) && result.exit_code !== 0)) return passSilent();

  const filePaths = resolveFilePaths(input).filter(shouldHandle);
  recordPendingPaths(input, filePaths);
  return passSilent();
}

main().catch((e) => {
  try { diag(`post_edit 记录异常兜底 passSilent: ${e && e.message ? e.message : e}`); } catch (_) {}
  passSilent();
});
