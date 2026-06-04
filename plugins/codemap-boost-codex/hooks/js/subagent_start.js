'use strict';

const { additionalContext, passSilent } = require('./lib/runtime');
const { CONTEXT, isCodeMapEnabled } = require('./lib/codemap');

if (!isCodeMapEnabled()) {
  passSilent();
} else {
  additionalContext('SubagentStart', CONTEXT);
}
