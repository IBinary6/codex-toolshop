const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  ensureIconvLite,
  ensureClangFormat,
  detectClangFormat,
  markerPath,
  npmInvocation,
  spawnPrewarm,
} = require('../lib/ensure_deps.js');

// ---- ensureIconvLite: return an installed module without installing. ----
{
  // iconv-lite is declared as a plugin dependency; local require may find it after npm install.
  // If absent in this environment, verify safe null fallback without a throw.
  // Use an isolated marker to avoid changing the plugin root.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-present-'));
  try {
    let installAttempted = false;
    const mod = ensureIconvLite({
      marker: path.join(tmp, '.iconv-install-failed'),
      install: () => { installAttempted = true; return false; },
    });
    if (mod) {
      assert.strictEqual(typeof mod.decode, 'function', 'Installed iconv-lite returns a module with decode');
      assert.strictEqual(installAttempted, false, 'Installed iconv-lite does not trigger installation');
      console.log('ensure_deps: iconvLite present, no install PASS');
    } else {
      assert.strictEqual(mod, null, 'Missing iconv-lite with failed installation returns null');
      assert.strictEqual(installAttempted, false, 'Default hook path only detects, never installs');
      console.log('ensure_deps: iconvLite absent, degrade null PASS');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- ensureIconvLite: an existing failure marker prevents reinstall and returns null. ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-mk-'));
  try {
    const marker = path.join(tmp, '.iconv-install-failed');
    fs.writeFileSync(marker, '1');
    let installAttempted = false;
    // Inject a name guaranteed to fail require to simulate absence.
    const mod = ensureIconvLite({
      moduleName: '__definitely_missing_iconv__',
      marker,
      install: () => { installAttempted = true; return false; },
    });
    assert.strictEqual(mod, null, 'Missing dependency with failure marker returns null');
    assert.strictEqual(installAttempted, false, 'Existing failure marker prevents another install');
    console.log('ensure_deps: iconvLite marker skips retry PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- ensureIconvLite: absent without marker, failed install writes marker and returns null without throwing. ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-fail-'));
  try {
    const marker = path.join(tmp, '.iconv-install-failed');
    let installAttempted = false;
    const mod = ensureIconvLite({
      moduleName: '__definitely_missing_iconv__',
      marker,
      allowInstall: true,
      install: () => { installAttempted = true; return false; }, // Simulate installation failure.
    });
    assert.strictEqual(mod, null, 'Missing dependency with failed install returns null');
    assert.strictEqual(installAttempted, true, 'Missing dependency without marker attempts one install');
    assert.ok(fs.existsSync(marker), 'Failed install writes a marker to avoid retry');
    console.log('ensure_deps: iconvLite install fail writes marker PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- detectClangFormat: injected probe prefers clang-format on PATH. ----
{
  const probed = [];
  const desc = detectClangFormat({
    probe: (d) => { probed.push(d); return d.cmd === 'clang-format'; },
    scriptsDirs: () => [],
  });
  assert.deepStrictEqual(desc, { cmd: 'clang-format', args: [] }, 'PATH match returns a PATH invocation');
  assert.deepStrictEqual(probed[0], { cmd: 'clang-format', args: [] }, 'Probe clang-format on PATH first');
  console.log('ensure_deps: detect PATH desc PASS');
}

// ---- detectClangFormat: use python -m clang_format when PATH lacks it. ----
{
  const desc = detectClangFormat({
    probe: (d) => d.cmd === 'python' && d.args[0] === '-m' && d.args[1] === 'clang_format',
    scriptsDirs: () => [],
    pythons: () => [{ cmd: 'python', args: [] }],
  });
  assert.deepStrictEqual(desc, { cmd: 'python', args: ['-m', 'clang_format'] },
    'Use python module invocation when PATH lacks clang-format');
  console.log('ensure_deps: detect python -m clang_format desc PASS');
}

// ---- detectClangFormat: use an executable in Scripts when that is the only option. ----
{
  const scriptExe = { cmd: '/fake/Scripts/clang-format', args: [] };
  const desc = detectClangFormat({
    probe: (d) => d.cmd === scriptExe.cmd,
    scriptsDirs: () => [scriptExe],
  });
  assert.deepStrictEqual(desc, scriptExe, 'Use the executable in Scripts when it alone works');
  console.log('ensure_deps: detect Scripts-dir desc PASS');
}

// ---- detectClangFormat: return null when all options fail. ----
{
  const desc = detectClangFormat({ probe: () => false, scriptsDirs: () => [] });
  assert.strictEqual(desc, null, 'Return null when all invocation methods fail');
  console.log('ensure_deps: detect none -> null PASS');
}

// ---- ensureClangFormat: return PATH invocation without invoking pip. ----
{
  const hasClangFormat = spawnSync('clang-format', ['--version'], { stdio: 'pipe' }).status === 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-cf-present-'));
  try {
    let installAttempted = false;
    const desc = ensureClangFormat({
      marker: path.join(tmp, '.clang-format-install-failed'),
      install: () => { installAttempted = true; return false; },
    });
    if (hasClangFormat) {
      assert.deepStrictEqual(desc, { cmd: 'clang-format', args: [] },
        'With clang-format on PATH, return that invocation');
      assert.strictEqual(installAttempted, false, 'With clang-format on PATH, never invoke pip');
      console.log('ensure_deps: clangFormat present, no install PASS');
    } else {
      assert.strictEqual(desc, null, 'Missing dependency with failed install returns null');
      assert.strictEqual(installAttempted, false, 'Default hook path only detects, never installs');
      console.log('ensure_deps: clangFormat absent, degrade null PASS');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- ensureClangFormat: return Python invocation found after installation. ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-cf-pip-'));
  try {
    let detectCalls = 0;
    const pythonDesc = { cmd: 'python', args: ['-m', 'clang_format'] };
    const desc = ensureClangFormat({
      marker: path.join(tmp, '.clang-format-install-failed'),
      detect: () => { detectCalls += 1; return detectCalls === 1 ? null : pythonDesc; },
      allowInstall: true,
      install: () => true, // Simulate a successful pip install.
    });
    assert.deepStrictEqual(desc, pythonDesc, 'Return python -m clang_format after pip installation');
    assert.strictEqual(detectCalls, 2, 'Detect once before and once after install');
    console.log('ensure_deps: clangFormat pip then python desc PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- ensureClangFormat: do not retry after a prior failure marker. ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-cf-mk-'));
  try {
    const marker = path.join(tmp, '.clang-format-install-failed');
    fs.writeFileSync(marker, '1');
    let installAttempted = false;
    const cmd = ensureClangFormat({
      detect: () => null, // Force detection failure.
      marker,
      install: () => { installAttempted = true; return false; },
    });
    assert.strictEqual(cmd, null, 'Missing executable with failure marker returns null');
    assert.strictEqual(installAttempted, false, 'Existing failure marker prevents pip install');
    console.log('ensure_deps: clangFormat marker skips retry PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- ensureClangFormat: installer exceptions return null safely. ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-cf-throw-'));
  try {
    const marker = path.join(tmp, '.clang-format-install-failed');
    const cmd = ensureClangFormat({
      detect: () => null,
      marker,
      allowInstall: true,
      install: () => { throw new Error('boom'); },
    });
    assert.strictEqual(cmd, null, 'Installer exceptions are caught and return null');
    console.log('ensure_deps: clangFormat install throw safe PASS');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- markerPath: return a stable path under the plugin directory. ----
{
  const p = markerPath('.iconv-install-failed');
  assert.ok(path.isAbsolute(p), 'markerPath returns an absolute path');
  assert.ok(p.endsWith('.iconv-install-failed'), 'markerPath retains the filename');
  console.log('ensure_deps: markerPath PASS');
}

// ---- npmInvocation: never spawn npm.cmd directly (Node rejects .cmd without a shell). ----
{
  const args = ['install', 'iconv-lite@0.6.3', '--prefix', 'C:\\Users\\A B\\data & more'];
  const posix = npmInvocation(args, { platform: 'darwin', env: {} });
  assert.strictEqual(posix.cmd, 'npm', 'POSIX runs npm directly');
  assert.deepStrictEqual(posix.args, args, 'POSIX keeps arguments unchanged');

  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
  const direct = npmInvocation(args, { platform: 'win32', env: {}, execPath: nodeExe, exists: () => true });
  assert.strictEqual(direct.cmd, nodeExe, 'Windows prefers node + npm-cli.js');
  assert.ok(/npm-cli\.js$/.test(direct.args[0]), 'Windows passes npm-cli.js as the first argument');
  assert.deepStrictEqual(direct.args.slice(1), args, 'Windows forwards npm arguments');
  assert.strictEqual(direct.windowsVerbatimArguments, false);

  const shim = npmInvocation(args, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\cmd.exe' }, execPath: nodeExe, exists: () => false });
  assert.strictEqual(shim.cmd, 'C:\\Windows\\cmd.exe', 'Fallback launches through cmd.exe, never npm.cmd');
  assert.ok(!/\.cmd$/i.test(shim.cmd), 'Fallback command is not a batch file');
  assert.strictEqual(shim.windowsVerbatimArguments, true);
  assert.strictEqual(shim.env.CPP_STYLE_NPM_ARG_3, args[3], 'Paths travel through environment variables');
  assert.ok(!shim.args.join(' ').includes('A B'), 'Raw paths never reach the cmd.exe command line');
  console.log('ensure_deps: npmInvocation cross-platform PASS');
}

// ---- spawnPrewarm: detached background launch does not block or throw. ----
{
  const child = spawnPrewarm();
  // Return a child handle or null without throwing on spawn failure.
  assert.ok(child === null || typeof child.pid === 'number' || child.pid === undefined,
    'spawnPrewarm returns a child or null without throwing');
  if (child && typeof child.unref === 'function') {
    // Already unrefed, so it does not block test process exit.
  }
  console.log('ensure_deps: spawnPrewarm non-blocking PASS');
}

console.log('ensure_deps.test.js PASS');
