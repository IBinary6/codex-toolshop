const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, 'fixtures', 'stdin-runner.js');
// fixtures/stdin-runner.js calls readStdinJson and logs JSON.stringify(result).
require('fs').mkdirSync(path.dirname(script), { recursive: true });
require('fs').writeFileSync(script, `
const { readStdinJson } = require('${path.join(__dirname, '..', 'lib', 'stdin.js').replace(/\\/g, '/')}');
readStdinJson({ timeoutMs: 500 }).then(r => { console.log(JSON.stringify(r)); process.exit(0); });
`);

function run(input) {
  const r = spawnSync('node', [script], { input, encoding: 'utf-8', timeout: 5000 });
  return JSON.parse(r.stdout.trim() || '{}');
}

assert.deepStrictEqual(run('{"a":1}'), { a: 1 }, 'Valid JSON is parsed');
assert.deepStrictEqual(run(''), {}, 'Empty input returns {}');
assert.deepStrictEqual(run('not json'), {}, 'Invalid JSON returns {}');
console.log('stdin.test.js PASS');
