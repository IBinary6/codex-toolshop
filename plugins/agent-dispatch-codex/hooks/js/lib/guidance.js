'use strict';

const { analyzeShellCommand } = require('./shell');
const { profileSummary } = require('./agent_profiles');

function mainAgentGuidance(config, compact = false) {
  const maxParallel = Number(config.policy.max_parallel_subagents) || 3;
  const profiles = profileSummary(config);
  if (compact) {
    const lines = [
      'Agent Dispatch：你是主代理。需求澄清、架构/接口决策、任务拆分、结果审查和最终整合由主代理负责；',
      '明确、有界的编码、重构和修 bug 优先交给低成本执行子代理，即使步骤串行也可委派；琐碎读取、小改和强耦合步骤直接完成。',
      '可独立并行的子任务必须并行委派。所有 Git 命令均由主代理串行执行，不委派、不并行拆分。',
      '常规结果由主代理自行审查；只有高风险范围确实需要独立复核时才启用高推理审查子代理。',
      '子代理须报告修改文件、验证和阻塞；结果已整合或不再需要时立即停止子代理，避免占用有限智能体名额。',
    ];
    if (profiles.length) lines.push(`可用角色：${profiles.join('；')}。`);
    return lines.join('');
  }
  const lines = [
    'Agent Dispatch policy for the primary Codex agent:',
    '- Keep requirements clarification, architecture and interface decisions, task decomposition, result review, and final integration in the primary agent.',
    '- Prefer a cost-efficient execution agent for concrete, bounded implementation, refactoring, and bug-fix work once the steps and acceptance criteria are clear, even when that work is sequential.',
    '- Delegate independent bounded subtasks in parallel when useful.',
    `- Use no more than ${maxParallel} subagents concurrently unless the user explicitly requests more.`,
    '- Keep trivial reads, small edits, tightly coupled steps, and final integration in the primary agent.',
    '- Review normal execution results in the primary agent; use a high-reasoning reviewer only when an independent review is justified by risk.',
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
  if (typeof prompt !== 'string') return false;
  const normalized = prompt.toLowerCase();
  const keywords = config.whitelist.prompt_keywords || [];
  return prompt.length >= 160 || keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()));
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
  promptNeedsDispatch,
  subagentGuidance,
  toolNudge,
};
