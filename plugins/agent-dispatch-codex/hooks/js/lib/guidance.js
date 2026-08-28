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

/**
 * 生成可写执行角色的动态选择边界，不在 Hook 中固定具体模型或推理强度。
 *
 * @example
 * dynamicWriterGuidance(config);
 */
function dynamicWriterGuidance(config) {
  const profiles = config && config.agent_profiles && config.agent_profiles.profiles;
  const hasWritableProfile = config
    && config.agent_profiles
    && config.agent_profiles.enabled !== false
    && profiles
    && Object.values(profiles).some((profile) => profile
      && profile.enabled !== false
      && profile.sandbox_mode === 'workspace-write');
  if (!hasWritableProfile) {
    return '当前没有启用的可写执行角色，由主代理直接完成。';
  }
  return '主代理依据任务复杂度、上下文范围、风险、账号/工作区可用性和用户显式偏好，自主选择可写执行角色、模型和推理强度；显式指定优先。';
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
  if (hard) {
    return {
      category: 'hard-task',
      route: 'hard-task',
      shouldDispatch: true,
      requiresPlanner: nonTrivialPlan,
    };
  }
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
      const writer = dynamicWriterGuidance(config);
      if (!route.requiresPlanner) {
        return `任务路由：困难实现/复杂调试。主代理先固定范围和验收标准；${writer} 实现完成后由主代理验收并整合。不要仅因任务困难启动规划角色。`;
      }
      const planner = firstEnabled(config, ['dispatch_planner']);
      const plannerLabel = planner ? profileLabel(config, planner) : '主代理';
      const planningAvailability = planner
        ? '规划角色仅在启用且账号/工作区可用时使用，模型不可用时按账号策略回退到主代理。'
        : '没有启用的规划角色，由主代理完成规划。';
      return `任务路由：需要专门规划的困难任务。必须串行两阶段：1) ${plannerLabel} 制定计划；停止并整合；2) ${writer} 非必要不并行。${planningAvailability} 实现完成后由主代理验收并整合。`;
    }
    case 'plan':
      return `任务路由：非琐碎计划/架构。${roleFallback(config, ['dispatch_planner'])}`;
    case 'broad-search':
      return `任务路由：广泛/跨模块读重型搜索。${roleFallback(config, ['dispatch_mapper', 'dispatch_explorer'])} 若 CodeMap Boost 可用，优先图查询；图刷新由 CodeMap Boost 负责，不要重复 build/update。`;
    case 'bounded-search':
      return `任务路由：跨文件/调用链搜索。${roleFallback(config, ['dispatch_explorer'])} 若 CodeMap Boost 可用，优先图查询；图刷新由 CodeMap Boost 负责，不要重复 build/update。精确单符号/单文件快速查找由主代理直接完成。`;
    case 'implementation':
      return `任务路由：常规实现。${dynamicWriterGuidance(config)} 实现完成后由主代理验收并整合。`;
    case 'review':
      return `任务路由：常规审查。${roleFallback(config, ['dispatch_reviewer'])}`;
    case 'generic':
    default:
      return '任务路由：未命中专门类别；由主代理判断边界并直接处理，琐碎编辑默认不启动子代理。';
  }
}

function mainAgentGuidance(config, compact = false) {
  const maxParallel = Number(config.policy.max_parallel_subagents) || 3;
  const profiles = profileSummary(config);
  if (compact) {
    const lines = [
      'Agent Dispatch：你是主代理。需求澄清、架构/接口决策、任务拆分、结果审查和最终整合由主代理负责；',
      '明确、有界的编码、重构和修 bug 可交给可写执行子代理，即使步骤串行也可委派；琐碎读取、小改和强耦合步骤直接完成。',
      '按任务范围、复杂度、上下文、风险和账号可用性选择合适角色；编码执行角色、模型和推理强度由主代理动态决定，显式用户偏好优先。',
      '代码搜索若可用 CodeMap Boost，应优先用图；Agent Dispatch 只负责选代理，图刷新和检索规则由 CodeMap Boost 负责，不要重复 build/update。CodeMap MCP 可能 deferred，不在静态/顶层 schema；声称未加载前可用时检查 ALL_TOOLS 中的 mcp__code_review_graph__* 或实际调用，不能仅凭顶层列表判断。',
      `独立且并行有收益时委派；最多 ${maxParallel} 个子代理并发。所有 Git 命令均由主代理串行执行，不委派、不并行拆分。`,
      '普通结果由主代理自行审查；用户明确要求独立审查时用 Terra high，高风险审查才用 Sol xhigh。',
      '子代理须报告修改文件、验证和阻塞；结果已整合或不再需要时立即停止子代理，避免占用有限智能体名额。',
    ];
    if (profiles.length) lines.push(`可用角色：${profiles.join('；')}。`);
    return lines.join('');
  }
  const lines = [
    'Agent Dispatch policy for the primary Codex agent:',
    '- Keep requirements clarification, architecture and interface decisions, task decomposition, result review, and final integration in the primary agent.',
    '- Prefer a workspace-write execution agent for concrete, bounded implementation, refactoring, and bug-fix work once the steps and acceptance criteria are clear, even when that work is sequential.',
    '- Choose roles, models, and reasoning strength from task scope, complexity, context, risk, account/workspace availability, and explicit user preference; keep the established search, planning, and review boundaries.',
    '- For code search, prefer CodeMap Boost graph tools when available. Agent Dispatch selects the agent; CodeMap Boost owns graph refresh and retrieval policy, so do not duplicate build/update. Its MCP tools may be deferred and absent from static or top-level schemas; before claiming unavailable, inspect ALL_TOOLS for mcp__code_review_graph__* when available or make an actual call, rather than relying on the top-level list alone.',
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
    '- Agent Dispatch selects the agent; CodeMap Boost owns graph refresh and retrieval. Its MCP tools may be deferred and absent from static or top-level schemas; before claiming unavailable, inspect ALL_TOOLS for mcp__code_review_graph__* when available or make an actual call, rather than relying on the top-level list alone.',
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
    if (analysis.route === 'primary-risk') {
      const reviewer = firstEnabled(config, ['dispatch_deep_reviewer', 'dispatch_reviewer']);
      const acceptance = reviewer ? profileLabel(config, reviewer) : '主代理';
      return `Agent Dispatch：检测到注册表写入或状态变更（${analysis.reason}）。由主代理核对目标、授权与回滚边界后执行；不要仅因命令本身升级执行模型。需要独立高风险验收时再使用 ${acceptance}。`;
    }
    return '';
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
