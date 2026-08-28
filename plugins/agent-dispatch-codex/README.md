# agent-dispatch-codex

将 Claude Code `agent-dispatch` 的主代理调度语义移植到 Codex：主代理负责需求与架构决策、拆分、审查和整合；明确、有界的实现工作可交给主代理按任务选择的可写子代理；子代理直接执行，不递归分派，并报告修改文件和验证结果。

## 与 Claude Code 版的语义对应

两边追求同一条调度语义：**主代理保留决策、拆分、审查、整合和 Git 串行操作；边界清晰的探索与实现交给匹配的子代理；子代理完成后报告改动和验证，并在结果整合后及时释放**。

| 语义能力 | Codex 版 | Claude Code 版 |
| --- | --- | --- |
| 主代理工具约束 | 普通工具调用默认不注入 `PreToolUse` 提示，避免重复上下文和误拦截 | `PreToolUse` 白名单硬拦截，非轻量工具要求用 `Agent` |
| 子代理识别 | Codex hook 不能稳定区分调用来源，改用 `SubagentStart` 规则 | Claude hook 输入包含 `agent_id`，子代理可豁免 |
| 调度提示 | `SessionStart` / `UserPromptSubmit` 注入紧凑调度策略 | 被 block 后下一条 prompt 注入 dispatcher 指令 |
| Git 边界 | 纯 Git CLI 固定主代理串行执行，不进入委派分类 | 安全 Git 可直跑，危险 Git 拦截 |
| 配置 | `PLUGIN_DATA` + 项目 `.agent-dispatch-codex`，支持 Codex agent profile | `~/.agent-dispatch` + 项目 `.agent-dispatch` |

因此 Codex 版不照搬“非白名单直接 deny”。这是平台事件模型差异下的等价策略，不是降级。

## 为什么不是原样复制 Claude Hook

Codex 当前的 `PreToolUse` 只可靠覆盖部分 Bash、`apply_patch` 和 MCP 调用，而且该事件没有 Claude 版用于识别子代理的 `agent_id`。若照搬“非白名单直接 block”，主代理派出的子代理也会被同一 Hook 拦截。

本插件因此使用 Codex 原生分层策略：

| Hook | 行为 |
| --- | --- |
| `SessionStart` | 创建配置骨架并向主代理注入调度策略。 |
| `UserPromptSubmit` | 对复杂/多阶段提示补充一次紧凑调度提醒。 |
| `PreToolUse` | 默认关闭；显式开启后只对非白名单 MCP 和已识别的注册表状态变更添加软提示，不执行 deny。 |
| `SubagentStart` | 告知子代理直接完成已分配工作，不再次分派。 |

普通 Bash 命令、未知命令头、shell 控制语法、重定向和嵌套求值不会再产生任务路由提示。单条命令不足以决定是否切换角色或模型，任务级路由统一由 `UserPromptSubmit` 和主代理当前判断负责。`shell_heads` 仍用于可选的命令分析配置，但不是 sandbox、权限或安全边界。

## 安装后自动工作

不需要先运行 `agent-dispatch-setup`。插件安装并启用后，新建 Codex 任务会自动触发 `SessionStart`：创建缺失的全局/项目配置骨架、合并三层配置、在当前 Git 项目生成 `.codex/agents/*.toml`，并注入主代理调度规则。之后每次 `UserPromptSubmit` 会按当前提示词只补充一条精简路由建议。

`agent-dispatch-setup` 只用于查看有效配置或做自定义覆盖。平台仍要求新任务重新加载插件；Hook 哈希变化时仍需在 `/hooks` 中审查并信任。账号或工作区未开放某个模型/推理档位时，Codex 只能按可用能力降级，插件不能绕过模型权限。

Profile 文件本身不会占用智能体名额；只有实际 spawn 出来的线程占用并发槽。主代理在结果整合、阻塞或不再需要时必须立即停止/关闭对应线程。

## Shell 兼容

插件 Hook 本身由 Node.js 执行，不依赖集成终端选择。工具提示解析同时支持：

- Git Bash 的 `&&`、`||`、`;`、管道和重定向；
- PowerShell 的 `;`、管道、常用只读 cmdlet 和 Windows 可执行文件后缀；
- 无空格分隔写法，例如 `npm test&&rm -rf .` 和 `echo ok>file`。

Git Bash 只影响新开的集成终端标签页，不会把 Hook 与 Codex agent 的 Windows 命令宿主混在一起。

## Git 串行边界

所有纯 Git CLI 命令都固定留在主代理中逐条串行执行，不委派给子代理，也不并行拆分。`git`、`git.exe`、带全局选项的 Git 命令，以及 force push、删除分支、reset、clean 等子命令，都不会触发 Agent Dispatch 的轻量/危险命令分类提示。

复合命令仍逐段分析：Git 段跳过调度分类，后续非 Git 段继续用于识别明确的状态变更。普通未知命令不会仅因命令头不在轻量表中产生路由提示。

Shell 嵌套求值不属于 Git 权限。例如 `git status $(other-command)`、PowerShell 脚本块、进程替换、块注释，以及无法同时确定 Git Bash/PowerShell 语义的转义写法，仍不会被当作纯 Git CLI；但 Agent Dispatch 默认不再为这些单条命令注入通用路由提示。

这里调整的是 Agent Dispatch 的编排策略，不会绕过 Codex sandbox、用户授权、Hook 信任机制或 Git 自身的安全保护。主代理仍应根据用户意图审慎执行破坏性 Git 操作。

## CodeMap Boost、Context Mode 与 Serena 协作

默认轻量 MCP 前缀已覆盖 CodeMap Boost、Context Mode 和 Serena。Context Mode 的 Codex 原生前缀与插件命名空间前缀均受支持；Serena 同时兼容官方 `serena` 名称和常见的 `serena-cross-platform` 名称。调用这些工具时不会产生“必须委派”的误提示，主代理可直接完成上下文压缩、代码图和符号查询。

安装 CodeMap Boost 后，两者按职责协作：Agent Dispatch 选择与搜索范围匹配的代理，CodeMap Boost 负责图刷新、读取屏障和图检索策略。`dispatch_explorer` 与 `dispatch_mapper` 会优先使用可用的代码图，不自行重复执行 build/update；纯文本、注释和字符串查找才使用文本搜索。

Agent Dispatch 不捆绑安装这些 MCP。Context Mode 应作为独立 Codex 插件安装，Serena 应按其 Codex setup 流程注册；未安装的工具不会因为加入前缀而被加载。若使用其他服务器名称，可通过 `mcp_prefixes_add` 增加项目或全局覆盖。CodeMap MCP 可能以 deferred 方式注入，不出现在静态或顶层 schema；声称未加载前，应在可用时检查 `ALL_TOOLS` 中的 `mcp__code_review_graph__*` 或实际调用，不能仅凭顶层列表判断。

## 子 Agent 模型分工

Codex 支持项目级 `.codex/agents/*.toml` 自定义 Agent，并允许每个 Agent 独立设置 `model`、`model_reasoning_effort` 和 `sandbox_mode`。插件会在 `SessionStart` 为当前 Git 项目生成以下本地配置：

| Agent | 默认模型 | 推理强度 | 用途 |
| --- | --- | --- | --- |
| `dispatch_explorer` | `gpt-5.6-luna` | `medium` | 有边界的跨文件搜索、调用链和证据收集。 |
| `dispatch_mapper` | `gpt-5.6-terra` | `medium` | 大范围、跨模块、读重型扫描和结构梳理。 |
| `dispatch_planner` | `gpt-5.6-sol` | `xhigh` | 非琐碎计划、架构、接口和复杂决策。 |
| `dispatch_worker` | 继承主任务 | 继承主任务 | 验收标准明确的日常开发、重构和修复。 |
| `dispatch_hard_worker` | 继承主任务 | 继承主任务 | 主代理固定范围与验收标准后的困难实现与复杂调试。 |
| `dispatch_reviewer` | `gpt-5.6-terra` | `high` | 常规独立正确性、回归和测试缺口审查。 |
| `dispatch_deep_reviewer` | `gpt-5.6-sol` | `xhigh` | 安全、权限、并发、生产等高风险审查。 |

该分层遵循 Codex 当前模型建议：Terra 适合强调速度和效率的读重型扫描，Luna 适合明确、重复、批量的窄任务；推理强度越高，耗时和 token 通常越多，多数任务不需要 Max 或 Ultra。参见 [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) 和 [Models](https://learn.chatgpt.com/docs/models)。

主对话模型不受插件修改，仍由 Codex 桌面版模型选择器或顶层配置决定。生成文件会逐项加入 `.git/info/exclude`；若同名文件不是插件生成的，插件会保留用户文件，不覆盖。首次生成或修改模型配置后，新建 Codex 任务即可加载新的 Agent 配置。

搜索、规划和审查角色保留各自的默认模型档位；两个可写角色默认不固定模型或推理强度，而是继承主任务选择。主代理根据实现复杂度、上下文规模、风险、账号/工作区可用性和用户显式偏好选择可写角色、模型与推理强度，用户明确指定 `xhigh`、`ultra` 或具体模型时优先满足。插件不承诺固定的额度倍率，实际消耗取决于任务、上下文和账号计费策略。

委派不再只限于并行任务：只要实现边界和验收标准已经明确，串行的编码或修复也可以交给合适的可写角色，但不强制固定为 `dispatch_worker`。简单读取、很小的修改、强耦合步骤、结果验收和最终整合仍由主代理完成；只有用户明确要求独立验收时才启动 reviewer，并按普通风险与高风险分别选择 Terra high 或 Sol xhigh。子代理结果已整合、遇到阻塞或不再需要时，主代理应立即停止它，避免空闲智能体持续占用有限名额。

文章中直接创建 `~/.codex/agents/luna-worker.toml` 的做法不适用于本插件的托管契约。插件在当前 Git 项目的 `.codex/agents/` 下生成 profile，使用顶层 `name`、`description`、`model`、`model_reasoning_effort`、`sandbox_mode` 和 `developer_instructions` 字段；应通过三层 JSON 配置覆盖，不要手改带插件托管头的 TOML。

## 配置

配置按三层合并：

1. 插件默认值：`defaults/dispatch-rules.json`
2. 全局配置：`PLUGIN_DATA/config.json`
3. 项目配置：`<git-root>/.agent-dispatch-codex/config.json`

项目配置目录会写入 `.git/info/exclude`，不会修改项目 `.gitignore`。配置文件只需要填写覆盖项，例如：

```json
{
  "schema_version": 1,
  "modules": {
    "pre_tool_nudge": false
  },
  "policy": {
    "max_parallel_subagents": 2
  },
  "agent_profiles": {
    "profiles": {
      "dispatch_worker": {
        "model": "",
        "model_reasoning_effort": ""
      },
      "dispatch_reviewer": {
        "enabled": false
      }
    }
  },
  "overrides": {
    "shell_heads_add": ["my-local-tool"],
    "mcp_prefixes_add": ["mcp__my_local_"]
  }
}
```

将某个 profile 的 `model` 或 `model_reasoning_effort` 设为空字符串会省略对应 TOML 字段并继承主会话选择；设置非空值可在全局或项目层显式固定。将 `enabled` 设为 `false` 会删除对应的插件托管文件。模型是否可用仍取决于当前账号和工作区策略。

使用 `agent-dispatch-setup` skill 可查看三层来源和有效规则。

## 验证

```bash
npm test
```

安装或更新后需要新建 Codex 任务，并在 `/hooks` 中审查、信任当前 Hook 哈希。
