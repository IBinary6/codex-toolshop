'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..', '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const plugin = readJson(path.join(root, '.codex-plugin', 'plugin.json'));
  const pkg = readJson(path.join(root, 'package.json'));
  const marketplace = readJson(path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'));
  const hooks = readJson(path.join(root, 'hooks', 'hooks.json'));
  const legacyHooks = readJson(path.join(root, 'hooks', 'codex-hooks.json'));
  const entry = marketplace.plugins.find((item) => item.name === plugin.name);

  assert(plugin.name === 'system-proxy-codex', 'plugin name is wrong');
  const releaseVersion = plugin.version.split('+')[0];
  assert(releaseVersion === pkg.version, 'package must match the plugin release version');
  assert(pkg.engines && pkg.engines.node === '>=18', 'package must declare the supported Node runtime');
  assert(entry && entry.version === releaseVersion, 'marketplace must match the plugin release version');
  assert(entry.source.path === './plugins/system-proxy-codex', 'marketplace source is wrong');
  assert(plugin.skills === './skills/', 'skills directory must be declared');
  assert(fs.existsSync(path.join(root, plugin.interface.composerIcon)), 'composer icon is missing');
  assert(fs.existsSync(path.join(root, plugin.interface.logo)), 'plugin logo is missing');
  assert(!Object.prototype.hasOwnProperty.call(plugin, 'hooks'), 'hooks are discovered from hooks/hooks.json');
  assert(JSON.stringify(hooks) === JSON.stringify(legacyHooks), 'hook manifests must match');
  assert(hooks.hooks.SessionStart, 'SessionStart hook is required');
  const hookText = JSON.stringify(hooks);
  assert(hookText.includes('${PLUGIN_ROOT}'), 'hook must use PLUGIN_ROOT');
  assert(!/[A-Za-z]:[\\/]/.test(hookText), 'hook must not contain absolute Windows paths');
  assert(!fs.existsSync(path.join(root, 'scripts', 'setup-system-proxy.ps1')), 'PowerShell setup scripts are not allowed');
  const bootstrap = fs.readFileSync(path.join(repoRoot, 'scripts', 'install_system_proxy_codex.py'), 'utf8');
  const expectedReleaseRef = `system-proxy-codex-v${releaseVersion}`;
  assert(bootstrap.includes(`RELEASE_REF = "${expectedReleaseRef}"`),
    'bootstrap release ref must match the plugin version');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const releaseRefs = [...readme.matchAll(/system-proxy-codex-v\d+\.\d+\.\d+/g)]
    .map((match) => match[0]);
  assert(releaseRefs.length > 0 && releaseRefs.every((ref) => ref === expectedReleaseRef),
    'README release refs must match the plugin version');
  for (const name of ['setup_proxy.py', 'session_start.py', 'install_system_proxy_codex.py']) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'scripts', name))).digest('hex');
    assert(bootstrap.includes(`"${name}": "${digest}"`), `bootstrap hash is stale for ${name}`);
  }
  console.log('check-plugin PASS');
}

main();
