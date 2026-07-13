'use strict';

const { readStdinJson, hookCwd, passSilent } = require('./lib/runtime');
const { refreshCrgSync, refreshLinkedWorktreesSync } = require('./lib/codemap');

function gitCommandDoesNotChangeSources(segment) {
  const match = segment.match(/^git\s+(?:-[^\s]+\s+)*([a-z-]+)(?:\s+(.*))?$/i);
  if (!match) return false;
  const subcommand = match[1].toLowerCase();
  const args = String(match[2] || '').trim();
  if (['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'cat-file',
    'name-rev', 'describe', 'push', 'fetch'].includes(subcommand)) return true;
  if (subcommand === 'remote') return args === '' || args === '-v' || args === '--verbose';
  if (subcommand === 'tag') return args === '' || /^(?:-l|--list)(?:\s|$)/.test(args);
  if (subcommand === 'branch') {
    return args === '' || /^(?:--show-current|--list|-a|-r|-v|-vv)(?:\s|$)/.test(args);
  }
  return false;
}

function bashMayChangeSources(command) {
  const text = String(command || '').trim();
  if (!text) return false;
  if (/(?:^|[^<])>{1,2}(?!>)|\$\(|`/.test(text)) return true;
  const segments = text.split(/\s*(?:&&|\|\||;|\r?\n|\|)\s*/).filter(Boolean);
  return segments.some((segment) => {
    const normalized = segment.trim();
    if (gitCommandDoesNotChangeSources(normalized)) return false;
    if (/^(?:rg|grep|select-string|get-content|get-childitem|test-path|pwd|get-location|where\.exe)\b/i.test(normalized)) return false;
    if (/^npm\s+(?:test|run\s+(?:test|check|lint|typecheck))\b/i.test(normalized)) return false;
    return true;
  });
}

async function main() {
  const input = await readStdinJson({ timeoutMs: 2000 });
  const cwd = hookCwd(input);
  const command = input && input.tool_input && input.tool_input.command;
  try {
    if (typeof command === 'string' && !bashMayChangeSources(command)) {
      passSilent();
      return;
    }
    if (/\bgit\s+(?:-[^\s]+\s+)*worktree\s+add\b/i.test(String(command || ''))) {
      refreshLinkedWorktreesSync(cwd);
    } else {
      refreshCrgSync(cwd);
    }
  } catch (_) {}
  passSilent();
}

if (require.main === module) main().catch(() => passSilent());

module.exports = { bashMayChangeSources, gitCommandDoesNotChangeSources, main };
