'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 硬编码安全默认（全局模板/项目配置都缺失或损坏时的兜底） */
const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'incremental',
  checks: { clangFormat: true, copyright: true, cpplint: true, bom: true },
  legacyChecks: { clangFormat: false, copyright: false, cpplint: false, bom: true },
  copyrightInfo: { company: '', author: '', dateFormat: 'YYYY/MM/DD HH:mm' },
};

/** 全局模板默认路径 ~/.codex/cpp-style-template.json */
function userTemplatePath() {
  return path.join(os.homedir(), '.codex', 'cpp-style-template.json');
}

/**
 * 用户全局模板不存在才从出厂默认复制；已存在绝不覆盖。复制失败 try/catch 吞掉。
 * @param {string} defaultPath 插件出厂默认模板绝对路径
 * @param {string} [userPath] 用户模板路径（默认 ~/.codex/cpp-style-template.json）
 * @returns {string} 用户模板路径
 */
function ensureUserTemplate(defaultPath, userPath = userTemplatePath()) {
  try {
    if (fs.existsSync(userPath)) return userPath;
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.copyFileSync(defaultPath, userPath);
  } catch (_) {
    // 权限/源缺失等 → 降级到硬编码默认，不崩
  }
  return userPath;
}

/** 安全读 JSON 文件，失败返回 null */
function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

/** 从被编辑文件向上找 .claude-cpp-style/cpp-style.json，找不到返回 null */
function findProjectConfig(filePath) {
  try {
    let dir = path.dirname(path.resolve(filePath));
    let prev = null;
    while (dir && dir !== prev) {
      const candidate = path.join(dir, '.claude-cpp-style', 'cpp-style.json');
      if (fs.existsSync(candidate)) return candidate;
      prev = dir;
      dir = path.dirname(dir);
    }
  } catch (_) {}
  return null;
}

/** 规范化：字段级合并 base ⊕ override，checks/legacyChecks 各项缺失默认见注释 */
function normalize(base, override) {
  const merged = { ...DEFAULT_CONFIG, ...base, ...override };
  const checksIn = { ...DEFAULT_CONFIG.checks, ...(base && base.checks), ...(override && override.checks) };
  const checks = {
    clangFormat: checksIn.clangFormat !== false,
    copyright: checksIn.copyright !== false,
    cpplint: checksIn.cpplint !== false,
    bom: checksIn.bom !== false,
  };
  // legacyChecks: 老文件（git 已追踪）的每项开关；默认只跑 bom，其余关闭
  const legacyIn = { ...DEFAULT_CONFIG.legacyChecks, ...(base && base.legacyChecks), ...(override && override.legacyChecks) };
  const legacyChecks = {
    clangFormat: legacyIn.clangFormat === true,
    copyright: legacyIn.copyright === true,
    cpplint: legacyIn.cpplint === true,
    bom: legacyIn.bom !== false,
  };
  const copyrightInfo = {
    ...DEFAULT_CONFIG.copyrightInfo,
    ...(base && base.copyrightInfo),
    ...(override && override.copyrightInfo),
  };
  return {
    enabled: merged.enabled !== false,
    mode: merged.mode === 'full' ? 'full' : 'incremental',
    checks,
    legacyChecks,
    copyrightInfo,
  };
}

/**
 * 读全局模板 ⊕ 项目配置字段级覆盖，返回规范化配置对象。
 * 全局/项目缺失或损坏 → 用默认值，绝不崩。
 * @param {string} filePath 被编辑文件路径
 * @param {string} [globalPath] 全局模板路径（默认 ~/.codex/cpp-style-template.json）
 * @returns {{enabled:boolean, mode:string, checks:object, copyrightInfo:object}}
 */
function loadConfig(filePath, globalPath = userTemplatePath()) {
  const global = readJsonSafe(globalPath) || {};
  const projectPath = filePath ? findProjectConfig(filePath) : null;
  const project = (projectPath && readJsonSafe(projectPath)) || {};
  return normalize(global, project);
}

module.exports = { loadConfig, ensureUserTemplate, userTemplatePath, DEFAULT_CONFIG };
