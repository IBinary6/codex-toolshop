const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, ensureUserTemplate, DEFAULT_CONFIG } = require('../lib/config.js');

// Isolation: every ensureUserTemplate/loadConfig call in this test passes a temporary path explicitly,
// so it never relies on os.homedir() or reads/writes the real ~/.codex/cpp-style-template.json.
// Collect temporary directories in cleanup and remove them together in finally.
const cleanupDirs = [];
function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

try {
  // ---- ensureUserTemplate: never overwrite an existing file, including user fields.----
  const tmpl = mkTmp('tmpl-');
  const defaultPath = path.join(tmpl, 'cpp-style-template.default.json');
  fs.writeFileSync(defaultPath, JSON.stringify(DEFAULT_CONFIG));
  const userPath = path.join(tmpl, 'user-template.json');
  const userContent = JSON.stringify({ enabled: true, mode: 'full', checks: {}, copyrightInfo: { company: 'ACME', author: 'kevin', dateFormat: 'YYYY/MM/DD HH:mm' } });
  fs.writeFileSync(userPath, userContent);
  const before = fs.readFileSync(userPath);
  ensureUserTemplate(defaultPath, userPath);
  const after = fs.readFileSync(userPath);
  assert.ok(before.equals(after), 'Existing template stays byte-identical');

  // ---- ensureUserTemplate: copy when absent. ----
  const userPath2 = path.join(tmpl, 'fresh-template.json');
  ensureUserTemplate(defaultPath, userPath2);
  assert.ok(fs.existsSync(userPath2), 'Missing template is copied from defaults');
  assert.ok(fs.readFileSync(userPath2).equals(fs.readFileSync(defaultPath)), 'Copied content matches defaults');

  // ---- ensureUserTemplate: missing default source does not crash.----
  assert.doesNotThrow(() => ensureUserTemplate(path.join(tmpl, 'no-such.json'), path.join(tmpl, 'x.json')), 'Copy failure is caught without crashing');

  // ---- loadConfig: project overrides global template by field.----
  const proj = mkTmp('proj-');
  const cfgDir = path.join(proj, '.codex-cpp-style');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ mode: 'full', checks: { cpplint: false }, copyrightInfo: { company: 'OVERRIDE' } }));
  const srcFile = path.join(proj, 'a.cpp');
  fs.writeFileSync(srcFile, 'int a;');
  const cfg = loadConfig(srcFile, userPath);
  assert.strictEqual(cfg.mode, 'full', 'Project overrides mode to full');
  assert.strictEqual(cfg.checks.cpplint, false, 'Project overrides cpplint to false');
  assert.strictEqual(cfg.checks.bom, true, 'Missing checks fields default to true');
  assert.strictEqual(cfg.checks.clangFormat, true, 'Missing clangFormat defaults to true');
  assert.strictEqual(cfg.copyrightInfo.company, 'OVERRIDE', 'Project overrides company');
  assert.strictEqual(cfg.copyrightInfo.author, 'kevin', 'Author falls back to global value');
  assert.strictEqual(cfg.enabled, true, 'enabled defaults to true');
  assert.strictEqual(cfg.lineEnding, 'preserve');
  fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ lineEnding: 'crlf' }));
  assert.strictEqual(loadConfig(srcFile, userPath).lineEnding, 'crlf');
  fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ lineEnding: 'lf' }));
  assert.strictEqual(loadConfig(srcFile, userPath).lineEnding, 'lf');
  fs.writeFileSync(path.join(cfgDir, 'cpp-style.json'), JSON.stringify({ lineEnding: 'invalid' }));
  assert.strictEqual(loadConfig(srcFile, userPath).lineEnding, 'preserve');

  // ---- loadConfig: legacy Claude path remains compatible. ----
  const legacyProj = mkTmp('legacy-proj-');
  const legacyCfgDir = path.join(legacyProj, '.claude-cpp-style');
  fs.mkdirSync(legacyCfgDir, { recursive: true });
  fs.writeFileSync(path.join(legacyCfgDir, 'cpp-style.json'), JSON.stringify({ checks: { cpplint: false } }));
  const legacySrc = path.join(legacyProj, 'legacy.cpp');
  fs.writeFileSync(legacySrc, 'int legacy;');
  assert.strictEqual(loadConfig(legacySrc, userPath).checks.cpplint, false, 'Legacy .claude-cpp-style path still works');

  // ---- loadConfig: invalid JSON falls back to defaults. ----
  const proj2 = mkTmp('proj2-');
  const cfgDir2 = path.join(proj2, '.codex-cpp-style');
  fs.mkdirSync(cfgDir2, { recursive: true });
  fs.writeFileSync(path.join(cfgDir2, 'cpp-style.json'), '{ broken json ');
  const src2 = path.join(proj2, 'b.cpp');
  fs.writeFileSync(src2, 'int b;');
  const cfg2 = loadConfig(src2, path.join(tmpl, 'no-global.json'));
  assert.strictEqual(cfg2.enabled, true, 'Invalid JSON without global config uses hard-coded enabled true');
  assert.strictEqual(cfg2.mode, 'incremental', 'Invalid JSON defaults to incremental');
  assert.deepStrictEqual(cfg2.checks, { clangFormat: true, copyright: true, cpplint: true, bom: true }, 'Invalid JSON defaults all checks to true');
  assert.deepStrictEqual(
    cfg2.legacyChecks,
    { clangFormat: false, copyright: false, cpplint: false, bom: false },
    'Invalid JSON keeps tracked-file encoding and format by default',
  );

  // ---- loadConfig: enabled:false takes effect. ----
  const proj3 = mkTmp('proj3-');
  const cfgDir3 = path.join(proj3, '.codex-cpp-style');
  fs.mkdirSync(cfgDir3, { recursive: true });
  fs.writeFileSync(path.join(cfgDir3, 'cpp-style.json'), JSON.stringify({ enabled: false }));
  const src3 = path.join(proj3, 'c.cpp');
  fs.writeFileSync(src3, 'int c;');
  assert.strictEqual(loadConfig(src3, userPath).enabled, false, 'enabled:false is respected');

  console.log('config.test.js PASS');
} finally {
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
}
