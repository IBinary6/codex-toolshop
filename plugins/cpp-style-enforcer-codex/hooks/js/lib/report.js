'use strict';

const MAX_CHANGED_FILES_SHOWN = 10;

/**
 * 限制自动改写文件列表长度，避免 Stop 报告无界占用模型上下文。
 * @param {string[]} filePaths
 * @returns {string}
 */
function formatChangedFiles(filePaths) {
  const shown = filePaths.slice(0, MAX_CHANGED_FILES_SHOWN);
  let output = shown.map((filePath) => `  - ${filePath}`).join('\n');
  const remaining = filePaths.length - shown.length;
  if (remaining > 0) {
    output += `\n  ... 还有 ${remaining} 个文件未显示`;
  }
  return output;
}

module.exports = { formatChangedFiles, MAX_CHANGED_FILES_SHOWN };
