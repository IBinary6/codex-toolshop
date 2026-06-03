const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, 'fixtures', 'stdin-runner.js');
// fixtures/stdin-runner.js: 调用 readStdinJson 并 console.log(JSON.stringify(result))
require('fs').mkdirSync(path.dirname(script), { recursive: true });
require('fs').writeFileSync(script, `
const { readStdinJson } = require('${path.join(__dirname, '..', 'lib', 'stdin.js').replace(/\\/g, '/')}');
readStdinJson({ timeoutMs: 500 }).then(r => { console.log(JSON.stringify(r)); process.exit(0); });
`);

function run(input) {
  const r = spawnSync('node', [script], { input, encoding: 'utf-8', timeout: 5000 });
  return JSON.parse(r.stdout.trim() || '{}');
}

assert.deepStrictEqual(run('{"a":1}'), { a: 1 }, '合法 JSON 应解析');
assert.deepStrictEqual(run(''), {}, '空输入应返回 {}');
assert.deepStrictEqual(run('not json'), {}, '非法 JSON 应返回 {}');
console.log('stdin.test.js PASS');
