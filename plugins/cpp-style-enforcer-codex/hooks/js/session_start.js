'use strict';

const path = require('path');
const { ensureUserTemplate } = require('./lib/config');

// Absolute factory template path (hooks/js -> plugin root -> templates/).
const PLUGIN_DEFAULT_TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'cpp-style-template.default.json');

try {
  ensureUserTemplate(PLUGIN_DEFAULT_TEMPLATE);
} catch (_) {
  // Ignore copy failure (such as permissions); callers fall back to hard-coded defaults without a global template.
}

// No user task has arrived yet; opening a C++ repository must not write project files.
// Project configuration is initialized as needed by Stop after an actual edit.
