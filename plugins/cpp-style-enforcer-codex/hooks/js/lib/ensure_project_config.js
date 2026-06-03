'use strict';

const fs = require('fs');
const path = require('path');
const { userTemplatePath, DEFAULT_CONFIG } = require('./config.js');

const README_CONTENT = `cpp-style-enforcer 项目配置说明
================================
配置文件：.claude-cpp-style/cpp-style.json
全局模板：~/.claude/cpp-style-template.json（所有项目的继承基础，修改此文件对所有项目生效）

-----------------------------------------------------------
字段说明
-----------------------------------------------------------

enabled (boolean, 默认 true)
  是否启用插件。设为 false 可临时关闭所有检查，不删除配置文件。
  示例：关闭插件 → "enabled": false

mode (string, 默认 "incremental")
  控制新老文件的处理策略。
  "incremental" — 新文件（git 未追踪）走 checks 全套；老文件（git 已追踪）只走 legacyChecks。
  "full"        — 所有文件均走 checks 全套，忽略 legacyChecks。
  示例：强制所有文件全套 → "mode": "full"

checks (object)
  新文件（git 未追踪）或 mode=full 时生效的检查开关。
  checks.clangFormat (boolean, 默认 true)  — 是否用 clang-format 格式化整个文件。
  checks.copyright   (boolean, 默认 true)  — 是否插入/更新版权头（需 copyrightInfo.company 非空）。
  checks.cpplint     (boolean, 默认 true)  — 是否运行 cpplint 风格检查；违规会阻塞 Claude。
  checks.bom         (boolean, 默认 true)  — 是否确保文件有 UTF-8 BOM。
  示例：新文件跳过 cpplint → "checks": { "cpplint": false }

legacyChecks (object)
  老文件（git 已追踪，mode=incremental）时生效的检查开关，默认只跑 BOM。
  legacyChecks.clangFormat (boolean, 默认 false) — 老文件是否格式化（仅改动行模式）。
  legacyChecks.copyright   (boolean, 默认 false) — 老文件是否插入/更新版权头。
  legacyChecks.cpplint     (boolean, 默认 false) — 老文件是否运行 cpplint。
  legacyChecks.bom         (boolean, 默认 true)  — 老文件是否确保 UTF-8 BOM。
  示例：老文件也加 copyright → "legacyChecks": { "copyright": true, "bom": true }

copyrightInfo (object)
  版权头的内容配置。company 空时不生成版权头。
  copyrightInfo.company    (string, 默认 "") — 公司/组织名，版权行内容。
    生成格式：// Copyright YYYY <company>
    示例："company": "The Master Lu PC-Group Authors. All rights reserved."
  copyrightInfo.author     (string, 默认 "") — 作者邮箱或姓名，可留空。
    生成格式：// Author <author>
    示例："author": "pc_zhangxinqi@ludashi.com"
  copyrightInfo.dateFormat (string, 默认 "YYYY/MM/DD HH:mm")
    日期格式，支持 YYYY（年）、MM（月）、DD（日）、HH（时）、mm（分）。
    默认"年/月/日 时:分"格式，通常无需修改。
    示例：只要日期不要时间 → "dateFormat": "YYYY/MM/DD"

-----------------------------------------------------------
版权头格式说明
-----------------------------------------------------------
生成的版权头共 4 行：
  // Copyright YYYY <company>
  // Author <author>         （author 为空时省略此行）
  // Date YYYY/MM/DD HH:mm
  // src/path/to/file.cc     （文件相对项目根的路径）

同日去重：同一天内只写入一次，不会重复触发。

-----------------------------------------------------------
常见场景
-----------------------------------------------------------

场景 1：老项目，只想对老文件补 BOM，新文件全套（默认行为，无需修改）
  {
    "mode": "incremental",
    "legacyChecks": { "clangFormat": false, "copyright": false, "cpplint": false, "bom": true }
  }

场景 2：老项目，想对所有文件（包括老文件）都跑全套检查
  {
    "mode": "full"
  }

场景 3：老项目，老文件补 BOM + copyright，但不跑 cpplint 和 clang-format
  {
    "mode": "incremental",
    "legacyChecks": { "clangFormat": false, "copyright": true, "cpplint": false, "bom": true }
  }

场景 4：新项目，关闭 cpplint（项目尚未达到规范）
  {
    "checks": { "cpplint": false }
  }

场景 5：临时关闭整个插件
  {
    "enabled": false
  }

-----------------------------------------------------------
全局模板修改方式
-----------------------------------------------------------
全局模板路径：~/.claude/cpp-style-template.json（Windows: C:\\Users\\<用户名>\\.claude\\cpp-style-template.json）
修改全局模板后，所有未设置项目级配置的项目都会继承新值。
已有项目级配置（本文件所在目录的 cpp-style.json）的字段优先于全局模板。
`;

/**
 * 走全套流程且项目根缺少 .claude-cpp-style/cpp-style.json 时，从全局模板拷一份到项目根。
 * 同时生成 README.txt 说明各字段用途（已存在不覆盖）。
 *
 * - root 为 null（非 git）→ 不生成（无可靠项目根概念）。
 * - root/.claude-cpp-style/cpp-style.json 已存在 → 绝不覆盖，直接返回。
 * - 内容来源：全局模板 ~/.claude/cpp-style-template.json；缺失/损坏 → 硬编码默认 schema。
 * - 写文件 UTF-8 无 BOM、LF；失败 try/catch 不崩。
 *
 * @param {string|null} root git 仓库根
 * @param {string} [templatePath] 全局模板路径（默认 ~/.claude/cpp-style-template.json）
 */
function ensureProjectConfig(root, templatePath = userTemplatePath()) {
  if (!root) return;
  try {
    const dir = path.join(root, '.claude-cpp-style');
    const target = path.join(dir, 'cpp-style.json');
    const readme = path.join(dir, 'README.txt');

    fs.mkdirSync(dir, { recursive: true });

    // JSON 配置：已存在不覆盖
    if (!fs.existsSync(target)) {
      let content = null;
      try {
        if (templatePath && fs.existsSync(templatePath)) {
          const raw = fs.readFileSync(templatePath, 'utf-8');
          JSON.parse(raw); // 校验合法 JSON，损坏则回退默认
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

    // README.txt：已存在不覆盖
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, Buffer.from(README_CONTENT, 'utf-8'));
    }
  } catch (_) {
    // 生成失败不影响主流程
  }
}

module.exports = { ensureProjectConfig };
