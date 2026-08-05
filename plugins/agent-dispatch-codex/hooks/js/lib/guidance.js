'use strict';

const { analyzeShellCommand } = require('./shell');
const { profileSummary } = require('./agent_profiles');

const REVIEW_TERMS = [
  '审查', '审核', '评审', 'review', 'audit', 'code review', 'reviewing',
];
const HIGH_RISK_TERMS = [
  '安全', '漏洞', 'security', 'vulnerability', '并发', '竞态', 'concurrency',
  'race condition', '权限', '授权', 'permission', 'production', '生产',
  '线上', '上线风险', '死锁', 'deadlock',
];
const HARD_TERMS = [
  '困难', '疑难', '复杂任务', '复杂实现', '复杂调试', '困难实现', 'hard task',
  'hard implementation', 'complex task', 'complex implementation',
  'complex debugging', 'difficult', '性能瓶颈', '性能回归', '崩溃', 'crash',
  '死锁', 'deadlock', '竞态', 'race condition',
];
const PLAN_TERMS = [
  '架构', 'architecture', '架构设计', '设计方案', '方案设计', '技术方案',
  '接口设计', '接口契约', 'api contract', 'design', 'plan', '规划', '方案',
  '计划', '决策', 'decision', '选型',
];
const IMPLEMENT_TERMS = [
  '实现', 'implement', 'implementation', '修复', 'fix', 'bug', '编码',
  '修改', '改动', '迁移', 'migrate', '重构', 'refactor', '构建', 'build',
  '开发', 'develop',
];
const LOOKUP_TERMS = [
  '查找', '搜索', '搜寻', '定位', '查询', '调查', '研究', '扫描', '梳理',
  'find', 'search', 'lookup', 'investigate', 'investigation', 'research', 'scan',
];
const CROSS_FILE_TERMS = [
  '跨文件', '多文件', '多个文件', '调用链', '引用关系', '影响面', '依赖链',
  'cross-file', 'multiple files', 'call chain', 'reference graph', 'impact radius',
];
const BROAD_SCAN_TERMS = [
  '跨模块', '全仓', '全仓库', '全局扫描', '全面扫描', '广泛扫描', '大范围',
  '读重型', '大型扫描', 'repository-wide', 'cross-module', 'broad scan',
  'wide scan', 'large-scale', 'read-heavy', 'massive scan', 'entire repository',
];
const SINGLE_LOOKUP_TERMS = [
  '单符号', '单个符号', '单文件', '单个文件', '某个函数', '这个函数', '这个文件',
  'single symbol', 'single file', 'one symbol', 'one file', 'this function', 'this file',
];
const NON_TRIVIAL_PLAN_TERMS = [
  '架构', 'architecture', '接口设计', '接口契约', 'api contract', '技术方案',
  '选型', '决策', 'decision', '权衡', 'tradeoff', '迁移方案', '跨模块',
  '多阶段', 'multi-stage', '制定计划', '先计划', '开发计划', '实现计划',
  '可行性', 'plan first', 'plan then', 'implementation plan',
];
const TRIVIAL_EDIT_TERMS = [
  'getter', 'setter', '拼写', 'typo', '加个注释', '添加注释', '补个注释',
  '类型定义', '这一行', '一行代码', '单行修改', 'one-line', 'single-line',
];

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function normalizedPrompt(prompt) {
  return typeof prompt === 'string' ? prompt.trim().toLowerCase() : '';
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
  return Boolean(profile && profile.enabled !== false);
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

function roleFallback(config, names) {
  const selected = firstEnabled(config, names);
  if (!selected) {
    return '由主代理直接完成（没有启用的匹配角色）。';
  }
  const index = names.indexOf(selected);
  const lowerCost = names.slice(index + 1).filter((name) => profileEnabled(config, name));
  const fallback = lowerCost.length
    ? `${lowerCost.join(' 或 ')} 或主代理`
    : '主代理';
  return `必须启动 ${profileLabel(config, selected)} 子代理；仅在角色已启用且账号/工作区可用时使用，模型不可用时按账号策略回退到 ${fallback}。`;
}

function exactNarrowLookup(text) {
  return includesAny(text, LOOKUP_TERMS)
    && includesAny(text, SINGLE_LOOKUP_TERMS)
    && !includesAny(text, CROSS_FILE_TERMS)
    && !includesAny(text, BROAD_SCAN_TERMS);
}

/**
 * Classify a prompt without making a dispatch decision.
 *
 * The order is intentionally risk-first so overlapping words cannot select a
 * cheaper role before a security or production review is recognized.
 */
function routePrompt(prompt, config) {
  const text = normalizedPrompt(prompt);
  if (!text) {
    return { category: 'generic', route: 'generic', shouldDispatch: false };
  }

  const review = includesAny(text, REVIEW_TERMS);
  const highRisk = review && includesAny(text, HIGH_RISK_TERMS);
  const hard = includesAny(text, HARD_TERMS)
    || (includesAny(text, ['调试', 'debug', '排查', 'diagnose'])
      && includesAny(text, ['复杂', '疑难', '困难', 'complex', 'difficult', 'hard']));
  const plan = includesAny(text, PLAN_TERMS);
  const lookup = includesAny(text, LOOKUP_TERMS);
  const broad = includesAny(text, BROAD_SCAN_TERMS);
  const crossFile = includesAny(text, CROSS_FILE_TERMS);
  const implementation = includesAny(text, IMPLEMENT_TERMS);
  const nonTrivialPlan = plan && (
    text.length >= 80
    || includesAny(text, NON_TRIVIAL_PLAN_TERMS)
    || crossFile
    || broad
  );

  if (highRisk) return { category: 'high-risk-review', route: 'high-risk-review', shouldDispatch: true };
  if (hard) return { category: 'hard-task', route: 'hard-task', shouldDispatch: true };
  if (nonTrivialPlan) return { category: 'plan', route: 'plan', shouldDispatch: true };
  if (exactNarrowLookup(text)) {
    return {
      category: 'generic',
      route: 'generic',
      shouldDispatch: false,
      reason: 'exact single-symbol or single-file lookup is primary-agent work',
    };
  }
  if (broad || (lookup && includesAny(text, ['全局', '全面', '广泛', 'wide', 'broad']))) {
    return { category: 'broad-search', route: 'broad-search', shouldDispatch: true };
  }
  if (crossFile || (lookup && includesAny(text, ['多个', 'many', 'several']))) {
    return { category: 'bounded-search', route: 'bounded-search', shouldDispatch: true };
  }
  if (review) return { category: 'review', route: 'review', shouldDispatch: true };
  if (implementation && !includesAny(text, TRIVIAL_EDIT_TERMS)) {
    return { category: 'implementation', route: 'implementation', shouldDispatch: true };
  }
  if (implementation && includesAny(text, TRIVIAL_EDIT_TERMS)) {
    return {
      category: 'generic',
      route: 'generic',
      shouldDispatch: false,
      reason: 'trivial edit is primary-agent work',
    };
  }

  const configured = configuredKeywordMatch(text, config);
  return {
    category: 'generic',
    route: 'generic',
    shouldDispatch: configured || text.length >= 160,
    reason: configured ? 'configured prompt keyword' : 'long prompt requiring primary-agent triage',
  };
}

/**
 * Return the short, prompt-specific dispatch guidance injected by UserPromptSubmit.
 *
 * SessionStart owns the static policy; this function only adds the route that
 * matches the current prompt and stays silent for trivial work.
 */
function promptGuidance(prompt, config) {
  const route = routePrompt(prompt, config);
  if (!route.shouldDispatch) return '';
  switch (route.category) {
    case 'high-risk-review':
      return `任务路由：高风险审查。${roleFallback(config, ['dispatch_deep_reviewer', 'dispatch_reviewer'])}`;
    case 'hard-task': {
      const planner = firstEnabled(config, ['dispatch_planner']);
      const worker = firstEnabled(config, ['dispatch_hard_worker', 'dispatch_worker']);
      const plannerLabel = planner ? profileLabel(config, planner) : '主代理';
      const workerLabel = worker ? profileLabel(config, worker) : '主代理';
      const fallback = [];
      if (planner) fallback.push('主代理');
      if (worker === 'dispatch_hard_worker' && profileEnabled(config, 'dispatch_worker')) {
        fallback.push('dispatch_worker');
      }
      const availability = planner || worker
        ? `角色仅在启用且账号/工作区可用时使用，模型不可用时按账号策略回退到 ${Array.from(new Set(fallback.concat('主代理'))).join(' 或 ')}。`
        : '没有启用的匹配角色，由主代理完成。';
      return `任务路由：困难任务/复杂调试。必须串行两阶段：1) ${plannerLabel} 制定计划；停止并整合；2) ${workerLabel} 执行实现。非必要不并行。${availability}`;
    }
    case 'plan':
      return `任务路由：非琐碎计划/架构。${roleFallback(config, ['dispatch_planner'])}`;
    case 'broad-search':
      return `任务路由：广泛/跨模块读重型搜索。${roleFallback(config, ['dispatch_mapper', 'dispatch_explorer'])}`;
    case 'bounded-search':
      return `任务路由：跨文件/调用链搜索。${roleFallback(config, ['dispatch_explorer'])} 精确单符号/单文件快速查找由主代理直接完成。`;
    case 'implementation':
      return `任务路由：常规实现。${roleFallback(config, ['dispatch_worker'])}`;
    case 'review':
      return `任务路由：常规审查。${roleFallback(config, ['dispatch_reviewer'])}`;
    case 'generic':
    default:
      return '任务路由：未命中专门类别；由主代理判断边界并直接处理，琐碎编辑不启动 max/ultra 角色。';
  }
}

function mainAgentGuidance(config, compact = false) {
  const maxParallel = Number(config.policy.max_parallel_subagents) || 3;
  const profiles = profileSummary(config);
  if (compact) {
    const lines = [
      'Agent Dispatch：你是主代理。需求澄清、架构/接口决策、任务拆分、结果审查和最终整合由主代理负责；',
      '明确、有界的编码、重构和修 bug 优先交给低成本执行子代理，即使步骤串行也可委派；琐碎读取、小改和强耦合步骤直接完成。',
      '按最低可靠档位路由：有界搜索用 Luna，广泛扫描/常规审查用 Terra；非琐碎计划或高风险审查才用 Sol xhigh；困难实现才用 Terra ultra。',
      '可独立并行的子任务必须并行委派。所有 Git 命令均由主代理串行执行，不委派、不并行拆分。',
      '普通结果由主代理自行审查；用户明确要求独立审查时用 Terra high，高风险审查才用 Sol xhigh。',
      '子代理须报告修改文件、验证和阻塞；结果已整合或不再需要时立即停止子代理，避免占用有限智能体名额。',
    ];
    if (profiles.length) lines.push(`可用角色：${profiles.join('；')}。`);
    return lines.join('');
  }
  const lines = [
    'Agent Dispatch policy for the primary Codex agent:',
    '- Keep requirements clarification, architecture and interface decisions, task decomposition, result review, and final integration in the primary agent.',
    '- Prefer a cost-efficient execution agent for concrete, bounded implementation, refactoring, and bug-fix work once the steps and acceptance criteria are clear, even when that work is sequential.',
    '- Route at the lowest reliable tier: Luna for bounded search and clear development; Terra for broad mapping and routine independent review; Sol xhigh only for non-trivial planning or high-risk review; Terra ultra only for difficult execution after a plan.',
    '- Delegate independent bounded subtasks in parallel when useful.',
    `- Use no more than ${maxParallel} subagents concurrently unless the user explicitly requests more.`,
    '- Keep trivial reads, small edits, tightly coupled steps, and final integration in the primary agent.',
    '- Review normal execution results in the primary agent; use Terra high for requested routine independent review and Sol xhigh only for high-risk review.',
    '- Stop subagents promptly after their result is integrated, or when they are blocked or no longer needed; do not leave idle agents occupying limited slots.',
    '- Execute all Git commands in the primary agent, one at a time; never delegate or parallelize Git operations.',
    '- Delegation does not broaden filesystem, network, approval, or external-action authority.',
    '- Ask subagents to report every changed file, validation performed, and any blocker; reread their outputs before integration.',
    '- Do not delegate vague design decisions; give execution agents a concrete scope, file ownership, acceptance criteria, and validation target.',
  ];
  if (profiles.length) {
    lines.push(`- Prefer the matching project custom agent when available: ${profiles.join('; ')}.`);
    lines.push('- Generated custom-agent model settings take effect in a newly opened Codex task.');
  }
  return lines.join('\n');
}

function subagentGuidance(config) {
  const lines = [
    'Agent Dispatch: you are a spawned subagent, not the primary coordinator.',
    '- Execute the assigned bounded task directly and stay within its scope.',
    '- Do not spawn or delegate to more agents unless the user or primary agent explicitly asked you to do so.',
    '- Do not run Git commands; leave all Git operations to the primary agent.',
  ];
  if (config.policy.require_changed_file_report) {
    lines.push('- Report every file you changed, or state explicitly that you made no changes.');
  }
  if (config.policy.require_validation_report) {
    lines.push('- Report the validation commands/results and any remaining blocker.');
  }
  return lines.join('\n');
}

function promptNeedsDispatch(prompt, config) {
  return routePrompt(prompt, config).shouldDispatch;
}

function toolNudge(input, config) {
  const toolName = input && typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!toolName || toolName === 'apply_patch') return '';
  if (toolName.startsWith('mcp__')) {
    const allowed = (config.whitelist.mcp_prefixes || []).some((prefix) => toolName.startsWith(prefix));
    if (allowed) return '';
    return `Agent Dispatch：${toolName} 不在主代理轻量 MCP 白名单中。若这是可独立的有界工作，主代理必须委派子代理；若当前已是子代理，则直接执行分配任务。`;
  }
  if (toolName === 'Bash') {
    const command = input.tool_input && input.tool_input.command;
    const analysis = analyzeShellCommand(command, config);
    if (analysis.safe) return '';
    return `Agent Dispatch：当前命令需要调度判断（${analysis.reason}）。主代理应把可独立工作委派给子代理；已启动的子代理直接执行分配任务。`;
  }
  return '';
}

module.exports = {
  mainAgentGuidance,
  promptGuidance,
  promptNeedsDispatch,
  routePrompt,
  subagentGuidance,
  toolNudge,
};
