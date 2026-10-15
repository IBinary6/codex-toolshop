'use strict';

const { GIT_HANDOFF, profileSummary } = require('./agent_profiles');
const { loadDefaults, modelEffortWarnings, readModelCatalog } = require('./config');
const { unresolvedModel, modelFamily } = require('./model_candidates');

const REVIEW_TERMS = [
  '\u5ba1\u67e5', '\u5ba1\u6838', '\u8bc4\u5ba1', 'review', 'audit', 'code review', 'reviewing',
];
const HIGH_RISK_TERMS = [
  '\u5b89\u5168', '\u6f0f\u6d1e', 'security', 'vulnerability', '\u5e76\u53d1', '\u7ade\u6001', 'concurrency',
  'race condition', '\u6743\u9650', '\u6388\u6743', 'permission', 'production', '\u751f\u4ea7',
  '\u7ebf\u4e0a', '\u4e0a\u7ebf\u98ce\u9669', '\u6b7b\u9501', 'deadlock',
];
const HARD_TERMS = [
  '\u56f0\u96be', '\u7591\u96be', '\u590d\u6742\u4efb\u52a1', '\u590d\u6742\u5b9e\u73b0', '\u590d\u6742\u8c03\u8bd5', '\u56f0\u96be\u5b9e\u73b0', 'hard task',
  'hard implementation', 'complex task', 'complex implementation',
  'complex debugging', 'difficult', '\u6027\u80fd\u74f6\u9888', '\u6027\u80fd\u56de\u5f52', '\u5d29\u6e83', 'crash',
  '\u6b7b\u9501', 'deadlock', '\u7ade\u6001', 'race condition',
];
const PLAN_TERMS = [
  '\u67b6\u6784', 'architecture', '\u67b6\u6784\u8bbe\u8ba1', '\u8bbe\u8ba1\u65b9\u6848', '\u65b9\u6848\u8bbe\u8ba1', '\u6280\u672f\u65b9\u6848',
  '\u63a5\u53e3\u8bbe\u8ba1', '\u63a5\u53e3\u5951\u7ea6', 'api contract', 'design', 'plan', '\u89c4\u5212', '\u65b9\u6848',
  '\u8ba1\u5212', '\u51b3\u7b56', 'decision', '\u9009\u578b', '\u7b56\u7565', 'strategy',
];
const IMPLEMENT_TERMS = [
  '\u5b9e\u73b0', 'implement', 'implementation', '\u4fee\u590d', 'fix', 'bug', '\u7f16\u7801',
  '\u4fee\u6539', '\u6539\u52a8', '\u8fc1\u79fb', 'migrate', '\u91cd\u6784', 'refactor', '\u6784\u5efa', 'build',
  '\u5f00\u53d1', 'develop',
];
const DELIVERY_TERMS = [
  '\u5236\u4f5c', '\u4ea7\u51fa', '\u64b0\u5199', '\u7f16\u5199', '\u751f\u6210', '\u6574\u7406', '\u586b\u5165', '\u586b\u8868',
  '\u66f4\u65b0\u6587\u6863', '\u521b\u5efa\u539f\u578b', '\u5236\u4f5c\u539f\u578b', 'produce', 'deliver', 'draft', 'write',
  'create a prototype', 'build a prototype', 'prepare a report', 'create a report',
];
// Delivery and planning share creation verbs. A plan remains a planning deliverable regardless of the verb.
const CREATION_ACTIONS_CN = ['\u5236\u4f5c', '\u4ea7\u51fa', '\u64b0\u5199', '\u7f16\u5199', '\u751f\u6210', '\u521b\u5efa'];
const CREATION_ACTIONS_EN = ['produce', 'draft', 'write', 'create', 'prepare'];
const DELIVERY_ACTION_PATTERN = new RegExp(
  `^(?:\u8bf7|\u5e2e\u6211)?(?:\u6309.{0,30})?(?:${[...CREATION_ACTIONS_CN, '\u4ea4\u4ed8', '\u6574\u7406', '\u586b\u5165', '\u586b\u8868'].join('|')})`
  + `|^(?:please\\s+)?(?:${[...CREATION_ACTIONS_EN, 'deliver'].join('|')})\\b`
);
const PLAN_CREATION_PATTERN = new RegExp(
  `(?:${[...CREATION_ACTIONS_CN, '\u5236\u5b9a', '\u89c4\u5212', '\u62df\u5b9a', '\u8bbe\u8ba1'].join('|')})[^\uff0c\u3002\uff1b,;.!?]{0,30}(?:\u8ba1\u5212|\u65b9\u6848|\u7b56\u7565)`
  + `|\\b(?:${[...CREATION_ACTIONS_EN, 'design'].join('|')})\\b[^\uff0c\u3002\uff1b,;.!?]{0,30}\\b(?:plan|strategy)\\b`
);
const VERIFICATION_TERMS = [
  '\u9a8c\u8bc1', '\u9a8c\u6536', '\u6d4b\u8bd5', '\u590d\u73b0', '\u6838\u9a8c', '\u8d28\u68c0', '\u8d28\u91cf\u68c0\u67e5', 'qa', 'test',
  'verify', 'validate', 'verification', 'acceptance check', 'reproduce',
];
const VERIFICATION_ACTION_TERMS = [
  '\u8fd0\u884c\u6d4b\u8bd5', '\u6267\u884c\u6d4b\u8bd5', '\u5f00\u59cb\u6d4b\u8bd5', '\u6267\u884c\u9a8c\u8bc1', '\u6309\u5df2\u6709\u7528\u4f8b', '\u6309\u65e2\u6709\u7528\u4f8b',
  '\u6309\u7528\u4f8b\u9a8c\u8bc1', '\u9a8c\u8bc1\u7ed3\u679c', '\u9a8c\u8bc1\u4ea4\u4ed8\u7269', 'run tests', 'execute tests',
  'run the tests', 'verify the result', 'validate the deliverable', 'execute qa',
];
const EXTERNAL_RESEARCH_TERMS = [
  '\u5916\u90e8\u7814\u7a76', '\u5916\u90e8\u8c03\u7814', '\u7f51\u7edc\u8c03\u7814', '\u4e92\u8054\u7f51', '\u5b98\u7f51', '\u5b98\u65b9\u6765\u6e90', '\u516c\u5f00\u6765\u6e90',
  '\u6700\u65b0\u8d44\u6599', '\u5e02\u573a\u8c03\u7814', '\u7ade\u54c1', '\u884c\u4e1a\u7814\u7a76', 'web research', 'external research',
  'official sources', 'public sources', 'latest information', 'market research',
  'competitor', 'competitive research',
];
const CODE_CONTEXT_TERMS = [
  '\u4ee3\u7801', '\u6e90\u7801', '\u4ee3\u7801\u4ed3\u5e93', '\u6e90\u7801\u4ed3\u5e93', '\u4ee3\u7801\u5e93', '\u51fd\u6570', '\u4ee3\u7801\u7b26\u53f7', '\u8c03\u7528\u94fe', '\u8c03\u7528\u65b9',
  '\u4ee3\u7801\u5f15\u7528', '\u63a5\u53e3\u5b9e\u73b0', '\u63a5\u53e3\u8fc1\u79fb', '\u4ee3\u7801\u8865\u4e01', '\u4ee3\u7801\u5ba1\u67e5', 'code', 'source code',
  'repository', 'repo', 'function', 'code symbol', 'call chain', 'callers',
  'callees', 'code patch', 'code review', 'source diff',
];
const LOW_COST_LOG_TERMS = [
  '\u65e5\u5fd7', 'log', 'logs', 'trace', 'stack trace', 'stderr', 'stdout', 'dump', 'event log',
];
const LOW_COST_DOCUMENT_TERMS = [
  '\u6587\u6863', 'document', 'documents', 'docs', 'readme', 'markdown', '.md', '.txt',
  'pdf', 'docx', 'doc', 'rtf', 'xml', 'csv', 'json', 'tsv', 'xlsx', 'spreadsheet',
];
const LOW_COST_TEXT_TERMS = ['\u539f\u6587', '\u6587\u672c', 'text', 'transcript'];
const LOW_COST_EXTRACTION_TERMS = [
  '\u63d0\u53d6', '\u62bd\u53d6', '\u6458\u5f55', '\u6574\u7406', '\u6c47\u603b', '\u603b\u7ed3', '\u5f52\u7eb3', '\u8bfb\u53d6', '\u9605\u8bfb',
  '\u8bfb\u5199', '\u5199\u5165', '\u5199', '\u7f16\u8f91', '\u66f4\u65b0', '\u66ff\u6362', '\u4fee\u6539',
  'extract', 'parse', 'summarize', 'summary', 'organize', 'aggregate', 'collect',
  'read', 'write', 'edit', 'update', 'replace',
];
const LOW_COST_CODE_EVIDENCE_TERMS = [
  '\u8c03\u7528\u65b9', '\u8c03\u7528\u5173\u7cfb', '\u5f15\u7528\u5173\u7cfb', '\u5f71\u54cd\u9762', '\u4f9d\u8d56\u5173\u7cfb', '\u6e90\u7801\u68c0\u7d22', '\u4ee3\u7801\u68c0\u7d22', '\u53d6\u8bc1',
  'callers', 'callees', 'call chain', 'reference graph', 'impact radius', 'source search',
  'code search', 'depends on',
];
const LOW_COST_CODE_TEST_TERMS = [
  'ctest', '\u5355\u5143\u6d4b\u8bd5', '\u56de\u5f52\u6d4b\u8bd5', 'unit test', 'unit tests', 'regression test',
  'regression tests', '\u4ee3\u7801\u6d4b\u8bd5', '\u6e90\u7801\u6d4b\u8bd5', 'npm test', 'cargo test', 'pytest',
];
const LOW_COST_ESTABLISHED_TEST_TERMS = [
  '\u65e2\u5b9a\u6d4b\u8bd5', '\u73b0\u6709\u6d4b\u8bd5', '\u5df2\u6709\u6d4b\u8bd5', 'approved test', 'existing test',
];
const LOW_COST_TEST_EXECUTION_TERMS = [
  '\u8fd0\u884c', '\u6267\u884c', '\u5f00\u59cb', '\u9a8c\u8bc1', '\u9a8c\u6536', '\u6838\u9a8c', 'run', 'execute', 'perform',
  'verify', 'validate', 'check',
];
const CODE_CREATION_ACTION_TERMS = [
  '\u5b9e\u73b0', '\u7f16\u5199', '\u5199', '\u521b\u5efa', '\u65b0\u589e', '\u589e\u52a0', '\u751f\u6210', '\u66f4\u65b0', '\u4fee\u6539', '\u6784\u5efa', '\u5f00\u53d1', '\u7f16\u7801',
  'implement', 'write', 'create', 'add', 'generate', 'update', 'modify', 'build', 'develop',
];
const CODE_CREATION_ARTIFACT_TERMS = [
  '\u4ee3\u7801', '\u6e90\u7801', '\u89e3\u6790\u5668', '\u5904\u7406\u5668', '\u51fd\u6570', '\u65b9\u6cd5', '\u6a21\u5757', '\u7c7b', '\u7ec4\u4ef6', '\u670d\u52a1',
  '\u811a\u672c', '\u7b97\u6cd5', '\u6d4b\u8bd5\u4ee3\u7801', 'parser', 'processor', 'handler', 'function', 'method', 'module',
  'class', 'component', 'service', 'script', 'algorithm', 'test code',
];
const MATERIAL_OPERATION_TERMS = [
  '\u5df2\u6709', '\u73b0\u6709', '\u8fd9\u4e9b', '\u6307\u5b9a', '\u7ed9\u5b9a', '\u6a21\u677f', '\u539f\u683c\u5f0f', '\u5b57\u6bb5', '\u7248\u672c\u53f7', '\u6279\u91cf',
  '\u4fdd\u7559', 'existing', 'specified', 'given', 'template', 'original format', 'field',
  'version', 'batch', 'preserve',
];
const DOCUMENT_WRITE_TERMS = [
  '\u5199\u5165', '\u5199', '\u7f16\u8f91', '\u66f4\u65b0', '\u66ff\u6362', '\u4fee\u6539', 'write', 'edit', 'update', 'replace', 'modify',
];
const LOOKUP_TERMS = [
  '\u67e5\u627e', '\u641c\u7d22', '\u641c\u5bfb', '\u68c0\u7d22', '\u5b9a\u4f4d', '\u67e5\u8be2', '\u8c03\u67e5', '\u7814\u7a76', '\u626b\u63cf', '\u68b3\u7406',
  'find', 'search', 'retrieve', 'retrieval', 'lookup', 'investigate', 'investigation', 'research', 'scan',
];
const CROSS_FILE_TERMS = [
  '\u8de8\u6587\u4ef6', '\u591a\u6587\u4ef6', '\u591a\u4e2a\u6587\u4ef6', '\u8c03\u7528\u94fe', '\u5f15\u7528\u5173\u7cfb', '\u5f71\u54cd\u9762', '\u4f9d\u8d56\u94fe',
  '\u6a21\u5757\u4f9d\u8d56', '\u4f9d\u8d56\u5173\u7cfb', 'cross-file', 'multiple files', 'call chain',
  'reference graph', 'impact radius', 'callers', 'callees', 'depends on', 'dependencies',
];
const BROAD_SCAN_TERMS = [
  '\u8de8\u6a21\u5757', '\u5168\u4ed3', '\u5168\u4ed3\u5e93', '\u5168\u5c40\u626b\u63cf', '\u5168\u9762\u626b\u63cf', '\u5e7f\u6cdb\u626b\u63cf', '\u5927\u8303\u56f4',
  '\u8bfb\u91cd\u578b', '\u5927\u578b\u626b\u63cf', 'repository-wide', 'cross-module', 'broad scan',
  'wide scan', 'large-scale', 'read-heavy', 'massive scan', 'entire repository',
];
const SINGLE_LOOKUP_TERMS = [
  '\u5355\u7b26\u53f7', '\u5355\u4e2a\u7b26\u53f7', '\u5355\u6587\u4ef6', '\u5355\u4e2a\u6587\u4ef6', '\u67d0\u4e2a\u51fd\u6570', '\u8fd9\u4e2a\u51fd\u6570', '\u8fd9\u4e2a\u6587\u4ef6',
  'single symbol', 'single file', 'one symbol', 'one file', 'this function', 'this file',
];
const NON_TRIVIAL_PLAN_TERMS = [
  '\u67b6\u6784', 'architecture', '\u63a5\u53e3\u8bbe\u8ba1', '\u63a5\u53e3\u5951\u7ea6', 'api contract', '\u6280\u672f\u65b9\u6848',
  '\u9009\u578b', '\u51b3\u7b56', 'decision', '\u6743\u8861', 'tradeoff', '\u8fc1\u79fb\u65b9\u6848', '\u8de8\u6a21\u5757',
  '\u591a\u9636\u6bb5', 'multi-stage', '\u5236\u5b9a\u8ba1\u5212', '\u5148\u8ba1\u5212', '\u5f00\u53d1\u8ba1\u5212', '\u5b9e\u73b0\u8ba1\u5212',
  '\u6d4b\u8bd5\u8ba1\u5212', '\u9a8c\u6536\u6807\u51c6', '\u7b56\u7565', 'strategy', '\u53ef\u884c\u6027', 'plan first',
  'plan then', 'implementation plan', 'test plan', 'acceptance criteria',
];
const TRIVIAL_EDIT_TERMS = [
  'getter', 'setter', '\u62fc\u5199', 'typo', '\u52a0\u4e2a\u6ce8\u91ca', '\u6dfb\u52a0\u6ce8\u91ca', '\u8865\u4e2a\u6ce8\u91ca',
  '\u7c7b\u578b\u5b9a\u4e49', '\u8fd9\u4e00\u884c', '\u4e00\u884c\u4ee3\u7801', '\u5355\u884c\u4fee\u6539', 'one-line', 'single-line',
];
const REVIEW_FEEDBACK_GUIDANCE = 'The primary agent accepts and integrates deliverables. After proportionate validation, independently review substantive work. If the user restricts reviewers, the primary agent reviews and states the scope. Only concrete issues affecting acceptance, after verification by the primary agent, warrant a bounded fix by the original writer and another review; advisory notes do not automatically trigger rework or a stop.';
const PROMPT_ROUTE_NOTICE = 'Agent Dispatch candidate suggestion (inferred from this message only): check the full conversation and latest explicit user instructions. This is neither a host restriction nor a persistent constraint.';

function taskScopeGuidance(language = 'en') {
  return 'Infer the current task from the full conversation and the latest explicit user instructions. Product behavior and quoted material are not task restrictions. Agent Dispatch keyword routes are fallible suggestions, not host restrictions or persistent task state. A later turn with no routing hint does not preserve an earlier route; continue the authorized objective while retaining actual user constraints that have not been changed.';
}

function modelSelectionGuidance(language = 'en') {
  return 'Use Luna for bounded extraction, lookups, logs, and established test evidence. Use Sol high for code, substantive document interpretation, planning, and ordinary independent review when supported. Family defaults resolve to the newest visible numeric model version supporting the requested effort in a fresh host catalog; retain explicit full-ID pins. Choose model and effort together: effort levels are not equivalent across model families. Reserve Astra for critical review decisions or exceptionally complex reasoning when the primary agent judges the benefit worth the total cost; keywords alone do not require escalation. Complex computer interaction may justify Sol max after checking host support. Do not escalate to max or ultra merely because a task mentions review or risk. Model catalogs are compatibility hints, not proof of account access; verify the actual loaded role and pair before spawning. For an unresolved family, refresh the catalog or use a generic role with an explicit host-supported full model ID and effort; never pass a family alias to native model APIs or silently inherit the parent model.';
}

function codeImplementationPair(config) {
  const configured = config?.agent_profiles?.profiles?.dispatch_sol_worker;
  if (configured && typeof configured.model === 'string' && configured.model.trim()
      && !/(?:^|[._-])luna(?:$|[._-])/i.test(configured.model)
      && typeof configured.model_reasoning_effort === 'string'
      && configured.model_reasoning_effort.trim()) {
    return `${configured.model.trim()}/${configured.model_reasoning_effort.trim()}`;
  }
  const fallback = loadDefaults().agent_profiles.profiles.dispatch_sol_worker;
  return `${fallback.model}/${fallback.model_reasoning_effort}`;
}

function reviewLifecycleGuidance(language = 'en', subagent = false) {
  if (subagent) {
    return 'If assigned a review but the actual model/effort differs from the target or cannot be observed, preserve supporting evidence and report to the primary agent. Do not claim the review passed or delegate it yourself.';
  }
  return 'For every new or reused review agent, reassess its responsibility and autonomously choose a supported model/effort from effective enabled reviewer candidates based on ambiguity, risk, quality needs, and total completion cost; explicit user requirements take precedence. Reassess when scope or risk changes. Judging correctness, compatibility, defects, or acceptance is review even for small, read-only, or follow-up checks; small scope alone does not justify the low-cost evidence route. Keywords are routing hints, not a substitute for task judgment. Fixed profile values override spawn arguments, and a task name is not evidence of the actual model. Before spawning, verify host support and actual profile loading. Before accepting the conclusion, check observable host model/effort metadata; if unavailable, mark it unconfirmed. Reuse only a matching current pair: a message cannot change an existing agent model. Honor primary-only requests and disabled review delegation. When an enabled reviewer target exists but its named role is not loaded, use a supported generic spawn with the selected pair or the primary agent. Evidence collection and established test results do not by themselves constitute an independent review. These hooks provide guidance, not a hard spawn interceptor.';
}

function reviewFeedbackGuidance() {
  return `${REVIEW_FEEDBACK_GUIDANCE} ${reviewLifecycleGuidance()}`;
}

function includesAny(text, terms) {
  return terms.some((term) => {
    if (!/^[a-z][a-z -]*$/i.test(term)) return text.includes(term);
    return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  });
}

function normalizedPrompt(prompt) {
  return typeof prompt === 'string' ? prompt.trim().toLowerCase() : '';
}

/**
 * Split a command line at unquoted `&&`, `||` and `;`. Returns null when the text holds anything else a shell would act
 * on: a newline, a pipe, a redirect, a background `&`, a subshell, or a command substitution (also inside double quotes).
 * @example simpleCommands('git add . && git commit -m "a | b"') // ['git add .', 'git commit -m "a | b"']
 */
function simpleCommands(text) {
  const segments = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = '';
      current += char;
      continue;
    }
    if (char === '`' || (char === '$' && text[index + 1] === '(')) return null;
    if (char === '\\') {
      current += char + (text[index + 1] || '');
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = '';
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/[\n\r<>()]/.test(char)) return null;
    if (char === ';' || ((char === '&' || char === '|') && text[index + 1] === char)) {
      segments.push(current);
      current = '';
      if (char !== ';') index += 1;
      continue;
    }
    if (char === '&' || char === '|') return null;
    current += char;
  }
  if (quote) return null;
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function isPureGitCli(prompt) {
  const command = typeof prompt === 'string' ? prompt.trim() : '';
  const segments = command ? simpleCommands(command) : null;
  return Boolean(segments && segments.length > 0
    && segments.every((segment) => /^(?:"(?:[^"]*[\\/])?git(?:\.exe)?"|(?:\S*[\\/])?git(?:\.exe)?)(?:\s|$)/i.test(segment)));
}

function configuredKeywordMatch(text, config) {
  const keywords = config && config.whitelist && Array.isArray(config.whitelist.prompt_keywords)
    ? config.whitelist.prompt_keywords
    : [];
  return keywords.some((keyword) => {
    const value = String(keyword || '').trim().toLowerCase();
    return value && text.includes(value);
  });
}

function profileEnabled(config, name) {
  const settings = config && config.agent_profiles;
  if (!settings || settings.enabled === false || !settings.profiles) return false;
  const profile = settings.profiles[name];
  return Boolean(profile && profile.enabled !== false && !unresolvedModel(profile));
}

function firstEnabled(config, names) {
  return names.find((name) => profileEnabled(config, name)) || '';
}

function profileLabel(config, name) {
  const profile = config.agent_profiles.profiles[name];
  const model = typeof profile.model === 'string' && profile.model.trim()
    ? profile.model.trim()
    : 'inherit';
  const effort = typeof profile.model_reasoning_effort === 'string'
    && profile.model_reasoning_effort.trim()
    ? profile.model_reasoning_effort.trim()
    : 'inherit';
  return `${name} (${model}/${effort})`;
}

function lowCostPolicy(config) {
  const defaults = {
    enabled: true,
    model: 'luna',
    effort: 'max',
  };
  const configured = config && config.policy && config.policy.low_cost;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    return defaults;
  }
  return {
    enabled: configured.enabled !== false,
    model: typeof configured.model === 'string' ? configured.model.trim() : defaults.model,
    effort: typeof configured.model_reasoning_effort === 'string'
      ? configured.model_reasoning_effort.trim() : defaults.effort,
  };
}

function profileSettings(config, name) {
  const settings = config && config.agent_profiles;
  if (!settings || settings.enabled === false || !settings.profiles) return null;
  const profile = settings.profiles[name];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
      || profile.enabled === false || unresolvedModel(profile) || profile.role_kind === 'verification') {
    return null;
  }
  const model = typeof profile.model === 'string' ? profile.model.trim() : '';
  const effort = typeof profile.model_reasoning_effort === 'string'
    ? profile.model_reasoning_effort.trim() : '';
  return { model, effort };
}

/**
 * Prefer a Luna worker pinned to the low-cost target; otherwise use an unpinned
 * worker and require the primary agent to pass the target model and effort.
 *
 * @example lowCostCandidate(config)
 */
function lowCostCandidate(config) {
  const target = lowCostPolicy(config);
  // An explicit pair may need host verification without being invalid. Reject only
  // unresolved/inherited targets or incompatibility established by a fresh catalog.
  if (!target.enabled || !target.model || !target.effort || modelFamily(target.model)) return null;
  const supported = readModelCatalog()?.get(target.model);
  if (supported && !supported.has(target.effort)) return null;
  const supportUnconfirmed = !supported;

  const luna = profileSettings(config, 'dispatch_luna_worker');
  if (luna && luna.model === target.model && luna.effort === target.effort) {
    return { name: 'dispatch_luna_worker', model: target.model, effort: target.effort, explicit: false, supportUnconfirmed };
  }

  const worker = profileSettings(config, 'dispatch_worker');
  if (worker && ((worker.model === target.model && worker.effort === target.effort)
      || (!worker.model && !worker.effort))) {
    return {
      name: 'dispatch_worker',
      model: target.model,
      effort: target.effort,
      explicit: !(worker.model === target.model && worker.effort === target.effort),
      supportUnconfirmed,
    };
  }
  return null;
}

function lowCostLabel(candidate) {
  if (!candidate) return '';
  const pair = `${candidate.model}/${candidate.effort}`;
  const label = candidate.explicit
    ? `${candidate.name} (explicit ${pair})`
    : `${candidate.name} (${pair})`;
  return label + (candidate.supportUnconfirmed
    ? ' (catalog support unconfirmed; verify host support before spawning)' : '');
}

function lowCostKindLabel(kind) {
  return {
    logs: 'log retrieval and excerpts',
    documents: 'routine document editing and text organization',
    'structured-data': 'routine structured-data organization',
    'established-tests': 'established code tests and failure evidence',
    'code-evidence': 'code search and call evidence',
  }[kind] || 'routine evidence work';
}

function lowCostGuidance(route, config) {
  const policy = lowCostPolicy(config);
  const candidate = lowCostCandidate(config);
  const kind = lowCostKindLabel(route.lowCostKind);
  if (!candidate) {
    return `Task route: low-cost ${kind}. No enabled low-cost role matches ${policy.model}/${policy.effort}. Do not silently use a more expensive model. If this evidence subtask is needed, narrow it or report the blocker without passing lengthy source material to the primary agent; the primary agent continues independent authorized work.`;
  }
  const scope = route.readOnly
    ? 'must stay read-only and return only necessary evidence'
    : route.lowCostKind === 'documents'
      ? 'may edit only the specified files and fields'
      : route.lowCostKind === 'structured-data'
        ? 'may process only specified fields and records while preserving sources and deduplication evidence'
    : route.lowCostKind === 'established-tests'
      ? 'may run only established cases and may not change the deliverable or product code'
      : 'must stay read-only and return only necessary evidence';
  return `Task route: low-cost ${kind}. If the responsibility matches, prefer ${lowCostLabel(candidate)}. The assigned subtask ${scope}; return evidence locations, necessary excerpts, validation, and blockers rather than full source documents. The primary agent remains responsible for scope, authority, and integration, and checks user preferences and actual host model/effort support before delegating.`;
}

function lowCostEvidenceGuidance(route, config) {
  if (!route.lowCostEvidence || !route.lowCostKind) return '';
  const policy = lowCostPolicy(config);
  const candidate = lowCostCandidate(config);
  const kind = lowCostKindLabel(route.lowCostKind);
  if (!candidate) {
    return ` The task contains separable ${kind} evidence, but no low-cost role matches ${policy.model}/${policy.effort}; keep it as a bounded evidence subtask or defer it. Do not silently use a more expensive model or downgrade the whole task.`;
  }
  return ` The ${kind} portion can be assigned to ${lowCostLabel(candidate)} for necessary evidence; the primary agent chooses the appropriate roles for complex implementation, key plans, and code review. Do not downgrade the whole task.`;
}

function roleFallback(config, names) {
  const selected = firstEnabled(config, names);
  if (!selected) {
    return 'The primary agent handles this directly (no matching role is enabled).';
  }
  const index = names.indexOf(selected);
  const lowerCost = names.slice(index + 1).filter((name) => profileEnabled(config, name));
  const fallback = lowerCost.length
    ? `${lowerCost.join(' or ')} or the primary agent`
    : 'the primary agent';
  return `For an independent bounded subtask, consider ${profileLabel(config, selected)}. The primary agent decides whether delegation helps, considering context and explicit user preferences. Verify actual host model/effort support first; if the default pair is unavailable, consider ${fallback}. Do not silently replace a model explicitly requested by the user.`;
}

/**
 * Describe dynamic writer selection without fixing a model or effort in the hook.
 *
 * @example
 * dynamicWriterGuidance(config);
 */
function dynamicWriterGuidance(config, options = {}) {
  const codeWork = options.codeWork === true;
  const profiles = config && config.agent_profiles && config.agent_profiles.profiles;
  const settingsEnabled = config && config.agent_profiles
    && config.agent_profiles.enabled !== false && profiles;
  const eligible = (name) => {
    if (!settingsEnabled) return null;
    const profile = profiles[name];
    if (!profile || profile.enabled === false || unresolvedModel(profile)
        || ['labor', 'verification'].includes(profile.role_kind)
        || profile.sandbox_mode !== 'workspace-write') return null;
    const model = typeof profile.model === 'string' ? profile.model.trim() : '';
    const effort = typeof profile.model_reasoning_effort === 'string'
      ? profile.model_reasoning_effort.trim() : '';
    if (codeWork && /(?:^|[._-])luna(?:$|[._-])/i.test(model)) return null;
    return { name, model, effort };
  };
  if (codeWork) {
    const sol = eligible('dispatch_sol_worker');
    const pair = codeImplementationPair(config);
    const defaultCandidate = sol && sol.model && sol.effort
      ? sol
      : ['dispatch_worker', 'dispatch_hard_worker']
        .map(eligible)
        .find((profile) => profile && !profile.model && !profile.effort);
    const alternatives = ['dispatch_astra_worker', 'dispatch_hard_worker']
      .map(eligible)
      .filter((profile) => profile && profile.name !== (defaultCandidate && defaultCandidate.name || ''))
      .map((profile) => profile.model && profile.effort
        ? `${profile.name} (${profile.model}/${profile.effort})`
        : `${profile.name} (select a supported pair explicitly)`);
    if (!defaultCandidate) {
      const alternativeGuidance = alternatives.length
        ? `, or choose an enabled alternative ${alternatives.join(', ')} based on task complexity and explicit user preference`
        : '';
      return `No code implementation candidate matches the effective ${pair} pair. The primary agent handles the work${alternativeGuidance}.`;
    }
    const defaultLabel = defaultCandidate.model
      ? `${defaultCandidate.name} (${defaultCandidate.model}/${defaultCandidate.effort})`
      : modelFamily(pair.split('/')[0])
        ? `${defaultCandidate.name} (select a host-supported full model ID and effort explicitly; ${pair} family target unresolved)`
        : `${defaultCandidate.name} (explicit ${pair})`;
    const alternativeGuidance = alternatives.length
      ? `; when complexity or explicit user preference warrants it, choose among enabled alternatives ${alternatives.join(', ')}`
      : '';
    return `The default writable code implementation candidate is ${defaultLabel}${alternativeGuidance}. Choose model and effort for the actual task; use Astra only when the primary agent judges its cost worthwhile for critical complexity. Effective pinned profile settings take precedence; pass model and effort explicitly for unpinned roles. Verify host support before spawning. If the role is not loaded, use an unpinned role with a supported explicit pair or have the primary agent handle it.`;
  }
  const hasWritableProfile = Object.keys(profiles || {}).some((name) => eligible(name));
  if (!hasWritableProfile) return 'No writable execution role is enabled; the primary agent handles the work directly.';
  return 'The primary agent chooses an enabled writable role, model, and effort based on actual complexity, without fixing a model by domain keyword. An unpinned writer must receive explicit model and effort to avoid inheriting an expensive primary model.';
}

function exactNarrowLookup(text) {
  return includesAny(text, LOOKUP_TERMS)
    && includesAny(text, SINGLE_LOOKUP_TERMS)
    && !includesAny(text, CROSS_FILE_TERMS)
    && !includesAny(text, BROAD_SCAN_TERMS);
}

function detectLowCostKind(text, explicitCodeContext, lookup, crossFile, codeCreationIntent) {
  const hasLogs = includesAny(text, LOW_COST_LOG_TERMS);
  const hasDocuments = includesAny(text, LOW_COST_DOCUMENT_TERMS);
  const hasStructuredData = includesAny(text, ['csv', 'json', 'tsv', 'xlsx', 'spreadsheet']);
  const hasText = includesAny(text, LOW_COST_TEXT_TERMS);
  const hasExtractionAction = includesAny(text, LOW_COST_EXTRACTION_TERMS)
    || includesAny(text, ['\u67e5\u770b', '\u5206\u6790', '\u8fd0\u884c', '\u6267\u884c', 'inspect', 'review']);
  const codeEvidence = explicitCodeContext
    && (lookup || crossFile || includesAny(text, LOW_COST_CODE_EVIDENCE_TERMS));
  const testExecution = includesAny(text, LOW_COST_TEST_EXECUTION_TERMS);
  const explicitCodeTest = includesAny(text, LOW_COST_CODE_TEST_TERMS);
  const establishedTestWithCodeContext = includesAny(text, LOW_COST_ESTABLISHED_TEST_TERMS)
    && explicitCodeContext
    && includesAny(text, ['\u6d4b\u8bd5', '\u7528\u4f8b', 'test', 'case', 'qa']);
  if (hasLogs && (hasExtractionAction || lookup
      || includesAny(text, ['\u4fee\u590d', '\u6392\u67e5', 'debug', 'fix', 'crash', 'error']))) return 'logs';
  if (codeEvidence) return 'code-evidence';
  if (!codeCreationIntent && testExecution && (explicitCodeTest || establishedTestWithCodeContext)) {
    return 'established-tests';
  }
  if (codeCreationIntent) return '';
  if (hasStructuredData && hasExtractionAction) return 'structured-data';
  if ((hasDocuments || hasText) && hasExtractionAction) return 'documents';
  return '';
}

/** Detect direct read-only task instructions without treating product behavior as a global scope limit. */
function hasReadOnlyDirective(text) {
  // A read-only cue must start a request clause; arbitrary product text cannot set task permissions.
  // This remains a routing heuristic. The primary agent decides scope from the full conversation.
  const prose = text.replace(/```[^]*?```|~~~[^]*?~~~/g, '')
    .replace(/^\s*>.*$/gm, '');
  return prose.split(/[\uff0c\u3002\uff01\uff1f\uff1b,.!?;\n]+/).some((clause) => {
    const directive = clause.trim()
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/^(?:(?:\u8bf7(?:\u4f60)?|\u5148|\u6682\u65f6|\u672c\u6b21|\u672c\u8f6e|\u8fd9\u6b21|\u4f60)\s*)+/, '')
      .replace(/^(?:(?:please|for now)\s+)+/, '');
    return /^(?:\u53ea\u8bfb(?=$|\s|[\uff1a:]|\u5206\u6790|\u8bca\u65ad|\u5ba1\u67e5|\u8c03\u67e5|\u68c0\u67e5|\u67e5\u770b|\u8bfb\u53d6|\u6392\u67e5)|(?:\u4ec5|\u53ea)(?:\u5206\u6790|\u8bca\u65ad|\u5ba1\u67e5|\u8c03\u67e5)|(?:\u4e0d\u8981|\u7981\u6b62|\u4e0d\u5141\u8bb8|\u4e0d\u5f97|\u4e0d)(?:\u4fee\u6539|\u6539\u52a8|\u7f16\u8f91|\u5199\u5165|\u6539))/.test(directive)
      || /^(?:read[- ]only(?:$|\s+(?:analysis|diagnosis|review|inspection|investigation)\b)|do not (?:edit|modify|write)\b|don't (?:edit|modify|write)\b|diagnosis only\b)/.test(directive);
  });
}

/** Extract routing scope cues; these heuristics do not authorize writes or delegation. */
function promptConstraints(text) {
  const primaryOnly = /\u53ea(?:\u7528|\u7531|\u8ba9)?\u4e3b\u4ee3\u7406|\u4ec5(?:\u7528|\u7531|\u8ba9)?\u4e3b\u4ee3\u7406|(?:\u4e0d\u8981|\u7981\u6b62|\u4e0d\u7528|\u4e0d\u5141\u8bb8)(?:\u518d)?(?:\u59d4\u6d3e|\u5206\u6d3e|\u5b50\u4ee3\u7406|\u5b50\u4efb\u52a1)|\b(?:primary agent only|main agent only|no subagents?|no delegation|do not delegate|don't delegate)\b/.test(text);
  const limitedAgents = /(?:\u53ea|\u4ec5|\u6700\u591a).{0,8}(?:\u4e00\u4e2a|\u4e00\u540d|1 \u4e2a|1\u540d)(?:\u5b50)?\u4ee3\u7406|\u4e0d\u8981\u591a\u4e2a\u4ee3\u7406|\u4e0d\u8981\u5e76\u884c|\b(?:only one agent|at most one subagent|no parallel agents|do not parallelize)\b/.test(text);
  const explicitReadOnly = hasReadOnlyDirective(text);
  const writeIntent = /\u5b9e\u73b0|\u4fee\u590d|\u8fc1\u79fb|\u91cd\u6784|\u7f16\u7801|\b(?:implement|fix|migrate|refactor|edit|modify|develop)\b/.test(text);
  const diagnosis = /\u8bca\u65ad|\u6392\u67e5|\u6839\u56e0|\b(?:diagnos\w*|investigate|root cause|debug)\b/.test(text);
  const existingPlan = /(?:(?:\u5df2\u6709|\u73b0\u6709|\u5df2\u6279\u51c6|\u5df2\u786e\u8ba4|\u6279\u51c6\u7684|\u786e\u8ba4\u7684)(?:\u5b9e\u73b0|\u6267\u884c|\u6d4b\u8bd5|\u9a8c\u8bc1|\u8bbe\u8ba1)?(?:\u8ba1\u5212|\u65b9\u6848|\u7528\u4f8b))|\u4e0d\u8981\u91cd\u65b0\u89c4\u5212|\u65e0\u9700\u91cd\u65b0\u89c4\u5212|\b(?:(?:existing|approved) (?:(?:implementation|execution|test|qa|design) )?(?:plan|cases?)|do not replan|don't replan)\b/.test(text);
  const narrow = /(?:\u53ea|\u4ec5).{0,12}(?:\u4e00\u4e2a|\u5355\u4e2a|\u5355|\u8fd9\u4e2a)\u6587\u4ef6|\u5355\u6587\u4ef6|\b(?:one file|single file|this file only)\b/.test(text);
  const wordingOnly = /(?:\u62fc\u5199|\u63aa\u8f9e|\u6807\u70b9|\b(?:spelling|wording|typo|punctuation)\b)/.test(text)
    && /readme|changelog|markdown|\u6587\u6863|\u6ce8\u91ca|\b(?:docs?|comments?)\b/.test(text)
    && /\u4ec5|\u53ea|\bonly\b/.test(text);
  return { primaryOnly, limitedAgents, readOnly: explicitReadOnly || (diagnosis && !writeIntent), existingPlan, narrow, wordingOnly };
}

/** Suggest a route by scope, intent, and risk without spawning an agent. @example routePrompt('find callers', config) */
function routePrompt(prompt, config) {
  const text = normalizedPrompt(prompt);
  if (!text) {
    return { category: 'generic', route: 'generic', shouldDispatch: false };
  }

  // Git CLI arguments such as "fix", "review", or "architecture" are data,
  // not task intent. Suppress routing only for a safely parsed, all-Git
  // command; a non-Git natural-language prefix or mixed shell stays routable.
  if (isPureGitCli(prompt)) {
    return {
      category: 'generic',
      route: 'generic',
      shouldDispatch: false,
      reason: 'pure Git CLI command',
    };
  }

  const constraints = promptConstraints(text);
  const regressionReview = /\b(?:inspect|check)\b.{0,40}\b(?:patch|changes?|diff)\b.{0,30}\bregressions?\b/.test(text);
  const codeRegressionReview = /\b(?:inspect|check)\b.{0,40}\b(?:patch|diff)\b.{0,30}\bregressions?\b/.test(text);
  const review = includesAny(text, REVIEW_TERMS) || regressionReview;
  const highRisk = !constraints.wordingOnly && includesAny(text, HIGH_RISK_TERMS);
  const hardSignal = includesAny(text, HARD_TERMS)
    || (includesAny(text, ['\u8c03\u8bd5', 'debug', '\u6392\u67e5', 'diagnose'])
      && includesAny(text, ['\u590d\u6742', '\u7591\u96be', '\u56f0\u96be', 'complex', 'difficult', 'hard']));
  const plan = includesAny(text, PLAN_TERMS);
  const lookup = includesAny(text, LOOKUP_TERMS);
  const broad = includesAny(text, BROAD_SCAN_TERMS);
  const crossFile = includesAny(text, CROSS_FILE_TERMS);
  const hasImplementationTerm = includesAny(text, IMPLEMENT_TERMS);
  const designDeliverable = includesAny(text, ['\u539f\u578b', '\u7ebf\u6846\u56fe', '\u6210\u7a3f', 'prototype', 'mockup', 'wireframe'])
    && includesAny(text, ['\u5236\u4f5c', '\u521b\u5efa', '\u751f\u6210', '\u8bbe\u8ba1', 'produce', 'create', 'build', 'design']);
  const explicitDeliveryAction = DELIVERY_ACTION_PATTERN.test(text);
  const delivery = !constraints.readOnly
    && (includesAny(text, DELIVERY_TERMS) || designDeliverable || explicitDeliveryAction);
  const directVerification = /^(?:\u8bf7)?(?:\u9a8c\u8bc1|\u6838\u9a8c|\u9a8c\u6536|\u6d4b\u8bd5|\u590d\u73b0)/.test(text)
    || /^(?:please\s+)?(?:verify|validate|test|reproduce)\b/.test(text);
  const verification = includesAny(text, VERIFICATION_TERMS)
    && (includesAny(text, VERIFICATION_ACTION_TERMS)
      || directVerification
      || /(?:\u6309|\u4f9d\u636e|\u4f9d\u7167|\u4f7f\u7528|\u8fd0\u884c|\u6267\u884c|run|execute|perform|use).{0,30}(?:\u7528\u4f8b|\u6d4b\u8bd5|\u9a8c\u8bc1|\u9a8c\u6536|cases?|tests?|qa|verification)/.test(text));
  const explicitModificationAction = /^(?:\u8bf7|\u5e2e\u6211)?(?:\u5b9e\u73b0|\u4fee\u590d|\u4fee\u6539|\u6539\u52a8|\u8fc1\u79fb|\u91cd\u6784|\u7f16\u7801|\u5f00\u53d1)/.test(text)
    || /(?:\u5e76|\u7136\u540e|\u518d|\u4e4b\u540e|\u540e|[\uff0c,;\uff1b])\s*(?:\u518d)?(?:\u5b9e\u73b0|\u4fee\u590d|\u4fee\u6539|\u6539\u52a8|\u8fc1\u79fb|\u91cd\u6784|\u7f16\u7801|\u5f00\u53d1)/.test(text)
    || /^(?:please\s+)?(?:implement|fix|modify|edit|migrate|refactor|develop)\b/.test(text)
    || /\b(?:and|then|after that)\s+(?:implement|fix|modify|edit|migrate|refactor|develop)\b/.test(text);
  const testImplementation = /(?:\u5199|\u7f16\u5199|\u6dfb\u52a0|\u8865|\u8865\u5145|\u65b0\u589e|\u589e\u52a0|\u66f4\u65b0|\u4fee\u6539|\u8986\u76d6).{0,8}(?:\u5355\u5143\u6d4b\u8bd5|\u56de\u5f52\u6d4b\u8bd5|\u6d4b\u8bd5\u7528\u4f8b|\u6d4b\u8bd5\u4ee3\u7801|\u4ee3\u7801\u6d4b\u8bd5|\u6e90\u7801\u6d4b\u8bd5)/.test(text)
    || /(?:\u5199|\u7f16\u5199|\u6dfb\u52a0|\u8865\u5145|\u65b0\u589e)\s*\u6d4b\u8bd5(?:$|[\uff0c\u3002,.]|\u4ee3\u7801|\u8986\u76d6)/.test(text)
    || /\b(?:write|add|cover|implement)\b.{0,24}\b(?:unit tests?|regression tests?|test cases?|code tests?)\b/i.test(text);
  const codeCreationIntent = !constraints.readOnly
    && includesAny(text, CODE_CREATION_ACTION_TERMS)
    && includesAny(text, CODE_CREATION_ARTIFACT_TERMS);
  const hard = hardSignal || ((testImplementation || codeCreationIntent)
    && includesAny(text, ['\u590d\u6742', '\u7591\u96be', '\u56f0\u96be', 'complex', 'difficult', 'hard']));
  const modificationIntent = explicitModificationAction || includesAny(text, [
    '\u5b9e\u73b0', '\u4fee\u590d', '\u4fee\u6539', '\u6539\u52a8', '\u8fc1\u79fb', '\u91cd\u6784', '\u7f16\u7801', '\u5f00\u53d1',
    'implement', 'fix', 'modify', 'edit', 'migrate', 'refactor', 'develop',
  ]) || testImplementation || codeCreationIntent;
  const implementation = !constraints.readOnly && (hasImplementationTerm || testImplementation || codeCreationIntent)
    && (!verification || explicitModificationAction);
  const externalResearch = includesAny(text, EXTERNAL_RESEARCH_TERMS)
    && includesAny(text, [...LOOKUP_TERMS, '\u8c03\u7814', '\u6838\u5bf9', '\u6bd4\u8f83', 'compare', 'verify']);
  const inspectArchitecture = /(?:\u5206\u6790|\u68b3\u7406|\u4e86\u89e3|\u89e3\u91ca).{0,20}(?:\u67b6\u6784|\u6a21\u5757)|\b(?:explain|inspect|map|understand)\b.{0,30}\b(?:architecture|modules?)\b/.test(text);
  const createsPlan = PLAN_CREATION_PATTERN.test(text);
  const executesPlan = /(?:\u6267\u884c|\u843d\u5b9e|\u8fd0\u884c|\u6309|\u4f9d\u636e|\u4f9d\u7167|follow|execute|run|carry out).{0,30}(?:\u8ba1\u5212|\u65b9\u6848|plan)/.test(text);
  const planCreation = !constraints.existingPlan
    && (!lookup || createsPlan)
    && (!executesPlan || createsPlan);
  const nonTrivialPlan = plan && (!delivery || createsPlan) && !constraints.existingPlan && !inspectArchitecture && (
    text.length >= 80
    || includesAny(text, NON_TRIVIAL_PLAN_TERMS)
    || crossFile
    || broad
  ) && planCreation;

  const explicitCodeContext = includesAny(text, CODE_CONTEXT_TERMS)
    || codeRegressionReview
    || /\b[a-z_][a-z0-9_.:-]*\s+module\b|\b[a-z_][a-z0-9_.:-]*\s+\u6a21\u5757/i.test(text);
  const lowCostKind = detectLowCostKind(text, explicitCodeContext, lookup, crossFile, codeCreationIntent);
  const policyDiscussion = (
    includesAny(text, ['agent dispatch', 'agentdispatch', '\u8c03\u5ea6', '\u8def\u7531', '\u5206\u6d3e', '\u59d4\u6d3e'])
    && includesAny(text, ['\u914d\u7f6e', '\u4f18\u5316', '\u8ba8\u8bba', '\u7b56\u7565', '\u89c4\u5219', '\u8bbe\u7f6e', '\u4ea4\u7ed9', 'policy', 'configure', 'configuration'])
  ) || (
    includesAny(text, ['\u4f4e\u6210\u672c', 'luna max', '\u6a21\u578b'])
    && includesAny(text, ['\u914d\u7f6e', '\u4f18\u5316', '\u8ba8\u8bba', '\u7b56\u7565', '\u89c4\u5219', '\u8bbe\u7f6e', 'configure', 'configuration'])
  );
  const materialKind = ['documents', 'structured-data'].includes(lowCostKind);
  const materialWriteIntent = materialKind && includesAny(text, DOCUMENT_WRITE_TERMS);
  const boundedMaterialWrite = !materialWriteIntent || includesAny(text, MATERIAL_OPERATION_TERMS);
  const documentRoutineWrite = materialKind
    && boundedMaterialWrite
    && !includesAny(text, [
      '\u5b9e\u73b0', '\u4fee\u590d', '\u8fc1\u79fb', '\u91cd\u6784', '\u7f16\u7801', 'implement', 'fix', 'migrate', 'refactor', 'develop',
    ]);
  const unboundedMaterialWrite = !constraints.readOnly && materialWriteIntent && !boundedMaterialWrite;
  const lowCostRoute = Boolean(lowCostKind
    && lowCostPolicy(config).enabled
    && !unboundedMaterialWrite
    && (!modificationIntent || documentRoutineWrite)
    && !(lowCostKind === 'established-tests' && delivery && !testImplementation)
    && !review
    && !nonTrivialPlan);
  const needsGraph = !constraints.wordingOnly && explicitCodeContext
    && (crossFile || broad || inspectArchitecture || review);
  const result = (category, extra = {}) => ({
    category,
    route: category,
    shouldDispatch: true,
    needsGraph,
    lowCostKind,
    lowCostEvidence: Boolean(lowCostPolicy(config).enabled && lowCostKind
      && !(lowCostKind === 'established-tests' && testImplementation)
      && !lowCostRoute
      && (modificationIntent || implementation || highRisk || hard || nonTrivialPlan || review)),
    ...constraints,
    ...extra,
  });
  if (constraints.primaryOnly) return result('primary-only', { shouldDispatch: false });
  if (constraints.wordingOnly) return result('generic', { shouldDispatch: false, reason: 'wording-only document edit/review' });
  if (constraints.narrow || (!review && exactNarrowLookup(text))) {
    return result(highRisk ? 'primary-risk' : 'generic', {
      shouldDispatch: false, reason: 'explicit narrow scope is primary-agent work',
    });
  }
  if (policyDiscussion) {
    return result('generic', { shouldDispatch: false, reason: 'dispatch policy discussion is primary-agent work' });
  }
  if (review) return result(highRisk ? 'high-risk-review' : 'review');
  if (nonTrivialPlan && !hard) return result('plan');
  if (lowCostRoute) return result('low-cost');
  if (unboundedMaterialWrite) return result('execution');
  if (verification && !implementation && (!delivery || directVerification)) return result('verification');
  if (externalResearch) return result('external-research', { needsGraph: false });
  if (constraints.readOnly) {
    return result(broad ? 'broad-search' : (crossFile ? 'bounded-search' : 'diagnosis'));
  }
  if (implementation && highRisk) return result('high-risk-implementation');
  if (hard) {
    return result('hard-task', { requiresPlanner: nonTrivialPlan });
  }
  if (implementation) {
    return result('implementation', { shouldDispatch: !includesAny(text, TRIVIAL_EDIT_TERMS) });
  }
  if (delivery) return result('execution');
  if (broad || (lookup && includesAny(text, ['\u5168\u5c40', '\u5168\u9762', '\u5e7f\u6cdb', 'wide', 'broad']))) {
    return result('broad-search');
  }
  if (crossFile || inspectArchitecture || (lookup && includesAny(text, ['\u591a\u4e2a', 'many', 'several']))) {
    return result('bounded-search');
  }

  const configured = configuredKeywordMatch(text, config);
  return {
    category: 'generic',
    route: 'generic',
    shouldDispatch: configured,
    reason: configured ? 'configured prompt keyword' : 'no task-specific routing signal',
  };
}

/**
 * Return a concise route for UserPromptSubmit.
 *
 * SessionStart provides static policy; this adds only a matching route and stays quiet for trivial tasks.
 */
function promptGuidance(prompt, config) {
  const route = routePrompt(prompt, config);
  if (route.category === 'primary-risk') return `${PROMPT_ROUTE_NOTICE} Task route: single-file risk check or fix for the primary agent. Verify evidence and existing authorization for permission, security, or concurrency contracts, then validate according to actual risk without widening the user-defined scope.${route.readOnly ? ' If the user currently requires read-only work, collect evidence within that scope.' : ''}`;
  if (!route.shouldDispatch) return '';
  const graph = route.needsGraph
    ? ' For explicit code structure, call relationships, or code review, prefer graph queries and then verify against source. CodeMap Boost owns graph refresh; do not repeat build/update.'
    : '';
  const agentLimit = route.limitedAgents
    ? ' User limits on agent count or parallelism take precedence over the default concurrency allowance. Reuse a suitable agent or have the primary agent handle it; candidate lists do not require multiple spawns.'
    : '';
  return PROMPT_ROUTE_NOTICE + ' ' + routeGuidance(route, config) + graph + agentLimit;
}

/** Suggest a role consistent with the parsed scope. @example routeGuidance(route, config) */
function routeGuidance(route, config) {
  switch (route.category) {
    case 'low-cost':
      return lowCostGuidance(route, config);
    case 'diagnosis':
      return `Task route: read-only diagnosis. If this is the investigation stage requested by the user, collect symptoms, root-cause evidence, and a verification method within the confirmed read-only scope. ${roleFallback(config, ['dispatch_explorer', 'dispatch_mapper'])} The primary agent decides on later implementation according to actual authorization.`;
    case 'verification':
      return `Task route: verification execution. If this stage follows established checks, collect evidence using the cases, acceptance criteria, or reproduction steps without changing the deliverable under review. ${roleFallback(config, ['dispatch_tester'])} Choose checks appropriate to the deliverable; do not impose code builds on design, documents, operations, or data work.`;
    case 'external-research':
      return `Task route: external research. ${roleFallback(config, ['dispatch_researcher'])} Report sources, dates, and the boundary between facts and inference. Use an explorer or the primary agent for workspace evidence.`;
    case 'high-risk-implementation':
      return `Task route: a change involving security, permissions, or concurrency risk. The primary agent first verifies the real workflow, contracts, existing authorization, and acceptance criteria; for code, inspect actual call paths. Delegate only a bounded change after setting those boundaries. Keywords do not widen authority or require repeating an existing authorization. ${dynamicWriterGuidance(config, { codeWork: true })} ${reviewFeedbackGuidance()}${lowCostEvidenceGuidance(route, config)}`;
    case 'high-risk-review':
      return `Task route: high-risk review. ${roleFallback(config, ['dispatch_reviewer', 'dispatch_deep_reviewer'])} ${profileEnabled(config, 'dispatch_deep_reviewer') ? `For critical acceptance or exceptionally complex constraints, the primary agent may choose ${profileLabel(config, 'dispatch_deep_reviewer')}; risk keywords alone do not require escalation.` : ''} ${reviewLifecycleGuidance()}`;
    case 'hard-task': {
      const writer = dynamicWriterGuidance(config, { codeWork: true });
      if (!route.requiresPlanner) {
        return `Task route: difficult execution. The primary agent sets scope and acceptance criteria first. ${writer} ${reviewFeedbackGuidance()} Difficulty alone does not require a planning agent.${lowCostEvidenceGuidance(route, config)}`;
      }
      return `Task route: difficult work involving planning. Check for an existing plan first; the primary agent owns key plan and public-contract decisions. ${roleFallback(config, ['dispatch_planner'])} If an actionable plan exists, proceed without replanning. Integrate delegated analysis before dependent work. ${writer} ${reviewFeedbackGuidance()}${lowCostEvidenceGuidance(route, config)}`;
    }
    case 'plan':
      return `Task route: substantive plan or proposal. ${roleFallback(config, ['dispatch_planner'])}`;
    case 'broad-search':
      return `Task route: broad read-only investigation. ${roleFallback(config, ['dispatch_mapper', 'dispatch_explorer'])} An investigation subagent covers only the confirmed evidence scope while the primary agent continues the full task.`;
    case 'bounded-search':
      return `Task route: bounded read-only investigation. ${roleFallback(config, ['dispatch_explorer'])} An investigation subagent covers only the confirmed evidence scope. The primary agent can handle a quick precise lookup directly and continue the full task.`;
    case 'implementation':
      return `Task route: ordinary implementation. ${dynamicWriterGuidance(config, { codeWork: true })} ${reviewFeedbackGuidance()}${lowCostEvidenceGuidance(route, config)}`;
    case 'execution':
      return `Task route: content production or deliverable execution. The primary agent first defines the deliverable, audience, format, and acceptance criteria. ${dynamicWriterGuidance(config)} ${reviewFeedbackGuidance()}${lowCostEvidenceGuidance(route, config)}`;
    case 'review':
      return `Task route: ordinary review. ${roleFallback(config, ['dispatch_reviewer'])} ${reviewLifecycleGuidance()}`;
    case 'generic':
    default:
      return 'Task route: no specialized category matched. The primary agent sets the boundary and handles it directly; trivial edits do not normally need a subagent.';
  }
}

function mainAgentGuidance(config, compact = false) {
  const maxParallel = Number(config.policy.max_parallel_subagents) || 3;
  const profiles = profileSummary(config);
  const modelWarnings = modelEffortWarnings(config);
  const lowCost = lowCostPolicy(config);
  const lowCostPair = `${lowCost.model}/${lowCost.effort}`;
  const codePair = codeImplementationPair(config);
  if (compact) {
    const lines = [
      'Agent Dispatch: You are the primary agent. Keep requirements clarification, key plan and public-contract decisions, task decomposition, result review, and final integration in the primary agent.',
      'Delegate clearly bounded investigation, planning analysis, deliverable work, verification, and review when useful. Handle trivial reads, small edits, and tightly coupled steps directly.',
      taskScopeGuidance(),
      modelSelectionGuidance(),
      'Choose enabled roles and model/effort pairs by responsibility, ambiguity, constraints, acceptance feedback, and total cost. Keyword routes cannot override authorization, read-only scope, or an existing plan.',
      'For an unpinned writer, explicitly pass model and effort. Pinned TOML values override spawn arguments. A full-history fork cannot accept overrides under current host rules; pass only necessary context through a supported mechanism.',
      ...(lowCost.enabled ? [`Use a matching low-cost role (${lowCostPair}) for bounded logs, routine documents or structured data, text extraction, code evidence, and established code tests. It may produce evidence artifacts but must not implement or modify product or test code. If unavailable, report a bounded blocker rather than silently upgrading.`] : []),
      lowCost.enabled
        ? `For code work, give the low-cost role (${lowCostPair}) only logs, call/source evidence, and established test execution. Use the effective ${codePair} candidate for writing by default; choose affected validation and necessary review separately. In mixed tasks, assign only the evidence stage to low-cost labor.`
        : `For code work, first gather evidence locations and necessary excerpts. The primary agent decides key interfaces and plans. Use the effective ${codePair} candidate for writing by default; choose affected validation and necessary review separately.`,
      'Verify the actual host model/effort pair before spawning. Do not carry an unsupported effort level into another model or silently replace a user-specified model.',
      'Use code graphs only for explicit code structure, call relationships, or code review. Agent Dispatch selects the agent; CodeMap Boost owns graph refresh and retrieval. Do not send ordinary design or business relationships to a code graph.',
      'Choose validation for the deliverable. For code, inspect first-party integration and needed dependency interfaces without formatting or linting third-party implementations by default.',
      `Delegate only when independent parallel work helps, with at most ${maxParallel} concurrent subagents. Keep ordinary Git commands serial in the primary agent. Complete local commit preparation may be assigned to one writable Luna agent with an explicit host-supported model and effort only when a user request or explicit skill workflow requires it; the primary agent validates the snapshot and performs the final commit, remote operations, and history rewrites.`,
      'Review real entry points, intent, and acceptance criteria. Only verified defects affecting acceptance block; hypothetical risks and style suggestions are advisory. Advisory notes do not automatically trigger rework or a stop.',
      'After proportionate validation, independently review substantive work. If the user requires primary-only work or disables reviewers, the primary agent reviews and states the scope. Verified issues receive a bounded fix by the original writer and another review.',
      reviewLifecycleGuidance(),
      'Roles, write access, and delegation do not authorize external publishing or sending, purchases, production changes, or real-data changes. Check existing user authorization.',
      'Subagents report changed files, validation, and blockers. Stop them promptly when their results are integrated or no longer needed.',
    ];
    if (profiles.length) lines.push(`Configured role candidates (check actual host loading): ${profiles.join('; ')}.`);
    if (modelWarnings.length) lines.push(`Model configuration check: ${modelWarnings.join(' ')}`);
    return lines.join(' ');
  }
  const lines = [
    'Agent Dispatch policy for the primary Codex agent:',
    `- ${taskScopeGuidance('en')}`,
    `- ${modelSelectionGuidance('en')}`,
    '- Keep requirements clarification, key plan and public-contract decisions, task decomposition, result review, and final integration in the primary agent.',
    '- Delegate bounded investigation, planning analysis, content or product production, operations, document or data work, code implementation, verification, and review when a separate role has clear value, even when that work is sequential.',
    '- Choose among enabled candidates from role descriptions, ambiguity, constraints, acceptance feedback, explicit user preference, host availability, and total task cost including context, rework, review, and latency. High ambiguity may justify a stronger candidate immediately; do not route domains mechanically by keywords or maximize every role.',
    '- For an unpinned writer, explicitly pass model and effort so it does not accidentally inherit an expensive primary model. Native TOML model/effort values override spawn parameters; for a temporary combination choose a role with unpinned fields and pass both explicitly. Under the host rules, the current full-history fork does not accept overrides, so pass only the minimum needed context using a host-supported combination.',
    ...(lowCost.enabled ? [`- Delegate bounded log, routine document or structured-data, text-extraction, code-evidence, and established code-test labor to the configured low-cost candidate (${lowCostPair}) by default. It may produce evidence artifacts but does not implement or modify product or test code. If unavailable, keep the subtask bounded or blocked rather than silently upgrading.`] : []),
    lowCost.enabled
      ? `- For code work, give only logs, call-chain/source evidence, and established test execution to the low-cost candidate (${lowCostPair}). Use the effective ${codePair} candidate for code writing by default; select enabled alternatives only when justified by actual complexity or explicit preference. In mixed tasks, split only the evidence stage to low-cost labor.`
      : `- For code work, gather evidence locations and necessary excerpts first. Use the effective ${codePair} candidate for code writing by default, with enabled alternatives or primary-agent execution when configuration or task constraints require them.`,
    '- For routing outside policy.low_cost, profile defaults and keyword routes are suggestions, not proof of runtime availability or permission to override user scope. Verify the host-supported model/effort pair before spawning; if an ordinary default combination is unavailable, use supported settings or primary-agent work, never carry ultra blindly into a model that does not support it, and do not silently replace an explicitly requested model.',
    '- Only for explicit code structure, call-relationship, or code-review tasks, prefer available graph tools. Agent Dispatch selects the agent; CodeMap Boost owns graph refresh and retrieval policy. Do not send ordinary design reviews or business dependencies to a code graph.',
    '- Choose validation evidence for the actual deliverable; builds and code tests are not universal requirements. For code work, exclude vendored third-party implementations from review, formatting, and lint unless explicitly requested, and review first-party integration contracts.',
    '- Delegate independent bounded subtasks in parallel when useful.',
    `- Use no more than ${maxParallel} subagents concurrently unless the user explicitly requests more.`,
    '- Keep trivial reads, small edits, tightly coupled steps, and final integration in the primary agent.',
    '- Before treating a review finding as blocking, verify task intent, acceptance criteria, real entry points, and the actual use or execution path. Only a defect supported by concrete evidence and affecting the current acceptance target can block. Missing context, hypothetical risks, and style suggestions are non-blocking notes or items to verify; they do not trigger automatic rework or stop for confirmation.',
    '- After proportionate validation, independently review non-trivial deliverables. If the user requires primary-agent-only work or disables reviewers, the primary agent performs the review and states its scope. Small changes do not require every role.',
    `- ${reviewLifecycleGuidance('en')}`,
    '- When review finds a verified substantive issue affecting acceptance, the primary agent reuses the original writer for a bounded fix, reruns affected checks, and reviews again. If an issue repeats without new evidence, change the decomposition, raise the model, or intervene in the primary agent instead of adding speculative changes indefinitely.',
    '- Stop subagents promptly after their result is integrated, or when they are blocked or no longer needed; do not leave idle agents occupying limited slots.',
    '- Keep ordinary single-command Git CLI quiet and serial in the primary agent. Only an explicit user or skill request for complete local commit preparation may hand off that preparation to one writable Luna agent in the same workspace with an explicit host-supported model and effort; do not run Git concurrently, and have the primary validate the snapshot before the final commit. The final commit, remote operations, and history rewrites remain with the primary agent.',
    '- A role, workspace-write access, or delegation does not authorize external publishing or sending, purchases, production changes, or changes to real data. Verify existing user authority before those actions.',
    '- Ask subagents to report every changed file, validation performed, and any blocker; reread their outputs before integration.',
    '- Do not delegate vague decisions; give execution agents a concrete scope, artifact ownership, acceptance criteria, and validation target.',
  ];
  if (profiles.length) {
    lines.push(`- Configured role candidates (check actual host loading): ${profiles.join('; ')}.`);
    lines.push('- Generated custom-agent model settings take effect in a newly opened Codex task.');
  }
  for (const warning of modelWarnings) lines.push(`- Model configuration check: ${warning}`);
  return lines.join('\n');
}

function subagentGuidance(config) {
  const lines = [
    'Agent Dispatch: you are a spawned subagent, not the primary coordinator.',
    '- Execute the assigned bounded investigation, plan, deliverable, verification, or review directly and stay within scope.',
    '- Do not spawn or delegate to more agents unless the user or primary agent explicitly asked you to do so.',
    `- ${GIT_HANDOFF}`,
    '- Use CodeMap Boost only for explicit code structure or code-review work; it owns graph refresh and retrieval. Do not apply code-graph guidance to ordinary design or business relationships.',
    '- Your role and write access do not add authority to publish or send externally, spend money, change production, or alter real data; follow authority already established by the user and primary agent.',
    `- ${reviewLifecycleGuidance('en', true)}`,
  ];
  if (config.policy.require_changed_file_report) {
    lines.push('- Report every file you changed, or state explicitly that you made no changes.');
  }
  if (config.policy.require_validation_report) {
    lines.push('- Report validation methods, evidence, results, and any remaining blocker.');
  }
  return lines.join('\n');
}

function promptNeedsDispatch(prompt, config) {
  return routePrompt(prompt, config).shouldDispatch;
}

module.exports = {
  mainAgentGuidance,
  promptGuidance,
  promptNeedsDispatch,
  routePrompt,
  subagentGuidance,
};
