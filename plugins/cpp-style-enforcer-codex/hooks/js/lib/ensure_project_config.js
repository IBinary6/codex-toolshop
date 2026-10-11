'use strict';

const fs = require('fs');
const path = require('path');
const { userTemplatePath, DEFAULT_CONFIG, PROJECT_CONFIG_DIRS } = require('./config.js');

const README_CONTENT = `cpp-style-enforcer project configuration
========================================
Configuration: .codex-cpp-style/cpp-style.json (also reads legacy .claude-cpp-style/cpp-style.json)
Global template: ~/.codex/cpp-style-template.json (inherited by all projects without an override)

-----------------------------------------------------------
Fields
-----------------------------------------------------------

enabled (boolean, default true)
  Enable the plugin. Set false to temporarily disable all checks without deleting configuration.
  Example: "enabled": false

mode (string, default "incremental")
  Controls handling of new and existing files.
  "incremental" - new (untracked) files use all checks; tracked files use only legacyChecks.
  "full"        - all files use checks, ignoring legacyChecks; tracked files still retain their BOM state.
  Example: "mode": "full"

checks (object)
  Switches for new (untracked) files or mode=full.
  checks.clangFormat (boolean, default true) - Format the whole file with clang-format.
  checks.copyright   (boolean, default true) - Insert/update the copyright header when copyrightInfo.company is set.
  checks.cpplint     (boolean, default true) - Run cpplint; violations block the current Codex operation.
  checks.bom         (boolean, default true) - Add a UTF-8 BOM to new files; tracked files retain their state.
  Example: "checks": { "cpplint": false }

legacyChecks (object)
  Switches for tracked files in incremental mode; all are disabled by default.
  legacyChecks.clangFormat (boolean, default false) - Format changed lines in tracked files.
  legacyChecks.copyright   (boolean, default false) - Insert/update the copyright header.
  legacyChecks.cpplint     (boolean, default false) - Run cpplint.
  legacyChecks.bom         (boolean, default false) - Kept for compatibility; tracked files always retain their BOM state.
  Example: "legacyChecks": { "copyright": true, "bom": false }

lineEnding (string, default "preserve")
  Edited C/C++ files in Visual Studio source projects use CRLF, even after accidental LF conversion.
  Other projects accept "lf", "crlf", or "preserve". Preserve chooses the dominant body ending, the first on a tie, or LF when none exists.
  Nonempty files missing a final newline receive one of the selected style, independently of clang-format and legacyChecks.
  A nearer CMakeLists.txt takes precedence over higher VS markers; generated CMake VS files do not count as native VS projects.
  A directory with both build entries is treated as CMake; set "lineEnding": "crlf" explicitly if needed.
  Only current-turn edited files are repaired. Encoding and BOM are retained; Git staging is untouched. enabled=false disables all processing.

copyrightInfo (object)
  Content of the copyright header. No header is generated with an empty company.
  copyrightInfo.company    (string, default "") - Company or organization for the copyright line.
    Format: // Copyright YYYY <company>
    Example: "company": "The Master Lu PC-Group Authors. All rights reserved."
  copyrightInfo.author     (string, default "") - Author name or email; may be empty.
    Format: // Author <author>
    Example: "author": "pc_zhangxinqi@ludashi.com"
  copyrightInfo.dateFormat (string, default "YYYY/MM/DD HH:mm")
    Supports YYYY (year), MM (month), DD (day), HH (hour), and mm (minute).
    The default year/month/day hour:minute format usually needs no change.
    Example: "dateFormat": "YYYY/MM/DD"

-----------------------------------------------------------
Copyright header format
-----------------------------------------------------------
The generated header has up to four lines:
  // Copyright YYYY <company>
  // Author <author>         (omitted when author is empty)
  // Date YYYY/MM/DD HH:mm
  // src/path/to/file.cc     (path relative to project root)

A header dated today is written only once.

-----------------------------------------------------------
Common scenarios
-----------------------------------------------------------

1. Existing project: do not apply high-level formatting to tracked files; apply all checks to new files. Basic line-ending rules still apply (default).
  {
    "mode": "incremental",
    "legacyChecks": { "clangFormat": false, "copyright": false, "cpplint": false, "bom": false }
  }

2. Existing project: apply all checks to every file, including tracked files.
  {
    "mode": "full"
  }

3. Existing project: add copyright to tracked files without cpplint or clang-format.
  {
    "mode": "incremental",
    "legacyChecks": { "clangFormat": false, "copyright": true, "cpplint": false, "bom": false }
  }

4. New project: disable cpplint until the project meets the rules.
  {
    "checks": { "cpplint": false }
  }

5. Temporarily disable the plugin.
  {
    "enabled": false
  }

-----------------------------------------------------------
Changing the global template
-----------------------------------------------------------
Global template: ~/.codex/cpp-style-template.json (Windows: C:\\Users\\<username>\\.codex\\cpp-style-template.json)
Projects without an override inherit changes to the global template.
Fields in an existing project cpp-style.json take precedence over the global template.
`;

/**
 * When the full workflow applies and project cpp-style.json is missing, copy the global template into the project root.
 * Also generate README.txt explaining fields; do not overwrite an existing file.
 *
 * - Do not generate when root is null (outside Git), since there is no reliable project root.
 * - Never overwrite an existing root/.codex-cpp-style or legacy root/.claude-cpp-style configuration.
 * - Content comes from the global template; use the hard-coded default schema if missing or invalid.
 * - Write UTF-8 without BOM using LF; catch failures without crashing.
 *
 * @param {string|null} root Git repository root
 * @param {string} [templatePath] Global template path (default ~/.codex/cpp-style-template.json)
 */
function ensureProjectConfig(root, templatePath = userTemplatePath()) {
  if (!root) return;
  try {
    for (const name of PROJECT_CONFIG_DIRS) {
      if (fs.existsSync(path.join(root, name, 'cpp-style.json'))) return;
    }
    const dir = path.join(root, '.codex-cpp-style');
    const target = path.join(dir, 'cpp-style.json');
    const readme = path.join(dir, 'README.txt');

    fs.mkdirSync(dir, { recursive: true });

    // Do not overwrite existing JSON configuration.
    if (!fs.existsSync(target)) {
      let content = null;
      try {
        if (templatePath && fs.existsSync(templatePath)) {
          const raw = fs.readFileSync(templatePath, 'utf-8');
          JSON.parse(raw); // Validate JSON, falling back to defaults if invalid.
          content = raw;
        }
      } catch (_) {
        content = null;
      }
      if (content === null) {
        content = JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n';
      }
      fs.writeFileSync(target, Buffer.from(content, 'utf-8'));
    }

    // Do not overwrite an existing README.txt.
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, Buffer.from(README_CONTENT, 'utf-8'));
    }
  } catch (_) {
    // Generation failure does not affect the main flow.
  }
}

module.exports = { ensureProjectConfig };
