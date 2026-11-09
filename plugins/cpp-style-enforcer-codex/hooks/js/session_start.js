'use strict';

const path = require('path');
const { ensureUserTemplate } = require('./lib/config');
const { hookFailure } = require('./lib/protocol');

// Absolute factory template path (hooks/js -> plugin root -> templates/).
const PLUGIN_DEFAULT_TEMPLATE = path.join(__dirname, '..', '..', 'templates', 'cpp-style-template.default.json');

try {
  ensureUserTemplate(PLUGIN_DEFAULT_TEMPLATE, undefined, { strict: true });
} catch (error) {
  hookFailure('SessionStart', error);
}

// No user task has arrived yet; opening a C++ repository must not write project files.
// Project configuration is initialized as needed by PostToolUse after an actual edit.
