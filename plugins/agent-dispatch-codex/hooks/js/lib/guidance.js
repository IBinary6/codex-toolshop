'use strict';

const { analyzeShellCommand } = require('./shell');
const { profileSummary } = require('./agent_profiles');
const { modelEffortWarnings } = require('./config');

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
  '模块依赖', '依赖关系', 'cross-file', 'multiple files', 'call chain',
  'reference graph', 'impact radius', 'callers', 'callees', 'depends on', 'dependencies',
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
const REVIEW_FEEDBACK_GUIDANCE = '实现由主代理验收并整合；完成针对性验证后独立审查。若用户限制 reviewer，则由主代理审查并说明范围；只对有具体证据且影响本次验收的实质问题，经主代理核实后复用原 writer 有界修复并复查，提示项不自动返修或停工。';

function includesAny(text, terms) {
  return terms.some((term) => {
    if (!/^[a-z][a-z -]*$/i.test(term)) return text.includes(term);
    return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  });
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
  return `需要独立有界子任务时可选 ${profileLabel(config, selected)}；主代理根据已有上下文、分派收益和用户显式偏好决定是否委派。先核对宿主实际支持的模型/推理组合；默认组合不可用时可选 ${fallback}，用户明确指定的模型不得擅自替换。`;
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
      && profile.role_kind !== 'verification'
      && profile.sandbox_mode === 'workspace-write');
  if (!hasWritableProfile) {
    return '当前没有启用的可写执行角色，由主代理直接完成。';
  }
  return '主代理按实际复杂度从已启用候选选择可写执行角色、模型和推理强度，不按关键词固定代码模型。未固定模型的 writer 必须显式传入 model 与 effort，避免无意继承昂贵主模型。';
}

function exactNarrowLookup(text) {
  return includesAny(text, LOOKUP_TERMS)
    && includesAny(text, SINGLE_LOOKUP_TERMS)
    && !includesAny(text, CROSS_FILE_TERMS)
    && !includesAny(text, BROAD_SCAN_TERMS);
}

/**
 * 先提取明确范围，再进行关键词建议；关键词不构成写入或委派授权。
 * @example promptConstraints('只读诊断崩溃，只用主代理')
 */
function promptConstraints(text) {
  const primaryOnly = /只(?:用|由|让)?主代理|仅(?:用|由|让)?主代理|(?:不要|禁止|不用|不允许)(?:再)?(?:委派|分派|子代理|子任务)|\b(?:primary agent only|main agent only|no subagents?|no delegation|do not delegate|don't delegate)\b/.test(text);
  const limitedAgents = /(?:只|仅|最多).{0,8}(?:一个|一名|1 个|1名)(?:子)?代理|不要多个代理|不要并行|\b(?:only one agent|at most one subagent|no parallel agents|do not parallelize)\b/.test(text);
  const explicitReadOnly = /只读|仅(?:分析|诊断|审查)|(?:先)?(?:不要|禁止|不允许|不得)(?:修改|改动|编辑|写入)|不修改|\b(?:read[- ]only|do not (?:edit|modify|write)|don't (?:edit|modify|write)|diagnosis only)\b/.test(text);
  const writeIntent = /实现|修复|迁移|重构|编码|\b(?:implement|fix|migrate|refactor|edit|modify|develop)\b/.test(text);
  const diagnosis = /诊断|排查|根因|\b(?:diagnos\w*|investigate|root cause|debug)\b/.test(text);
  const existingPlan = /(?:已有|现有)(?:实现|执行)?(?:计划|方案)|不要重新规划|无需重新规划|\b(?:(?:existing|approved) (?:(?:implementation|execution) )?plan|do not replan|don't replan)\b/.test(text);
  const narrow = /(?:只|仅).{0,12}(?:一个|单个|单|这个)文件|单文件|\b(?:one file|single file|this file only)\b/.test(text);
  const wordingOnly = /(?:拼写|措辞|标点|\b(?:spelling|wording|typo|punctuation)\b)/.test(text)
    && /readme|changelog|markdown|文档|注释|\b(?:docs?|comments?)\b/.test(text)
    && /仅|只|\bonly\b/.test(text);
  return { primaryOnly, limitedAgents, readOnly: explicitReadOnly || (diagnosis && !writeIntent), existingPlan, narrow, wordingOnly };
}

/** 按范围、任务意图、风险选择候选路线，不直接启动代理。@example routePrompt('查找调用链', config) */
function routePrompt(prompt, config) {
  const text = normalizedPrompt(prompt);
  if (!text) {
    return { category: 'generic', route: 'generic', shouldDispatch: false };
  }

  const constraints = promptConstraints(text);
  const review = includesAny(text, REVIEW_TERMS)
    || /\b(?:inspect|check)\b.{0,40}\b(?:patch|changes?|diff)\b.{0,30}\bregressions?\b/.test(text);
  const highRisk = !constraints.wordingOnly && includesAny(text, HIGH_RISK_TERMS);
  const hard = includesAny(text, HARD_TERMS)
    || (includesAny(text, ['调试', 'debug', '排查', 'diagnose'])
      && includesAny(text, ['复杂', '疑难', '困难', 'complex', 'difficult', 'hard']));
  const plan = includesAny(text, PLAN_TERMS);
  const lookup = includesAny(text, LOOKUP_TERMS);
  const broad = includesAny(text, BROAD_SCAN_TERMS);
  const crossFile = includesAny(text, CROSS_FILE_TERMS);
  const implementation = !constraints.readOnly && includesAny(text, IMPLEMENT_TERMS);
  const inspectArchitecture = /(?:分析|梳理|了解|解释).{0,20}(?:架构|模块)|\b(?:explain|inspect|map|understand)\b.{0,30}\b(?:architecture|modules?)\b/.test(text);
  const nonTrivialPlan = plan && !constraints.existingPlan && !inspectArchitecture && (
    text.length >= 80
    || includesAny(text, NON_TRIVIAL_PLAN_TERMS)
    || crossFile
    || broad
  );

  const needsGraph = !constraints.wordingOnly && (crossFile || broad || inspectArchitecture || review);
  const result = (category, extra = {}) => ({ category, route: category, shouldDispatch: true, needsGraph, ...constraints, ...extra });
  if (constraints.primaryOnly) return result('primary-only', { shouldDispatch: false });
  if (constraints.wordingOnly) return result('generic', { shouldDispatch: false, reason: 'wording-only document edit/review' });
  if (constraints.narrow || (!review && exactNarrowLookup(text))) {
    return result(highRisk ? 'primary-risk' : 'generic', {
      shouldDispatch: false, reason: 'explicit narrow scope is primary-agent work',
    });
  }
  if (review) return result(highRisk ? 'high-risk-review' : 'review');
  if (constraints.readOnly) {
    return result(broad ? 'broad-search' : (crossFile ? 'bounded-search' : 'diagnosis'));
  }
  if (nonTrivialPlan && !hard) return result('plan');
  if (implementation && highRisk) return result('high-risk-implementation');
  if (hard) {
    return result('hard-task', { requiresPlanner: nonTrivialPlan });
  }
  if (implementation) {
    return result('implementation', { shouldDispatch: !includesAny(text, TRIVIAL_EDIT_TERMS) });
  }
  if (broad || (lookup && includesAny(text, ['全局', '全面', '广泛', 'wide', 'broad']))) {
    return result('broad-search');
  }
  if (crossFile || inspectArchitecture || (lookup && includesAny(text, ['多个', 'many', 'several']))) {
    return result('bounded-search', { needsGraph: crossFile || inspectArchitecture });
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
 * Return the short, prompt-specific dispatch guidance injected by UserPromptSubmit.
 *
 * SessionStart owns the static policy; this function only adds the route that
 * matches the current prompt and stays silent for trivial work.
 */
function promptGuidance(prompt, config) {
  const route = routePrompt(prompt, config);
  if (route.category === 'primary-risk') return `任务路由：单文件风险检查/修复，由主代理处理。先核对权限、安全或并发契约的证据与现有授权，按实际风险验证，不扩大用户指定范围。${route.readOnly ? '保持只读，不执行修复。' : ''}`;
  if (!route.shouldDispatch) return '';
  const graph = route.needsGraph
    ? ' 涉及结构、依赖或审查上下文时优先图查询，再读源码核对；图刷新由 CodeMap Boost 负责，不要重复 build/update。'
    : '';
  const agentLimit = route.limitedAgents
    ? ' 用户声明的代理数量或并行限制优先于默认并发额度；复用已有合适角色或由主代理处理，不把候选列表变成多个必须启动的代理。'
    : '';
  return routeGuidance(route, config) + graph + agentLimit;
}

/** 生成与已解析范围一致的角色建议。@example routeGuidance(route, config) */
function routeGuidance(route, config) {
  switch (route.category) {
    case 'diagnosis':
      return `任务路由：只读诊断。仅收集现象、根因证据和验证办法，不执行修复。${roleFallback(config, ['dispatch_explorer', 'dispatch_mapper'])} 子任务必须保持只读。`;
    case 'high-risk-implementation':
      return `任务路由：涉及安全、权限或并发等风险的实现。主代理先核对真实调用路径、契约、已有授权和验收标准；明确边界后才委派有界修改，不因关键词扩大权限或重复请求已有授权。${dynamicWriterGuidance(config)} ${REVIEW_FEEDBACK_GUIDANCE}`;
    case 'high-risk-review':
      return `任务路由：高风险审查。${roleFallback(config, ['dispatch_deep_reviewer', 'dispatch_reviewer'])}`;
    case 'hard-task': {
      const writer = dynamicWriterGuidance(config);
      if (!route.requiresPlanner) {
        return `任务路由：困难实现/复杂调试。主代理先固定范围和验收标准；${writer} ${REVIEW_FEEDBACK_GUIDANCE} 不要仅因任务困难启动规划角色。`;
      }
      return `任务路由：包含规划的困难任务。先核对现有方案，主代理负责架构和接口决策。${roleFallback(config, ['dispatch_planner'])} 已有可执行方案时直接推进，无需重复规划；委派分析后先整合结果，再执行依赖它的修改。${writer} ${REVIEW_FEEDBACK_GUIDANCE}`;
    }
    case 'plan':
      return `任务路由：非琐碎计划/架构。${roleFallback(config, ['dispatch_planner'])}`;
    case 'broad-search':
      return `任务路由：广泛/跨模块只读搜索。${roleFallback(config, ['dispatch_mapper', 'dispatch_explorer'])} 不在搜索子任务中修改文件。`;
    case 'bounded-search':
      return `任务路由：跨文件/调用链只读搜索。${roleFallback(config, ['dispatch_explorer'])} 不在搜索子任务中修改文件；精确单符号/单文件快速查找由主代理直接完成。`;
    case 'implementation':
      return `任务路由：常规实现。${dynamicWriterGuidance(config)} ${REVIEW_FEEDBACK_GUIDANCE}`;
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
  const modelWarnings = modelEffortWarnings(config);
  if (compact) {
    const lines = [
      'Agent Dispatch：你是主代理。需求澄清、架构/接口决策、任务拆分、结果审查和最终整合由主代理负责；',
      '明确、有界的编码、重构和修 bug 可交给可写执行子代理，即使步骤串行也可委派；琐碎读取、小改和强耦合步骤直接完成。',
      '按角色描述、歧义、约束、验收反馈及整个任务的总成本（上下文、返工、审查、延迟）从已启用候选中选角色、模型和推理强度；高歧义可直接选更强候选，不机械按关键词或给所有角色拉满。关键词路由不覆盖授权、只读范围或已有方案。',
      '未固定模型的 writer 必须显式传 model 与 effort，避免无意继承昂贵主模型。原生 TOML 固定值优先于 spawn 参数；临时组合应选未固定字段角色并显式传参。按宿主规则，当前完整历史 fork 不接受覆盖，应按宿主支持仅传最小必要上下文。',
      '启动前核对模型/推理组合，不把主任务的 ultra 强加给不支持它的模型；默认组合不可用时选受支持组合或由主代理处理，用户明确指定的模型不得擅自替换。',
      '代码结构查询优先使用可用图工具；Agent Dispatch 只负责选代理，图刷新和检索规则由 CodeMap Boost 负责，不要重复 build/update。',
      `独立且并行有收益时委派；最多 ${maxParallel} 个子代理并发。所有 Git 命令均由主代理串行执行，不委派、不并行拆分。`,
      '审查先核对任务意图、构建配置、真实入口/调用契约与实际执行路径；只有具体证据证明影响本次验收目标的缺陷才阻塞。上下文缺失、假设性并发和风格建议作为非阻塞提示或待核对项，不自动返修，也不触发确认停工。',
      '非琐碎实现完成针对性验证后必须独立审查，并按风险与有效配置选 reviewer；若用户限定只用主代理或禁用 reviewer，则由主代理审查并说明范围。审查指出实质问题时，主代理先核实其证据与验收影响，再复用原 writer 有界修复、重跑受影响检查并复查；问题重复且无新证据时调整拆分、提高模型或由主代理介入，不能无限重写。小修改不强制每个角色。',
      '子代理须报告修改文件、验证和阻塞；结果已整合或不再需要时立即停止子代理，避免占用有限智能体名额。',
    ];
    if (profiles.length) lines.push(`配置候选角色（以宿主实际加载为准）：${profiles.join('；')}。`);
    if (modelWarnings.length) lines.push(`模型配置校验：${modelWarnings.join(' ')}`);
    return lines.join('');
  }
  const lines = [
    'Agent Dispatch policy for the primary Codex agent:',
    '- Keep requirements clarification, architecture and interface decisions, task decomposition, result review, and final integration in the primary agent.',
    '- Prefer a workspace-write execution agent for concrete, bounded implementation, refactoring, and bug-fix work once the steps and acceptance criteria are clear, even when that work is sequential.',
    '- Choose among enabled candidates from role descriptions, ambiguity, constraints, acceptance feedback, explicit user preference, host availability, and total task cost including context, rework, review, and latency. High ambiguity may justify a stronger candidate immediately; do not route code mechanically by keywords or maximize every role.',
    '- For an unpinned writer, explicitly pass model and effort so it does not accidentally inherit an expensive primary model. Native TOML model/effort values override spawn parameters; for a temporary combination choose a role with unpinned fields and pass both explicitly. Under the host rules, the current full-history fork does not accept overrides, so pass only the minimum needed context using a host-supported combination.',
    '- Profile defaults and keyword routes are suggestions, not proof of runtime availability or permission to override user scope. Verify the host-supported model/effort pair before spawning; never carry ultra blindly into a model that does not support it. Fall back from unavailable defaults to supported settings or primary-agent work, but do not silently replace an explicitly requested model.',
    '- For structural code queries, prefer available graph tools. Agent Dispatch selects the agent; CodeMap Boost owns graph refresh and retrieval policy, so do not duplicate build/update.',
    '- Delegate independent bounded subtasks in parallel when useful.',
    `- Use no more than ${maxParallel} subagents concurrently unless the user explicitly requests more.`,
    '- Keep trivial reads, small edits, tightly coupled steps, and final integration in the primary agent.',
    '- Before treating a review finding as blocking, verify task intent, build configuration, real entry points and call contracts, and the actual execution path. Only a defect supported by concrete evidence and affecting the current acceptance target can block. Missing context, hypothetical concurrency, and style suggestions are non-blocking notes or items to verify; they do not trigger automatic rework or stop for confirmation.',
    '- After targeted validation, independently review non-trivial implementation. If the user requires primary-agent-only work or disables reviewers, the primary agent performs the review and states its scope. Small changes do not require every role.',
    '- When review finds a verified substantive issue affecting acceptance, the primary agent reuses the original writer for a bounded fix, reruns affected checks, and reviews again. If an issue repeats without new evidence, change the decomposition, raise the model, or intervene in the primary agent instead of adding speculative changes indefinitely.',
    '- Stop subagents promptly after their result is integrated, or when they are blocked or no longer needed; do not leave idle agents occupying limited slots.',
    '- Execute all Git commands in the primary agent, one at a time; never delegate or parallelize Git operations.',
    '- Delegation does not broaden filesystem, network, approval, or external-action authority.',
    '- Ask subagents to report every changed file, validation performed, and any blocker; reread their outputs before integration.',
    '- Do not delegate vague design decisions; give execution agents a concrete scope, file ownership, acceptance criteria, and validation target.',
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
    '- Execute the assigned bounded task directly and stay within its scope.',
    '- Do not spawn or delegate to more agents unless the user or primary agent explicitly asked you to do so.',
    '- Do not run Git commands; leave all Git operations to the primary agent.',
    '- Agent Dispatch selects the agent; CodeMap Boost owns graph refresh and retrieval. Follow its rules when present; do not duplicate build/update.',
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
    return `Agent Dispatch：${toolName} 不在轻量 MCP 列表中；主代理按实际任务判断分派收益，不能仅因工具名称委派。若当前已是子代理，直接执行分配任务。`;
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
