'use strict';

const path = require('path');
const { ensureUserTemplate } = require('./lib/config');
const { readStdinJson } = require('./lib/stdin');
const { repoRoot } = require('./lib/git');
const { isCppProjectDir } = require('./lib/project');
const { ensureProjectConfig } = require('./lib/ensure_project_config');

// 插件出厂默认模板绝对路径（hooks/js → 插件根 → templates/）
const PLUGIN_DEFAULT_TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'cpp-style-template.default.json');

try {
  ensureUserTemplate(PLUGIN_DEFAULT_TEMPLATE);
} catch (_) {
  // 复制失败（权限等）→ 静默吞掉，调用方按无全局模板降级硬编码默认
}

/**
 * SessionStart 提前生成 .codex-cpp-style：cwd 为 C++ git 项目时提前写一份本地配置，
 * 进入会话即有配置，不必等编辑第一个文件。post_edit 仍保留按被编辑文件兜底
 * （覆盖 终端≠目标目录 / SessionStart 没覆盖到 的场景）。
 *
 * 盲区：SessionStart 只有会话 cwd，无被编辑文件路径。仅当 cwd 落在 git 仓库根
 * 且确为 C++ 项目时才生成；非 git / 非 C++ / 任意失败 → 不做、不输出、不影响 exit 0。
 *
 * @param {object} input SessionStart hook stdin JSON（可能含 cwd）
 */
function seedProjectConfig(input) {
  try {
    // 取会话 cwd：stdin.cwd > process.cwd()
    const cwd = (input && typeof input.cwd === 'string' && input.cwd)
      || process.cwd();
    const root = repoRoot(cwd); // 非 git → null
    if (!root) return;
    if (!isCppProjectDir(root)) return; // 保守：非 C++ 项目不生成
    ensureProjectConfig(root); // 已存在不覆盖、失败 try/catch 不崩
  } catch (_) {
    // 任意失败 → 静默，不破坏 exit 0 / 静默契约
  }
}

// 读 stdin 拿 cwd（失败/超时 → {}），再尝试提前生成，全程静默 exit 0。
readStdinJson({ timeoutMs: 2000 })
  .then((input) => {
    seedProjectConfig(input || {});
  })
  .catch(() => {})
  .finally(() => {
    // 完全静默：无 stdout / stderr 输出
    process.exit(0);
  });
