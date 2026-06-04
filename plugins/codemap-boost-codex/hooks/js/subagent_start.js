'use strict';

const { additionalContext, passSilent } = require('./lib/runtime');
const { CONTEXT, canUseCrg, isCodeMapEnabled } = require('./lib/codemap');

if (!isCodeMapEnabled() || !canUseCrg()) {
  passSilent();
} else {
  additionalContext('SubagentStart', CONTEXT);
}
