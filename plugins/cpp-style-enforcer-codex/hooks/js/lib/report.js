'use strict';

const MAX_CHANGED_FILES_SHOWN = 10;

/**
 * Bound the automatically rewritten file list so Stop reports do not fill model context.
 * @param {string[]} filePaths
 * @returns {string}
 */
function formatChangedFiles(filePaths) {
  const shown = filePaths.slice(0, MAX_CHANGED_FILES_SHOWN);
  let output = shown.map((filePath) => `  - ${filePath}`).join('\n');
  const remaining = filePaths.length - shown.length;
  if (remaining > 0) {
    output += `\n  ... ${remaining} more files not shown`;
  }
  return output;
}

module.exports = { formatChangedFiles, MAX_CHANGED_FILES_SHOWN };
