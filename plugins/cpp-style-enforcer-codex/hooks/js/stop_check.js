'use strict';

const { readStdinJson } = require('./lib/stdin');
const { passSilent, hookFailure } = require('./lib/protocol');

// Compatibility for older manifests. Stop leaves the checked worktree and legacy records alone.
readStdinJson().then(passSilent, (error) => hookFailure('Stop', error));
