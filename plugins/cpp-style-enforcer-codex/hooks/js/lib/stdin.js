'use strict';

/**
 * Strict hooks reject unavailable or invalid input so a failed read cannot pass verification.
 * @param {{timeoutMs?:number, maxSize?:number, strict?:boolean}} options
 * @returns {Promise<object>}
 */
function readStdinJson(options = {}) {
  const { timeoutMs = 5000, maxSize = 1024 * 1024, strict = false } = options;
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const fail = (message) => strict ? reject(new Error(message)) : resolve({});
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };
    const onData = (chunk) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size <= maxSize) data += chunk;
    };
    const onEnd = () => {
      cleanup();
      if (size > maxSize) return fail('Hook input exceeds the supported size');
      if (!data.trim()) return fail('Hook input is missing');
      let input;
      try { input = JSON.parse(data); }
      catch (_) { return fail('Hook input is not valid JSON'); }
      if (strict && (!input || typeof input !== 'object' || Array.isArray(input))) return fail('Hook input must be a JSON object');
      resolve(input);
    };
    const onError = () => { cleanup(); fail('Could not read hook input'); };
    const timer = setTimeout(() => {
      cleanup();
      process.stdin.pause();
      if (process.stdin.unref) process.stdin.unref();
      fail('Timed out reading hook input');
    }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
  });
}

module.exports = { readStdinJson };
