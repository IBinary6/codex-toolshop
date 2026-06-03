'use strict';

const { additionalContext, passSilent } = require('./lib/runtime');
const { CONTEXT, canUseCrg } = require('./lib/codemap');

if (!canUseCrg()) {
  passSilent();
} else {
  additionalContext('SubagentStart', CONTEXT);
}
