'use strict';

const assert = require('assert').strict;
const { analyzeShellCommand, splitCommandSegments } = require('../lib/shell');
const { loadDefaults } = require('../lib/config');

const config = loadDefaults();

assert.deepEqual(splitCommandSegments('npm test&&git status'), ['npm test', 'git status']);
assert.deepEqual(splitCommandSegments('Get-ChildItem|Select-String foo'), ['Get-ChildItem', 'Select-String foo']);
assert.deepEqual(splitCommandSegments('echo "a;b";git status'), ['echo "a;b"', 'git status']);
assert.deepEqual(splitCommandSegments('rg TODO&unknown-heavy-tool scan'), ['rg TODO', 'unknown-heavy-tool scan']);

assert.equal(analyzeShellCommand('git status && rg TODO src', config).safe, true);
assert.equal(analyzeShellCommand('Get-ChildItem | Select-String TODO', config).safe, true);
assert.equal(analyzeShellCommand('git push origin main', config).safe, true);
assert.equal(analyzeShellCommand('git push --force origin main', config).safe, true);
assert.equal(analyzeShellCommand('git push --mirror origin', config).safe, true);
assert.equal(analyzeShellCommand('git push --prune origin', config).safe, true);
assert.equal(analyzeShellCommand('git push --delete origin old', config).safe, true);
assert.equal(analyzeShellCommand('git push -d origin old', config).safe, true);
assert.equal(analyzeShellCommand('git push origin +main', config).safe, true);
assert.equal(analyzeShellCommand('git push origin :old', config).safe, true);
assert.equal(analyzeShellCommand('git remote -v', config).safe, true);
assert.equal(analyzeShellCommand('git remote remove origin', config).safe, true);
assert.equal(analyzeShellCommand('git config --get user.name', config).safe, true);
assert.equal(analyzeShellCommand('git config user.name value', config).safe, true);
assert.equal(analyzeShellCommand('git stash list', config).safe, true);
assert.equal(analyzeShellCommand('git stash drop', config).safe, true);
assert.equal(analyzeShellCommand('git tag -l', config).safe, true);
assert.equal(analyzeShellCommand('git tag -d old', config).safe, true);
assert.equal(analyzeShellCommand('git branch', config).safe, true);
assert.equal(analyzeShellCommand('git branch feature', config).safe, true);
assert.equal(analyzeShellCommand('git branch --merged', config).safe, true);
assert.equal(analyzeShellCommand('git switch main', config).safe, true);
assert.equal(analyzeShellCommand('git merge --ff-only topic', config).safe, true);
assert.equal(analyzeShellCommand('git rebase main', config).safe, true);
assert.equal(analyzeShellCommand('git branch -D temp', config).safe, true);
assert.equal(analyzeShellCommand('git reset --hard HEAD', config).safe, true);
assert.equal(analyzeShellCommand('git clean -fdx', config).safe, true);
assert.equal(analyzeShellCommand('git -C repo branch -D temp', config).safe, true);
assert.equal(analyzeShellCommand('git -c core.quotePath=false status', config).safe, true);
assert.equal(analyzeShellCommand('git --git-dir=.git --work-tree=. status', config).safe, true);
assert.equal(analyzeShellCommand('git.exe status', config).safe, true);
assert.equal(analyzeShellCommand('command git status', config).safe, true);
assert.equal(analyzeShellCommand('command -- git status', config).safe, true);
assert.equal(analyzeShellCommand('sudo git status', config).safe, true);
assert.equal(analyzeShellCommand('sudo -- git status', config).safe, true);
assert.equal(analyzeShellCommand('sudo -u root git status', config).safe, true);
assert.equal(analyzeShellCommand('sudo --user=root git status', config).safe, true);
assert.equal(analyzeShellCommand('sudo command git status', config).safe, true);
assert.equal(analyzeShellCommand('env FOO=bar git status', config).safe, true);
assert.equal(analyzeShellCommand("env -S 'git status'", config).safe, true);
assert.equal(analyzeShellCommand('env -S git status', config).safe, true);
assert.equal(analyzeShellCommand("env --split-string='git status'", config).safe, true);
assert.equal(analyzeShellCommand("env --split-string 'git status'", config).safe, true);
assert.equal(analyzeShellCommand('env -u FOO -C repo git status', config).safe, true);
assert.equal(analyzeShellCommand('env -a custom git status', config).safe, true);
assert.equal(analyzeShellCommand('env -a git rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git commit -m "docs; rm -rf is only prose"', config).safe, true);
assert.equal(analyzeShellCommand('git commit -m "literal (text) {json}"', config).safe, true);
assert.equal(analyzeShellCommand("git commit -m '$(literal)'", config).safe, true);
assert.equal(analyzeShellCommand('git commit -m "$(date)"', config).safe, false);
assert.equal(analyzeShellCommand('git commit -m "`date`"', config).safe, false);
assert.equal(analyzeShellCommand('git commit -m "fix \\"foo; rm -rf\\""', config).safe, false);
assert.equal(analyzeShellCommand('git commit -m "fix `"foo; rm -rf`""', config).safe, false);
assert.equal(analyzeShellCommand('git status "foo\\\\"; rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand("git status 'foo`'; rm -rf .", config).safe, false);
assert.equal(analyzeShellCommand('git status "foo``"; rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git commit -m "subject\n# body"; rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand("git commit -m 'subject\n# body'; rm -rf .", config).safe, false);
assert.equal(analyzeShellCommand(
  'git commit -m "subject\nfoo <<EOF\nbody"; rm -rf .',
  config
).safe, false);
assert.equal(analyzeShellCommand('git status foo\\\n#not-comment; rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status foo`\n#not-comment; rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand("git commit -F - <<'EOF'\nmessage body\nEOF", config).safe, true);
assert.equal(analyzeShellCommand(
  "git commit -F - <<'EOF'\nmessage body\nEOF\nrm -rf .",
  config
).safe, false);
assert.equal(analyzeShellCommand('git status\\;rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status # <<EOF\nrm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status <<< payload\nrm -rf .', config).safe, false);
assert.equal(analyzeShellCommand(
  'git commit -F - <<- EOF\n\tmessage\n\tEOF',
  config
).safe, true);
assert.equal(analyzeShellCommand(
  'git commit -F - <<- EOF\n\tmessage\n\tEOF\nrm -rf .',
  config
).safe, false);
assert.equal(analyzeShellCommand(
  'git commit -F - <<\\EOF\nmessage\nEOF',
  config
).safe, true);
assert.equal(analyzeShellCommand(
  'git commit -F - <<\\EOF\nmessage\nEOF\nrm -rf .',
  config
).safe, false);
assert.equal(analyzeShellCommand(
  'git commit -F - <<"EO"F\nmessage\nEOF\nrm -rf .',
  config
).safe, false);
assert.equal(analyzeShellCommand('git status $((1 << 2))\nrm -rf .', config).safe, false);
assert.equal(analyzeShellCommand(
  "git commit -F - <<$'EOF'\nmessage\nEOF",
  config
).safe, true);
assert.equal(analyzeShellCommand(
  "git commit -F - <<$'EOF'\nmessage\nEOF\nrm -rf .",
  config
).safe, false);
assert.equal(analyzeShellCommand('git status ${x:-a<<b}\nrm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status $[1 << 2]\nrm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status foo\\<<bar\nrm -rf .', config).safe, false);
assert.equal(analyzeShellCommand(
  'git commit -F - <<-EOF\n\tmessage\n\tEOF',
  config
).safe, true);
assert.equal(analyzeShellCommand(
  'git commit -F - << -EOF\nmessage\n-EOF\nrm -rf .',
  config
).safe, false);
assert.equal(analyzeShellCommand('git commit -F - <<EOF\nrm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status # comment; rm -rf .', config).safe, true);
assert.equal(analyzeShellCommand('git status foo\\ #not-comment; rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status foo` #not-comment; rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status foo\\;#not-comment; rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status foo`;#not-comment; rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git log > out.txt', config).safe, true);
assert.equal(analyzeShellCommand('git status && git log && git branch -D temp', config).safe, true);
assert.equal(analyzeShellCommand('git branch -D temp && rg TODO src', config).safe, true);
assert.equal(analyzeShellCommand('git status && unknown-heavy-tool scan', config).safe, false);
assert.equal(analyzeShellCommand('git status && rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('sudo -u root git status && rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('git status $(Remove-Item . -Recurse -Force)', config).safe, false);
assert.equal(analyzeShellCommand('git status "$(rm -rf .)"', config).safe, false);
assert.equal(analyzeShellCommand('git status <(rm -rf .)', config).safe, false);
assert.equal(analyzeShellCommand(
  'git commit -F - <<EOF\n$(rm -rf .)\nEOF',
  config
).safe, false);
assert.equal(analyzeShellCommand(
  'git status <# <<EOF #>\nRemove-Item . -Recurse -Force',
  config
).safe, false);
assert.equal(analyzeShellCommand(
  'git status @"\ncontent"\n"@\nRemove-Item . -Recurse -Force # \\git"',
  config
).safe, false);
assert.equal(analyzeShellCommand(
  'Write-Output x | ForEach-Object { Remove-Item . -Recurse -Force }',
  config
).safe, false);
assert.equal(analyzeShellCommand(
  'Write-Output x | ForEach-Object { unknown-heavy-tool scan }',
  config
).safe, false);
assert.equal(analyzeShellCommand('Write-Output @(Remove-Item . -Recurse -Force)', config).safe, false);
assert.equal(analyzeShellCommand('Write-Output (Remove-Item . -Recurse -Force)', config).safe, false);
assert.equal(analyzeShellCommand(
  "Write-Output $ExecutionContext.InvokeCommand.InvokeScript('Remove-Item . -Recurse -Force')",
  config
).safe, false);
assert.equal(analyzeShellCommand(
  "Write-Output $ExecutionContext.InvokeCommand.InvokeScript('unknown-heavy-tool scan')",
  config
).safe, false);
assert.equal(analyzeShellCommand(
  "Write-Output [ScriptBlock]::Create('unknown-heavy-tool scan').Invoke()",
  config
).safe, false);
assert.equal(analyzeShellCommand(
  'git status $((\ngit << B\n))\nrm -rf .\nB',
  config
).safe, false);
assert.equal(analyzeShellCommand(
  'git status ${x:-\ngit << B\n}\nrm -rf .\nB',
  config
).safe, false);
assert.equal(analyzeShellCommand(
  'git status $[\ngit << B\n]\nrm -rf .\nB',
  config
).safe, false);
assert.equal(analyzeShellCommand('git log > out.txt && rg TODO src', config).safe, true);
assert.equal(analyzeShellCommand('git log > out.txt && echo ok > other.txt', config).safe, false);
assert.equal(analyzeShellCommand('echo ok;rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('npm test&&rm -rf .', config).safe, false);
assert.equal(analyzeShellCommand('echo ok>out.txt', config).safe, false);
assert.equal(analyzeShellCommand('rg x <(rm -rf .)', config).safe, false);
assert.equal(analyzeShellCommand('rg x >(out.txt)', config).safe, false);
assert.equal(analyzeShellCommand('rg TODO&unknown-heavy-tool scan', config).safe, false);
assert.equal(analyzeShellCommand('rg TODO\\">out', config).safe, false);
assert.equal(analyzeShellCommand('echo \\$(whoami)', config).safe, false);
assert.equal(analyzeShellCommand('Remove-Item . -Recurse -Force', config).safe, false);
assert.equal(analyzeShellCommand('unknown-heavy-tool scan', config).safe, false);
