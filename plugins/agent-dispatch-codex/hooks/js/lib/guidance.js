'use strict';

const { analyzeShellCommand } = require('./shell');
const { GIT_HANDOFF, profileSummary } = require('./agent_profiles');
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
  '计划', '决策', 'decision', '选型', '策略', 'strategy',
];
const IMPLEMENT_TERMS = [
  '实现', 'implement', 'implementation', '修复', 'fix', 'bug', '编码',
  '修改', '改动', '迁移', 'migrate', '重构', 'refactor', '构建', 'build',
  '开发', 'develop',
];
const DELIVERY_TERMS = [
  '制作', '产出', '撰写', '编写', '生成', '整理', '填入', '填表',
  '更新文档', '创建原型', '制作原型', 'produce', 'deliver', 'draft', 'write',
  'create a prototype', 'build a prototype', 'prepare a report', 'create a report',
];
// 制作动作由交付与计划识别共享；计划作为产出对象时仍需规划，不能因换个动词落入普通执行。
const CREATION_ACTIONS_CN = ['制作', '产出', '撰写', '编写', '生成', '创建'];
const CREATION_ACTIONS_EN = ['produce', 'draft', 'write', 'create', 'prepare'];
const DELIVERY_ACTION_PATTERN = new RegExp(
  `^(?:请|帮我)?(?:按.{0,30})?(?:${[...CREATION_ACTIONS_CN, '交付', '整理', '填入', '填表'].join('|')})`
  + `|^(?:please\\s+)?(?:${[...CREATION_ACTIONS_EN, 'deliver'].join('|')})\\b`
);
const PLAN_CREATION_PATTERN = new RegExp(
  `(?:${[...CREATION_ACTIONS_CN, '制定', '规划', '拟定', '设计'].join('|')})[^，。；,;.!?]{0,30}(?:计划|方案|策略)`
  + `|\\b(?:${[...CREATION_ACTIONS_EN, 'design'].join('|')})\\b[^，。；,;.!?]{0,30}\\b(?:plan|strategy)\\b`
);
const VERIFICATION_TERMS = [
  '验证', '验收', '测试', '复现', '核验', '质检', '质量检查', 'qa', 'test',
  'verify', 'validate', 'verification', 'acceptance check', 'reproduce',
];
const VERIFICATION_ACTION_TERMS = [
  '运行测试', '执行测试', '开始测试', '执行验证', '按已有用例', '按既有用例',
  '按用例验证', '验证结果', '验证交付物', 'run tests', 'execute tests',
  'run the tests', 'verify the result', 'validate the deliverable', 'execute qa',
];
const EXTERNAL_RESEARCH_TERMS = [
  '外部研究', '外部调研', '网络调研', '互联网', '官网', '官方来源', '公开来源',
  '最新资料', '市场调研', '竞品', '行业研究', 'web research', 'external research',
  'official sources', 'public sources', 'latest information', 'market research',
  'competitor', 'competitive research',
];
const CODE_CONTEXT_TERMS = [
  '代码', '源码', '代码仓库', '源码仓库', '代码库', '函数', '代码符号', '调用链', '调用方',
  '代码引用', '接口实现', '接口迁移', '代码补丁', '代码审查', 'code', 'source code',
  'repository', 'repo', 'function', 'code symbol', 'call chain', 'callers',
  'callees', 'code patch', 'code review', 'source diff',
];
const LOW_COST_LOG_TERMS = [
  '日志', 'log', 'logs', 'trace', 'stack trace', 'stderr', 'stdout', 'dump', 'event log',
];
const LOW_COST_DOCUMENT_TERMS = [
  '文档', 'document', 'documents', 'docs', 'readme', 'markdown', '.md', '.txt',
  'pdf', 'docx', 'doc', 'rtf', 'xml', 'csv', 'json', 'tsv', 'xlsx', 'spreadsheet',
];
const LOW_COST_TEXT_TERMS = ['原文', '文本', 'text', 'transcript'];
const LOW_COST_EXTRACTION_TERMS = [
  '提取', '抽取', '摘录', '整理', '汇总', '总结', '归纳', '读取', '阅读',
  '读写', '写入', '写', '编辑', '更新', '替换', '修改',
  'extract', 'parse', 'summarize', 'summary', 'organize', 'aggregate', 'collect',
  'read', 'write', 'edit', 'update', 'replace',
];
const LOW_COST_CODE_EVIDENCE_TERMS = [
  '调用方', '调用关系', '引用关系', '影响面', '依赖关系', '源码检索', '代码检索', '取证',
  'callers', 'callees', 'call chain', 'reference graph', 'impact radius', 'source search',
  'code search', 'depends on',
];
const LOW_COST_CODE_TEST_TERMS = [
  'ctest', '单元测试', '回归测试', 'unit test', 'unit tests', 'regression test',
  'regression tests', '代码测试', '源码测试', 'npm test', 'cargo test', 'pytest',
];
const LOW_COST_ESTABLISHED_TEST_TERMS = [
  '既定测试', '现有测试', '已有测试', 'approved test', 'existing test',
];
const LOW_COST_TEST_EXECUTION_TERMS = [
  '运行', '执行', '开始', '验证', '验收', '核验', 'run', 'execute', 'perform',
  'verify', 'validate', 'check',
];
const CODE_CREATION_ACTION_TERMS = [
  '实现', '编写', '写', '创建', '新增', '增加', '生成', '更新', '修改', '构建', '开发', '编码',
  'implement', 'write', 'create', 'add', 'generate', 'update', 'modify', 'build', 'develop',
];
const CODE_CREATION_ARTIFACT_TERMS = [
  '代码', '源码', '解析器', '处理器', '函数', '方法', '模块', '类', '组件', '服务',
  '脚本', '算法', '测试代码', 'parser', 'processor', 'handler', 'function', 'method', 'module',
  'class', 'component', 'service', 'script', 'algorithm', 'test code',
];
const MATERIAL_OPERATION_TERMS = [
  '已有', '现有', '这些', '指定', '给定', '模板', '原格式', '字段', '版本号', '批量',
  '保留', 'existing', 'specified', 'given', 'template', 'original format', 'field',
  'version', 'batch', 'preserve',
];
const DOCUMENT_WRITE_TERMS = [
  '写入', '写', '编辑', '更新', '替换', '修改', 'write', 'edit', 'update', 'replace', 'modify',
];
const LOOKUP_TERMS = [
  '查找', '搜索', '搜寻', '检索', '定位', '查询', '调查', '研究', '扫描', '梳理',
  'find', 'search', 'retrieve', 'retrieval', 'lookup', 'investigate', 'investigation', 'research', 'scan',
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
  '测试计划', '验收标准', '策略', 'strategy', '可行性', 'plan first',
  'plan then', 'implementation plan', 'test plan', 'acceptance criteria',
];
const TRIVIAL_EDIT_TERMS = [
  'getter', 'setter', '拼写', 'typo', '加个注释', '添加注释', '补个注释',
  '类型定义', '这一行', '一行代码', '单行修改', 'one-line', 'single-line',
];
const REVIEW_FEEDBACK_GUIDANCE = '交付物由主代理验收并整合；按交付物选择相称证据完成针对性验证后，再独立审查非琐碎成果。若用户限制 reviewer，则由主代理审查并说明范围；只对有具体证据且影响本次验收的实质问题，经主代理核实后复用原 writer 有界修复并复查，提示项不自动返修或停工。';
const PROMPT_ROUTE_NOTICE = 'Agent Dispatch 候选建议（仅据当前消息推断）：按完整对话及用户最新明确要求核对，不能当作宿主限制或跨轮约束。';

function taskScopeGuidance(language = 'zh') {
  if (language === 'en') {
    return 'Infer the current task from the full conversation and the latest explicit user instructions. Product behavior and quoted material are not task restrictions. Agent Dispatch keyword routes are fallible suggestions, not host restrictions or persistent task state. A later turn with no routing hint does not preserve an earlier route; continue the authorized objective while retaining actual user constraints that have not been changed.';
  }
  return '按完整对话和用户最新明确要求判断当前任务。产品行为和引用材料不等于任务限制；Agent Dispatch 关键词路线可能误判，只是候选建议，不是宿主限制或持久任务状态。后续没有新建议不代表旧路线继续生效；在已有授权内推进，保留尚未被用户改变的真实约束。';
}

function reviewLifecycleGuidance(language = 'zh', subagent = false) {
  if (subagent) {
    return '若被分派审查但实际 model/effort 与目标不符或不可观察，保留辅助证据并回报主代理，不宣称审查已通过，不得自行转派。';
  }
  if (language === 'en') {
    return 'For every new or reused review agent, reassess its responsibility and autonomously choose a supported model/effort from effective enabled reviewer candidates based on ambiguity, risk, quality needs, and total completion cost; explicit user requirements take precedence. Reassess when scope or risk changes. Judging correctness, compatibility, defects, or acceptance is review even for small, read-only, or follow-up checks; small scope alone does not justify the low-cost evidence route. Keywords are routing hints, not a substitute for task judgment. Fixed profile values override spawn arguments, and a task name is not evidence of the actual model. Before spawning, verify host support and actual profile loading. Before accepting the conclusion, check observable host model/effort metadata; if unavailable, mark it unconfirmed. Reuse only a matching current pair: a message cannot change an existing agent model. Honor primary-only requests and disabled review delegation. When an enabled reviewer target exists but its named role is not loaded, use a supported generic spawn with the selected pair or the primary agent. Evidence collection and established test results do not by themselves constitute an independent review. These hooks provide guidance, not a hard spawn interceptor.';
  }
  return '每次新建或复用审查代理，重新判断职责，按歧义、风险、质量要求和总完成成本，从有效且启用的 reviewer 候选自主选择受支持的 model/effort；用户明确指定优先，职责或风险变化时重新评估。判断正确性、兼容性、缺陷或验收结论属于审查，不能仅因范围小、只读或修改后复查就套用取证路线；关键词只作提示，不替代任务判断。profile 固定值高于 spawn 参数，task_name 不是实际模型证据。启动前核对宿主支持及 profile 实际加载，接收结论前核对宿主可观察的实际 model/effort；不可观察时标记未确认。只复用当前组合匹配的代理，不能靠消息更换已有代理模型；不匹配时重新创建合规审查代理或由主代理处理。用户限定主代理或禁用审查分派时由主代理处理；有效 reviewer 目标存在但命名角色未加载时，可用宿主支持的 generic spawn 显式传入选定组合或由主代理处理。纯证据收集或既定测试结果不等于独立审查通过。Hook 仅提供指导，不是 spawn 硬拦截。';
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

function isPureGitCli(prompt, config) {
  const command = typeof prompt === 'string' ? prompt.trim() : '';
  if (!command) return false;
  const analysis = analyzeShellCommand(command, config);
  return analysis.safe && analysis.heads.length > 0
    && analysis.heads.every((head) => head === 'git');
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

function lowCostPolicy(config) {
  const defaults = {
    enabled: true,
    model: 'gpt-6-luna',
    effort: 'max',
  };
  const configured = config && config.policy && config.policy.low_cost;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    return defaults;
  }
  return {
    enabled: configured.enabled !== false,
    model: typeof configured.model === 'string' && configured.model.trim()
      ? configured.model.trim() : defaults.model,
    effort: typeof configured.model_reasoning_effort === 'string'
      && configured.model_reasoning_effort.trim()
      ? configured.model_reasoning_effort.trim() : defaults.effort,
  };
}

function profileSettings(config, name) {
  const settings = config && config.agent_profiles;
  if (!settings || settings.enabled === false || !settings.profiles) return null;
  const profile = settings.profiles[name];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
      || profile.enabled === false || profile.role_kind === 'verification') {
    return null;
  }
  const model = typeof profile.model === 'string' ? profile.model.trim() : '';
  const effort = typeof profile.model_reasoning_effort === 'string'
    ? profile.model_reasoning_effort.trim() : '';
  return { model, effort };
}

/**
 * 选择默认低成本候选：优先复用已固定为目标模型/档位的 Luna worker，
 * 再使用未固定的 worker 并要求主代理显式传入目标组合。
 *
 * @example lowCostCandidate(config)
 */
function lowCostCandidate(config) {
  const target = lowCostPolicy(config);
  if (!target.enabled) return null;
  const targetWarnings = modelEffortWarnings({
    policy: {
      low_cost: {
        enabled: true,
        model: target.model,
        model_reasoning_effort: target.effort,
      },
    },
    agent_profiles: { enabled: false },
  });
  if (targetWarnings.length) return null;

  const luna = profileSettings(config, 'dispatch_luna_worker');
  if (luna && luna.model === target.model && luna.effort === target.effort) {
    return { name: 'dispatch_luna_worker', model: target.model, effort: target.effort, explicit: false };
  }

  const worker = profileSettings(config, 'dispatch_worker');
  if (worker && ((worker.model === target.model && worker.effort === target.effort)
      || (!worker.model && !worker.effort))) {
    return {
      name: 'dispatch_worker',
      model: target.model,
      effort: target.effort,
      explicit: !(worker.model === target.model && worker.effort === target.effort),
    };
  }
  return null;
}

function lowCostLabel(candidate) {
  if (!candidate) return '';
  const pair = `${candidate.model}/${candidate.effort}`;
  return candidate.explicit
    ? `${candidate.name}（显式 ${pair}）`
    : `${candidate.name} (${pair})`;
}

function lowCostKindLabel(kind) {
  return {
    logs: '日志检索与摘录',
    documents: '机械文档读写与文本整理',
    'structured-data': '机械结构化数据整理',
    'established-tests': '既定代码测试与失败证据收集',
    'code-evidence': '代码检索与调用取证',
  }[kind] || '机械证据处理';
}

function lowCostGuidance(route, config) {
  const policy = lowCostPolicy(config);
  const candidate = lowCostCandidate(config);
  const kind = lowCostKindLabel(route.lowCostKind);
  if (!candidate) {
    return `任务路由：低成本${kind}。当前没有启用并匹配 ${policy.model}/${policy.effort} 的合规低成本角色；不得静默改用更贵模型。若确需该证据子任务，将其缩小或保留阻塞，不把长原文转给主代理；主代理继续不依赖它的已授权工作。`;
  }
  const scope = route.readOnly
    ? '保持只读，只回传必要证据'
    : route.lowCostKind === 'documents'
      ? '文档写入只限指定文件和字段'
      : route.lowCostKind === 'structured-data'
        ? '只处理指定字段和记录，保留来源与去重依据'
    : route.lowCostKind === 'established-tests'
      ? '只运行既定用例，不修改被测交付物或产品代码'
      : '保持只读，只回传必要证据';
  return `任务路由：低成本${kind}。若实际职责匹配，默认委派给 ${lowCostLabel(candidate)}；所分派子任务${scope}，回传证据位置、必要摘录、验证与阻塞，不传整篇原文。主代理仍负责完整任务的范围、授权和最终整合，并按用户显式偏好与宿主实际支持的模型/推理组合核对是否委派。`;
}

function lowCostEvidenceGuidance(route, config) {
  if (!route.lowCostEvidence || !route.lowCostKind) return '';
  const policy = lowCostPolicy(config);
  const candidate = lowCostCandidate(config);
  const kind = lowCostKindLabel(route.lowCostKind);
  if (!candidate) {
    return ` 任务包含可拆分的${kind}证据，但当前没有匹配 ${policy.model}/${policy.effort} 的低成本角色；保留为有界证据子任务或暂缓，不静默使用更贵模型，也不把整单降级。`;
  }
  return ` 任务中的${kind}可先拆分为低成本证据子任务，交给${lowCostLabel(candidate)}收集必要证据；复杂实现、关键方案和代码审查仍由主代理按实际复杂度选择，不把整单降级。`;
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
function dynamicWriterGuidance(config, options = {}) {
  const codeWork = options.codeWork === true;
  const profiles = config && config.agent_profiles && config.agent_profiles.profiles;
  const settingsEnabled = config && config.agent_profiles
    && config.agent_profiles.enabled !== false && profiles;
  const eligible = (name) => {
    if (!settingsEnabled) return null;
    const profile = profiles[name];
    if (!profile || profile.enabled === false
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
    const defaultCandidate = sol && sol.model === 'gpt-6-sol' && sol.effort === 'medium'
      ? `${sol.name} (gpt-6-sol/medium)`
      : ['dispatch_worker', 'dispatch_hard_worker']
        .map(eligible)
        .find((profile) => profile && !profile.model && !profile.effort);
    const alternatives = ['dispatch_terra_worker', 'dispatch_astra_worker', 'dispatch_hard_worker']
      .map(eligible)
      .filter((profile) => profile && profile.name !== (defaultCandidate && defaultCandidate.name || ''))
      .map((profile) => profile.model && profile.effort
        ? `${profile.name} (${profile.model}/${profile.effort})`
        : `${profile.name}（显式选择受支持组合）`);
    if (!defaultCandidate) {
      const alternativeGuidance = alternatives.length
        ? `，或按任务复杂度与用户明确偏好选择已启用替代角色 ${alternatives.join('、')}`
        : '';
      return `当前没有符合默认 Sol/medium 组合的代码实现候选，由主代理直接完成${alternativeGuidance}。`;
    }
    const defaultLabel = typeof defaultCandidate === 'string'
      ? defaultCandidate
      : `${defaultCandidate.name}（显式 gpt-6-sol/medium）`;
    const alternativeGuidance = alternatives.length
      ? `；任务复杂度或用户明确偏好需要时，也可从已启用候选 ${alternatives.join('、')} 中选择`
      : '';
    return `可写执行角色的代码实现默认候选为 ${defaultLabel}${alternativeGuidance}，按实际复杂度和用户明确偏好选择模型和推理强度。固定 profile 的有效配置优先，未固定角色须显式传 model 与 effort；启动前核对宿主实际支持，未加载或不合规时由主代理完成。`;
  }
  const hasWritableProfile = Object.keys(profiles || {}).some((name) => eligible(name));
  if (!hasWritableProfile) return '当前没有启用的可写执行角色，由主代理直接完成。';
  return '主代理按实际复杂度从已启用候选选择可写执行角色、模型和推理强度，不按领域词固定模型。未固定模型的 writer 必须显式传入 model 与 effort，避免无意继承昂贵主模型。';
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
    || includesAny(text, ['查看', '分析', '运行', '执行', 'inspect', 'review']);
  const codeEvidence = explicitCodeContext
    && (lookup || crossFile || includesAny(text, LOW_COST_CODE_EVIDENCE_TERMS));
  const testExecution = includesAny(text, LOW_COST_TEST_EXECUTION_TERMS);
  const explicitCodeTest = includesAny(text, LOW_COST_CODE_TEST_TERMS);
  const establishedTestWithCodeContext = includesAny(text, LOW_COST_ESTABLISHED_TEST_TERMS)
    && explicitCodeContext
    && includesAny(text, ['测试', '用例', 'test', 'case', 'qa']);
  if (hasLogs && (hasExtractionAction || lookup
      || includesAny(text, ['修复', '排查', 'debug', 'fix', 'crash', 'error']))) return 'logs';
  if (codeEvidence) return 'code-evidence';
  if (!codeCreationIntent && testExecution && (explicitCodeTest || establishedTestWithCodeContext)) {
    return 'established-tests';
  }
  if (codeCreationIntent) return '';
  if (hasStructuredData && hasExtractionAction) return 'structured-data';
  if ((hasDocuments || hasText) && hasExtractionAction) return 'documents';
  return '';
}

/** 判断当前消息中是否有直接的只读任务指示，不把产品行为当作全局范围。 */
function hasReadOnlyDirective(text) {
  // 只读线索须出现在请求分句的开头，不能从产品行为中的任意子串推导任务权限。
  // 这仍是路由启发式；最终范围由主代理结合完整对话判断。
  const prose = text.replace(/```[^]*?```|~~~[^]*?~~~/g, '')
    .replace(/^\s*>.*$/gm, '');
  return prose.split(/[，。！？；,.!?;\n]+/).some((clause) => {
    const directive = clause.trim()
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/^(?:(?:请(?:你)?|先|暂时|本次|本轮|这次|你)\s*)+/, '')
      .replace(/^(?:(?:please|for now)\s+)+/, '');
    return /^(?:只读(?=$|\s|[：:]|分析|诊断|审查|调查|检查|查看|读取|排查)|(?:仅|只)(?:分析|诊断|审查|调查)|(?:不要|禁止|不允许|不得|不)(?:修改|改动|编辑|写入|改))/.test(directive)
      || /^(?:read[- ]only(?:$|\s+(?:analysis|diagnosis|review|inspection|investigation)\b)|do not (?:edit|modify|write)\b|don't (?:edit|modify|write)\b|diagnosis only\b)/.test(directive);
  });
}

/** 提取路由范围线索；这些启发式结果不构成写入或委派授权。 */
function promptConstraints(text) {
  const primaryOnly = /只(?:用|由|让)?主代理|仅(?:用|由|让)?主代理|(?:不要|禁止|不用|不允许)(?:再)?(?:委派|分派|子代理|子任务)|\b(?:primary agent only|main agent only|no subagents?|no delegation|do not delegate|don't delegate)\b/.test(text);
  const limitedAgents = /(?:只|仅|最多).{0,8}(?:一个|一名|1 个|1名)(?:子)?代理|不要多个代理|不要并行|\b(?:only one agent|at most one subagent|no parallel agents|do not parallelize)\b/.test(text);
  const explicitReadOnly = hasReadOnlyDirective(text);
  const writeIntent = /实现|修复|迁移|重构|编码|\b(?:implement|fix|migrate|refactor|edit|modify|develop)\b/.test(text);
  const diagnosis = /诊断|排查|根因|\b(?:diagnos\w*|investigate|root cause|debug)\b/.test(text);
  const existingPlan = /(?:(?:已有|现有|已批准|已确认|批准的|确认的)(?:实现|执行|测试|验证|设计)?(?:计划|方案|用例))|不要重新规划|无需重新规划|\b(?:(?:existing|approved) (?:(?:implementation|execution|test|qa|design) )?(?:plan|cases?)|do not replan|don't replan)\b/.test(text);
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

  // Git CLI arguments such as "fix", "review", or "architecture" are data,
  // not task intent. Suppress routing only for a safely parsed, all-Git
  // command; a non-Git natural-language prefix or mixed shell stays routable.
  if (isPureGitCli(prompt, config)) {
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
    || (includesAny(text, ['调试', 'debug', '排查', 'diagnose'])
      && includesAny(text, ['复杂', '疑难', '困难', 'complex', 'difficult', 'hard']));
  const plan = includesAny(text, PLAN_TERMS);
  const lookup = includesAny(text, LOOKUP_TERMS);
  const broad = includesAny(text, BROAD_SCAN_TERMS);
  const crossFile = includesAny(text, CROSS_FILE_TERMS);
  const hasImplementationTerm = includesAny(text, IMPLEMENT_TERMS);
  const designDeliverable = includesAny(text, ['原型', '线框图', '成稿', 'prototype', 'mockup', 'wireframe'])
    && includesAny(text, ['制作', '创建', '生成', '设计', 'produce', 'create', 'build', 'design']);
  const explicitDeliveryAction = DELIVERY_ACTION_PATTERN.test(text);
  const delivery = !constraints.readOnly
    && (includesAny(text, DELIVERY_TERMS) || designDeliverable || explicitDeliveryAction);
  const directVerification = /^(?:请)?(?:验证|核验|验收|测试|复现)/.test(text)
    || /^(?:please\s+)?(?:verify|validate|test|reproduce)\b/.test(text);
  const verification = includesAny(text, VERIFICATION_TERMS)
    && (includesAny(text, VERIFICATION_ACTION_TERMS)
      || directVerification
      || /(?:按|依据|依照|使用|运行|执行|run|execute|perform|use).{0,30}(?:用例|测试|验证|验收|cases?|tests?|qa|verification)/.test(text));
  const explicitModificationAction = /^(?:请|帮我)?(?:实现|修复|修改|改动|迁移|重构|编码|开发)/.test(text)
    || /(?:并|然后|再|之后|后|[，,;；])\s*(?:再)?(?:实现|修复|修改|改动|迁移|重构|编码|开发)/.test(text)
    || /^(?:please\s+)?(?:implement|fix|modify|edit|migrate|refactor|develop)\b/.test(text)
    || /\b(?:and|then|after that)\s+(?:implement|fix|modify|edit|migrate|refactor|develop)\b/.test(text);
  const testImplementation = /(?:写|编写|添加|补|补充|新增|增加|更新|修改|覆盖).{0,8}(?:单元测试|回归测试|测试用例|测试代码|代码测试|源码测试)/.test(text)
    || /(?:写|编写|添加|补充|新增)\s*测试(?:$|[，。,.]|代码|覆盖)/.test(text)
    || /\b(?:write|add|cover|implement)\b.{0,24}\b(?:unit tests?|regression tests?|test cases?|code tests?)\b/i.test(text);
  const codeCreationIntent = !constraints.readOnly
    && includesAny(text, CODE_CREATION_ACTION_TERMS)
    && includesAny(text, CODE_CREATION_ARTIFACT_TERMS);
  const hard = hardSignal || ((testImplementation || codeCreationIntent)
    && includesAny(text, ['复杂', '疑难', '困难', 'complex', 'difficult', 'hard']));
  const modificationIntent = explicitModificationAction || includesAny(text, [
    '实现', '修复', '修改', '改动', '迁移', '重构', '编码', '开发',
    'implement', 'fix', 'modify', 'edit', 'migrate', 'refactor', 'develop',
  ]) || testImplementation || codeCreationIntent;
  const implementation = !constraints.readOnly && (hasImplementationTerm || testImplementation || codeCreationIntent)
    && (!verification || explicitModificationAction);
  const externalResearch = includesAny(text, EXTERNAL_RESEARCH_TERMS)
    && includesAny(text, [...LOOKUP_TERMS, '调研', '核对', '比较', 'compare', 'verify']);
  const inspectArchitecture = /(?:分析|梳理|了解|解释).{0,20}(?:架构|模块)|\b(?:explain|inspect|map|understand)\b.{0,30}\b(?:architecture|modules?)\b/.test(text);
  const createsPlan = PLAN_CREATION_PATTERN.test(text);
  const executesPlan = /(?:执行|落实|运行|按|依据|依照|follow|execute|run|carry out).{0,30}(?:计划|方案|plan)/.test(text);
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
    || /\b[a-z_][a-z0-9_.:-]*\s+module\b|\b[a-z_][a-z0-9_.:-]*\s+模块/i.test(text);
  const lowCostKind = detectLowCostKind(text, explicitCodeContext, lookup, crossFile, codeCreationIntent);
  const policyDiscussion = (
    includesAny(text, ['agent dispatch', 'agentdispatch', '调度', '路由', '分派', '委派'])
    && includesAny(text, ['配置', '优化', '讨论', '策略', '规则', '设置', '交给', 'policy', 'configure', 'configuration'])
  ) || (
    includesAny(text, ['低成本', 'luna max', '模型'])
    && includesAny(text, ['配置', '优化', '讨论', '策略', '规则', '设置', 'configure', 'configuration'])
  );
  const materialKind = ['documents', 'structured-data'].includes(lowCostKind);
  const materialWriteIntent = materialKind && includesAny(text, DOCUMENT_WRITE_TERMS);
  const boundedMaterialWrite = !materialWriteIntent || includesAny(text, MATERIAL_OPERATION_TERMS);
  const documentRoutineWrite = materialKind
    && boundedMaterialWrite
    && !includesAny(text, [
      '实现', '修复', '迁移', '重构', '编码', 'implement', 'fix', 'migrate', 'refactor', 'develop',
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
  if (broad || (lookup && includesAny(text, ['全局', '全面', '广泛', 'wide', 'broad']))) {
    return result('broad-search');
  }
  if (crossFile || inspectArchitecture || (lookup && includesAny(text, ['多个', 'many', 'several']))) {
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
 * 返回 UserPromptSubmit 注入的简短任务路线。
 *
 * SessionStart 负责静态策略；这里只补充与当前提示匹配的路线，琐碎任务保持静默。
 */
function promptGuidance(prompt, config) {
  const route = routePrompt(prompt, config);
  if (route.category === 'primary-risk') return `${PROMPT_ROUTE_NOTICE} 任务路由：单文件风险检查/修复，由主代理处理。先核对权限、安全或并发契约的证据与现有授权，按实际风险验证，不扩大用户指定范围。${route.readOnly ? '若用户当前要求只读，则按该范围收集证据。' : ''}`;
  if (!route.shouldDispatch) return '';
  const graph = route.needsGraph
    ? ' 明确涉及代码结构、调用关系或代码审查上下文时优先图查询，再读源码核对；图刷新由 CodeMap Boost 负责，不要重复 build/update。'
    : '';
  const agentLimit = route.limitedAgents
    ? ' 用户声明的代理数量或并行限制优先于默认并发额度；复用已有合适角色或由主代理处理，不把候选列表变成多个必须启动的代理。'
    : '';
  return PROMPT_ROUTE_NOTICE + ' ' + routeGuidance(route, config) + graph + agentLimit;
}

/** 生成与已解析范围一致的角色建议。@example routeGuidance(route, config) */
function routeGuidance(route, config) {
  switch (route.category) {
    case 'low-cost':
      return lowCostGuidance(route, config);
    case 'diagnosis':
      return `任务路由：只读诊断。若当前确为用户要求的调查阶段，可在确认的只读范围内收集现象、根因证据和验证办法。${roleFallback(config, ['dispatch_explorer', 'dispatch_mapper'])} 主代理按实际任务授权决定后续实施。`;
    case 'verification':
      return `任务路由：验证执行。若当前阶段确为既定验证，按用例、验收标准或复现步骤收集证据，在该验证子任务内不修改被验收交付物。${roleFallback(config, ['dispatch_tester'])} 验证方式随交付物选择，不把构建或代码测试强加给设计、文档、运营或数据成果。`;
    case 'external-research':
      return `任务路由：外部研究。${roleFallback(config, ['dispatch_researcher'])} 明确来源、日期和事实/推断边界；工作区已有材料的证据改用 explorer 或由主代理读取。`;
    case 'high-risk-implementation':
      return `任务路由：涉及安全、权限或并发等风险的修改。主代理先核对实际工作流程、契约、已有授权和验收标准，涉及代码时核对真实调用路径；明确边界后才委派有界修改，不因关键词扩大权限或重复请求已有授权。${dynamicWriterGuidance(config, { codeWork: true })} ${reviewFeedbackGuidance()}${lowCostEvidenceGuidance(route, config)}`;
    case 'high-risk-review':
      return `任务路由：高风险审查。${roleFallback(config, ['dispatch_deep_reviewer', 'dispatch_reviewer'])} ${reviewLifecycleGuidance()}`;
    case 'hard-task': {
      const writer = dynamicWriterGuidance(config, { codeWork: true });
      if (!route.requiresPlanner) {
        return `任务路由：困难任务执行。主代理先固定范围和验收标准；${writer} ${reviewFeedbackGuidance()} 不要仅因任务困难启动规划角色。${lowCostEvidenceGuidance(route, config)}`;
      }
      return `任务路由：包含规划的困难任务。先核对现有方案，主代理负责关键方案和公开契约决策。${roleFallback(config, ['dispatch_planner'])} 已有可执行方案时直接推进，无需重复规划；委派分析后先整合结果，再执行依赖它的工作。${writer} ${reviewFeedbackGuidance()}${lowCostEvidenceGuidance(route, config)}`;
    }
    case 'plan':
      return `任务路由：非琐碎计划/方案。${roleFallback(config, ['dispatch_planner'])}`;
    case 'broad-search':
      return `任务路由：广泛范围只读调查。${roleFallback(config, ['dispatch_mapper', 'dispatch_explorer'])} 若委派调查，子代理仅完成确认的取证范围；主代理继续推进完整任务。`;
    case 'bounded-search':
      return `任务路由：有界只读调查。${roleFallback(config, ['dispatch_explorer'])} 若委派调查，子代理仅完成确认的取证范围；精确的小范围快速查找由主代理直接完成，并继续推进完整任务。`;
    case 'implementation':
      return `任务路由：常规实现。${dynamicWriterGuidance(config, { codeWork: true })} ${reviewFeedbackGuidance()}${lowCostEvidenceGuidance(route, config)}`;
    case 'execution':
      return `任务路由：内容制作/交付执行。主代理先固定交付物、受众、格式和验收标准；${dynamicWriterGuidance(config)} ${reviewFeedbackGuidance()}${lowCostEvidenceGuidance(route, config)}`;
    case 'review':
      return `任务路由：常规审查。${roleFallback(config, ['dispatch_reviewer'])} ${reviewLifecycleGuidance()}`;
    case 'generic':
    default:
      return '任务路由：未命中专门类别；由主代理判断边界并直接处理，琐碎编辑默认不启动子代理。';
  }
}

function mainAgentGuidance(config, compact = false) {
  const maxParallel = Number(config.policy.max_parallel_subagents) || 3;
  const profiles = profileSummary(config);
  const modelWarnings = modelEffortWarnings(config);
  const lowCost = lowCostPolicy(config);
  const lowCostPair = `${lowCost.model}/${lowCost.effort}`;
  if (compact) {
    const lines = [
      'Agent Dispatch：你是主代理。需求澄清、关键方案与公开契约决策、任务拆分、结果审查和最终整合由主代理负责；',
      '调查、规划分析、内容或产品制作、运营/文档/数据处理、代码实现、验证和审查等明确有界子任务，可按收益交给匹配角色；琐碎读取、小改和强耦合步骤直接完成。',
      taskScopeGuidance(),
      '按角色描述、歧义、约束、验收反馈及整个任务的总成本（上下文、返工、审查、延迟）从已启用候选中选角色、模型和推理强度；高歧义可直接选更强候选，不机械按关键词或给所有角色拉满。关键词路由不覆盖授权、只读范围或已有方案。',
      '未固定模型的 writer 必须显式传 model 与 effort，避免无意继承昂贵主模型。原生 TOML 固定值优先于 spawn 参数；临时组合应选未固定字段角色并显式传参。按宿主规则，当前完整历史 fork 不接受覆盖，应按宿主支持仅传最小必要上下文。',
      ...(lowCost.enabled ? [`低成本劳动力路线：日志、常规文档/结构化数据、文本提取、代码取证和既定代码测试，默认委派给 policy.low_cost 指定的合规角色（${lowCostPair}）；该角色只产出材料与证据，不实现或修改产品/测试代码。不可用时保留有界阻塞，不静默升级或把长原文回退给主代理。`] : []),
      lowCost.enabled
        ? `代码任务按阶段分工：低成本角色（${lowCostPair}）只收集日志、调用链、源码位置和既定测试证据；代码写作默认按有效配置使用 Sol medium 候选，受影响验证与必要审查单独选择。混合任务只把证据阶段交给低成本角色。`
        : '代码任务按阶段分工：先收集位置和必要摘录，关键接口与方案由主代理决定；代码实现默认按有效配置使用 Sol medium 候选，受影响验证与必要审查单独选择。',
      'policy.low_cost 之外的常规路由启动前核对模型/推理组合；默认组合不可用时选受支持组合或由主代理处理，不把主任务的 ultra 强加给不支持它的模型，用户明确指定的模型不得擅自替换。',
      '只有明确的代码结构、调用关系或代码审查任务才优先使用代码图；Agent Dispatch 只负责选代理，图刷新和检索规则由 CodeMap Boost 负责，不要把普通设计评审或业务依赖送入代码图。',
      '按交付物选择验证证据，不要求非代码成果运行构建。涉及代码时，默认不审查或格式化/lint 第三方实现，只核对自有代码集成与必要依赖接口。',
      `独立且并行有收益时委派；最多 ${maxParallel} 个子代理并发。普通单条 Git CLI 保持安静并由主代理串行执行；只有用户请求或明确 skill 工作流要求完整本地提交准备时，才可把准备阶段交给同工作区一个指定可写代理。准备阶段不并行操作 Git，主代理校验快照后执行 commit、远程操作和历史改写。`,
      '审查先核对任务意图、真实入口、验收标准与实际使用路径；只有具体证据证明影响本次验收目标的缺陷才阻塞。上下文缺失、假设性风险和风格建议作为非阻塞提示或待核对项，不自动返修，也不触发确认停工。',
      '非琐碎交付完成相称验证后必须独立审查，并按风险与有效配置选 reviewer；若用户限定只用主代理或禁用 reviewer，则由主代理审查并说明范围。实质问题经核实后复用原 writer 有界修复、重跑受影响检查并复查；小修改不强制每个角色。',
      reviewLifecycleGuidance(),
      '角色、可写权限和委派都不新增对外发布、发送、付费、生产环境或真实数据变更的授权；先核对当前会话已有授权。',
      '子代理须报告修改文件、验证和阻塞；结果已整合或不再需要时立即停止子代理，避免占用有限智能体名额。',
    ];
    if (profiles.length) lines.push(`配置候选角色（以宿主实际加载为准）：${profiles.join('；')}。`);
    if (modelWarnings.length) lines.push(`模型配置校验：${modelWarnings.join(' ')}`);
    return lines.join('');
  }
  const lines = [
    'Agent Dispatch policy for the primary Codex agent:',
    `- ${taskScopeGuidance('en')}`,
    '- Keep requirements clarification, key plan and public-contract decisions, task decomposition, result review, and final integration in the primary agent.',
    '- Delegate bounded investigation, planning analysis, content or product production, operations, document or data work, code implementation, verification, and review when a separate role has clear value, even when that work is sequential.',
    '- Choose among enabled candidates from role descriptions, ambiguity, constraints, acceptance feedback, explicit user preference, host availability, and total task cost including context, rework, review, and latency. High ambiguity may justify a stronger candidate immediately; do not route domains mechanically by keywords or maximize every role.',
    '- For an unpinned writer, explicitly pass model and effort so it does not accidentally inherit an expensive primary model. Native TOML model/effort values override spawn parameters; for a temporary combination choose a role with unpinned fields and pass both explicitly. Under the host rules, the current full-history fork does not accept overrides, so pass only the minimum needed context using a host-supported combination.',
    ...(lowCost.enabled ? [`- Delegate bounded log, routine document or structured-data, text-extraction, code-evidence, and established code-test labor to the configured low-cost candidate (${lowCostPair}) by default. It may produce evidence artifacts but does not implement or modify product or test code. If unavailable, keep the subtask bounded or blocked rather than silently upgrading.`] : []),
    lowCost.enabled
      ? `- For code work, give only logs, call-chain/source evidence, and established test execution to the low-cost candidate (${lowCostPair}). Use the effective Sol medium candidate for code writing by default, with enabled Terra, Astra, or an unpinned writer available when actual complexity or an explicit preference calls for them. In mixed tasks, split only the evidence stage to low-cost labor.`
      : '- For code work, gather evidence locations and necessary excerpts first. Use the effective Sol medium candidate for code writing by default, with enabled alternatives or primary-agent execution when configuration or task constraints require them.',
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
    '- Keep ordinary single-command Git CLI quiet and serial in the primary agent. Only an explicit user or skill request for complete local commit preparation may hand off that preparation to one writable agent in the same workspace; do not run Git concurrently, and have the primary validate the snapshot before the final commit. The final commit, remote operations, and history rewrites remain with the primary agent.',
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
    'Agent Dispatch: you are a spawned subagent, not the primary coordinator. / 你是已分派的子代理，不是主协调者。',
    '- Execute the assigned bounded investigation, plan, deliverable, verification, or review directly and stay within scope. / 直接完成有界任务并遵守范围。',
    '- Do not spawn or delegate to more agents unless the user or primary agent explicitly asked you to do so.',
    `- ${GIT_HANDOFF}`,
    '- Use CodeMap Boost only for explicit code structure or code-review work; it owns graph refresh and retrieval. Do not apply code-graph guidance to ordinary design or business relationships.',
    '- Your role and write access do not add authority to publish or send externally, spend money, change production, or alter real data; follow authority already established by the user and primary agent.',
    `- ${reviewLifecycleGuidance('zh', true)}`,
  ];
  if (config.policy.require_changed_file_report) {
    lines.push('- Report every file you changed, or state explicitly that you made no changes.');
  }
  if (config.policy.require_validation_report) {
    lines.push('- Report validation methods, evidence, results, and any remaining blocker. / 报告验证方法、证据、结果和剩余阻塞。');
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
