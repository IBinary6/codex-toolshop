'use strict';

const { readStdinJson } = require('./lib/stdin');
const { passSilent, addContext, diag, hookFailure } = require('./lib/protocol');
const { resolveFilePaths, shouldHandle } = require('./lib/target');
const { readPendingPaths, clearPendingFiles } = require('./lib/pending_edits');
const { checkEditedFiles } = require('./lib/check_edits');
const { formatViolations } = require('./steps/cpplint');

const CHECK_BUDGET_MS = 22000;

async function main() {
  const input = await readStdinJson({ strict: true });
  const result = input.tool_response || input.tool_output || {};
  if (input.is_error === true || input.isError === true || result.is_error === true
      || result.isError === true || result.success === false
      || (Number.isInteger(result.exit_code) && result.exit_code !== 0)) return passSilent();

  const filePaths = new Set(resolveFilePaths(input).filter(shouldHandle));
  const deadline = Date.now() + CHECK_BUDGET_MS;
  const violations = [];
  let legacy;
  try {
    legacy = readPendingPaths(input);
    for (const filePath of legacy.paths) if (shouldHandle(filePath)) filePaths.add(filePath);
  } catch (error) {
    violations.push({ line: 0, category: 'runtime/pending_edits', message: 'Could not read legacy edit records. ' + error.message });
  }
  violations.push(...checkEditedFiles(filePaths, { cwd: input.cwd, deadline }));
  if (legacy && !violations.some(({ category }) => category.startsWith('runtime/'))) {
    try { clearPendingFiles(legacy.files); }
    catch (error) {
      violations.push({ line: 0, category: 'runtime/pending_edits', message: 'Could not clear legacy edit records. ' + error.message });
    }
  }
  if (!violations.length) return passSilent();
  const details = formatViolations(violations);
  if (violations.some(({ category }) => category.startsWith('runtime/'))) diag(details);
  return addContext('PostToolUse', details);
}

main().catch((error) => hookFailure('PostToolUse', error));
