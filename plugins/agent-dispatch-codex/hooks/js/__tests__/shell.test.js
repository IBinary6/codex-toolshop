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
assert.equal(analyzeShellCommand('git push --force origin main', config).safe, false);
assert.equal(analyzeShellCommand('git push --mirror origin', config).safe, false);
assert.equal(analyzeShellCommand('git push --prune origin', config).safe, false);
assert.equal(analyzeShellCommand('git push --delete origin old', config).safe, false);
assert.equal(analyzeShellCommand('git push -d origin old', config).safe, false);
assert.equal(analyzeShellCommand('git push origin +main', config).safe, false);
assert.equal(analyzeShellCommand('git push origin :old', config).safe, false);
assert.equal(analyzeShellCommand('git remote -v', config).safe, true);
assert.equal(analyzeShellCommand('git remote remove origin', config).safe, false);
assert.equal(analyzeShellCommand('git config --get user.name', config).safe, true);
assert.equal(analyzeShellCommand('git config user.name value', config).safe, false);
assert.equal(analyzeShellCommand('git stash list', config).safe, true);
assert.equal(analyzeShellCommand('git stash drop', config).safe, false);
assert.equal(analyzeShellCommand('git tag -l', config).safe, true);
assert.equal(analyzeShellCommand('git tag -d old', config).safe, false);
assert.equal(analyzeShellCommand('git branch', config).safe, true);
assert.equal(analyzeShellCommand('git branch feature', config).safe, false);
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
