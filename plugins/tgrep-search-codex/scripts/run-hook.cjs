#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const tgrep = require('./tgrep.cjs');

const events = {
  session_start: 'SessionStart',
  subagent_start: 'SubagentStart',
  user_prompt_submit: 'UserPromptSubmit'
};

function cliArgument(file) {
  return "'" + file.split("'").join("'" + String.fromCharCode(92) + "''") + "'";
}

function entryGuidance(file) {
  const cli = cliArgument(file);
  return `tgrep CLI (not MCP): run node ${cli} search -n -- "pattern" PATH... in the target workdir. Relative PATH resolves from workdir; --root selects only the service/scan root and does not change PATH.`;
}

function emit(write, event, additionalContext) {
  write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}

async function runHook(eventArgument, input = {}, api = tgrep, write = console.log, cliFile = path.join(__dirname, 'tgrep.cjs')) {
  const event = events[eventArgument];
  if (!event) throw new Error(`unknown hook event: ${eventArgument}`);
  const guidance = entryGuidance(cliFile);

  // Subagents need an immediate deterministic entry; this event must not probe repositories, update, install, or manage services.
  if (event === 'SubagentStart') {
    emit(write, event, guidance);
    return;
  }

  const ctx = api.context(input.cwd || process.cwd());
  if (!ctx?.git) {
    // Outside Git, only emit the unindexed scan entry; SessionStart must not create state or background work.
    if (event === 'SessionStart') emit(write, event, guidance);
    return;
  }

  api.maybeCheckUpdates();
  const state = await api.managed(ctx, 'touch');
  if (!state) api.start(ctx);
  if (event === 'UserPromptSubmit') return;
  const cli = cliArgument(cliFile);
  emit(write, event, `${guidance} Startup status for ${JSON.stringify(ctx.root)} only: ${state?.phase || 'starting/pending'}; this is a snapshot, not the status of other target worktrees. --fresh scans disk directly. Initial indexing, errors, and zero matches trigger live-scan verification. Prefer CodeMap for symbols, call chains, and impact; read known files directly. Diagnostics: run node ${cli} doctor in the target workdir.`);
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  await runHook(process.argv[2], input);
}

module.exports = { entryGuidance, runHook };
if (require.main === module) main().catch(e => { console.error(`[tgrep hook] ${e.message}`); process.exitCode = 0; });
