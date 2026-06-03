'use strict';

/**
 * 从 stdin 读取 JSON（hook 输入）。空输入或解析失败返回 {}。
 * @param {{timeoutMs?:number, maxSize?:number}} options
 * @returns {Promise<object>}
 */
function readStdinJson(options = {}) {
  const { timeoutMs = 5000, maxSize = 1024 * 1024 } = options;
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = () => {
      try { resolve(data.trim() ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.stdin.removeAllListeners();
      if (process.stdin.unref) process.stdin.unref();
      finish();
    }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { if (data.length < maxSize) data += chunk; });
    process.stdin.on('end', () => {
      if (settled) return;
      settled = true; clearTimeout(timer); finish();
    });
    process.stdin.on('error', () => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({});
    });
  });
}

module.exports = { readStdinJson };
