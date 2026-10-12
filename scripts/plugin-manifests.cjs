#!/usr/bin/env node
'use strict';

// One place that knows where each plugin's version and category are written. plugin.json is the source of truth.
//   node scripts/plugin-manifests.cjs --check [repository-root]      every copy agrees (run by CI)
//   node scripts/plugin-manifests.cjs bump <plugin> <patch|minor|major|x.y.z> [repository-root]
const fs = require('fs');
const path = require('path');

const MARKETPLACE = '.agents/plugins/marketplace.json';
const JSON_VERSION = /("version": ")([^"]+)(")/g;

// Copies of a version outside plugin.json and the marketplace, as [file, pattern with prefix, version and suffix
// groups, expected count, options]. `first` limits a pattern to the first N matches (a lock file also lists
// dependency versions).
function otherLocations(root, plugin) {
  const dir = `plugins/${plugin}`;
  const all = [
    [`${dir}/package.json`, JSON_VERSION, 1],
    ...({
      'cpp-style-enforcer-codex': [[`${dir}/package-lock.json`, JSON_VERSION, 2, { first: 2 }]],
      'local-knowledge-codex': [[`${dir}/pyproject.toml`, /(version = ")([^"]+)(")/g, 1]],
      'system-proxy-codex': [
        ['scripts/install_system_proxy_codex.py', /(RELEASE_REF = "system-proxy-codex-v)([^"]+)(")/g, 1],
        [`${dir}/README.md`, /(system-proxy-codex-v)(\d+\.\d+\.\d+)()/g, null],
      ],
    })[plugin] || [],
  ];
  return all.filter(([file]) => fs.existsSync(path.join(root, file)));
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function marketplace(root) {
  return readJson(root, MARKETPLACE);
}

function manifest(root, plugin) {
  return readJson(root, `plugins/${plugin}/.codex-plugin/plugin.json`);
}

function check(root) {
  const problems = [];
  for (const entry of marketplace(root).plugins) {
    const plugin = entry.name;
    const wanted = manifest(root, plugin);
    if (entry.version !== wanted.version) problems.push(`${plugin}: ${MARKETPLACE} says ${entry.version ?? '(no version)'}, plugin.json says ${wanted.version}`);
    const category = wanted.interface && wanted.interface.category;
    if (entry.category !== category) problems.push(`${plugin}: ${MARKETPLACE} category is ${entry.category}, plugin.json says ${category}`);
    for (const [file, pattern, count, options = {}] of otherLocations(root, plugin)) {
      const found = [...fs.readFileSync(path.join(root, file), 'utf8').matchAll(pattern)].slice(0, options.first).map((match) => match[2]);
      if (found.length === 0 || (count !== null && found.length !== count)) {
        problems.push(`${plugin}: ${file} has ${found.length} version(s), expected ${count ?? 'at least 1'}`);
      }
      for (const version of found) if (version !== wanted.version) problems.push(`${plugin}: ${file} says ${version}, plugin.json says ${wanted.version}`);
    }
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    return 1;
  }
  console.log(`plugin-manifests PASS (${marketplace(root).plugins.length} plugins)`);
  return 0;
}

function bump(root, plugin, how) {
  const catalog = marketplace(root);
  const entry = catalog.plugins.find((candidate) => candidate.name === plugin);
  if (!entry) throw new Error(`unknown plugin: ${plugin}`);
  const [major, minor, patch] = manifest(root, plugin).version.split('.').map(Number);
  const next = { patch: `${major}.${minor}.${patch + 1}`, minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` }[how] || how;
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`not a version: ${how}`);
  const targets = [[`plugins/${plugin}/.codex-plugin/plugin.json`, JSON_VERSION, 1, {}], ...otherLocations(root, plugin)];
  for (const [file, pattern, , options = {}] of targets) {
    const target = path.join(root, file);
    let seen = 0;
    const text = fs.readFileSync(target, 'utf8').replace(pattern, (all, before, _old, after) => {
      seen += 1;
      return options.first && seen > options.first ? all : `${before}${next}${after}`;
    });
    fs.writeFileSync(target, text);
  }
  // The marketplace is rewritten as JSON: its entries do not keep their keys in a fixed order.
  entry.version = next;
  fs.writeFileSync(path.join(root, MARKETPLACE), `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`${plugin}: ${next} (${targets.length + 1} files)`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === '--check') return check(path.resolve(rest[0] || path.join(__dirname, '..')));
  if (command === 'bump' && rest.length >= 2) {
    bump(path.resolve(rest[2] || path.join(__dirname, '..')), rest[0], rest[1]);
    return 0;
  }
  console.error('usage: plugin-manifests.cjs --check [root] | bump <plugin> <patch|minor|major|x.y.z> [root]');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
