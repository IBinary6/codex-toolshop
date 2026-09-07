# agent-dispatch-codex

将 Claude Code `agent-dispatch` 的主代理调度语义移植到 Codex：主代理负责需求与架构决策、拆分、审查和整合；明确、有界的实现工作可交给主代理按任务选择的可写子代理；子代理直接执行，不递归分派，并报告修改文件和验证结果。

## 与 Claude Code 版的语义对应

两边追求同一条调度语义：**主代理保留决策、拆分、审查、整合和 Git 串行操作；边界清晰的探索与实现交给匹配的子代理；子代理完成后报告改动和验证，并在结果整合后及时释放**。

| 语义能力 | Codex 版 | Claude Code 版 |
| --- | --- | --- |
| 主代理工具约束 | 普通工具调用默认不注入 `PreToolUse` 提示，避免重复上下文和误拦截 | `PreToolUse` 白名单硬拦截，非轻量工具要求用 `Agent` |
| 子代理识别 | 使用 `SubagentStart` 明确角色边界，不依赖可选 `agent_id` 来硬拦截工具 | Claude hook 输入包含 `agent_id`，子代理可豁免 |
| 调度提示 | `SessionStart` / `UserPromptSubmit` 注入紧凑调度策略 | 被 block 后下一条 prompt 注入 dispatcher 指令 |
| Git 边界 | 纯 Git CLI 固定主代理串行执行，不进入委派分类 | 安全 Git 可直跑，危险 Git 拦截 |
| 配置 | `PLUGIN_DATA` + 项目 `.agent-dispatch-codex`，支持 Codex agent profile | `~/.agent-dispatch` + 项目 `.agent-dispatch` |

因此 Codex 版不照搬“非白名单直接 deny”。这是平台事件模型差异下的等价策略，不是降级。

## 为什么不是原样复制 Claude Hook

Codex 的 `PreToolUse` 提供标准工具事件，`exec_command`（含 Code Mode 内层调用）投影为 `Bash`。事件中的 `agent_id` 是可选字段，缺失不能证明调用来自主代理。无论是否带来源标识，单次工具调用都不足以决定任务是否适合委派；因此本插件不做“非白名单直接 block”。

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

`agent-dispatch-setup` 只用于查看有效配置或做自定义覆盖。关键词路由是建议，主代理根据上下文和实际分派收益决定是否使用；已有可执行方案时直接推进，非琐碎实现执行独立审查，小改保持相称流程。单纯文本较长不会触发路由。平台仍要求新任务重新加载插件；Hook 哈希变化时仍需在 `/hooks` 中审查并信任。

路由先处理明确范围，再判断任务意图和风险。它不是自然语言权限解析器，未识别到限制也不构成授权；完整上下文仍由主代理核对。典型行为如下：

| 用户请求 | 路由建议 |
| --- | --- |
| 只读诊断崩溃，禁止修改 | 只读证据收集，不建议可写执行角色。 |
| 只用主代理修复，或不要委派 | 不追加子代理路线。 |
| 按已有计划实现跨模块迁移 | 实现候选加图优先影响面核对，不重复规划。 |
| auth 模块被谁依赖 / Find all callers | 有边界的图查询；跨模块大范围扫描才建议 mapper。 |
| inspect this patch for regressions | 审查候选，保留图谱与源码核对。 |
| 仅改 README 中 security 一词的拼写 | 不因 security 单词升级为高风险审查。 |
| 修复单文件权限缺陷 | 主代理先核对契约、证据和授权，再按实际风险验证。 |

代码审查优先于其中附带的搜索词；跨模块实现保留实现意图，不被降成纯搜索。明确的小范围工作由主代理处理，模型候选仅在独立分派确有收益时使用。

生成配置不等于宿主已加载角色，也不代表账号已开放对应模型。主代理在启动前核对宿主实际支持的模型/推理组合；默认组合不可用时选择受支持组合或自行处理。用户明确指定的模型不能擅自替换，插件也不发起模型探测请求。

Profile 文件本身不会占用智能体名额；只有实际 spawn 出来的线程占用并发槽。主代理在结果整合、阻塞或不再需要时必须立即停止/关闭对应线程。

## Shell 兼容

插件支持 Windows 和 macOS，要求 Node.js 18 或更高版本。Hook 本身由 Node.js 执行，不依赖集成终端选择。工具提示解析同时支持：

- macOS `zsh`/`bash` 的 `&&`、`||`、`;`、管道和重定向；
- Git Bash 的 `&&`、`||`、`;`、管道和重定向；
- PowerShell 的 `;`、管道、常用只读 cmdlet 和 Windows 可执行文件后缀；
- 无空格分隔写法，例如 `npm test&&rm -rf .` 和 `echo ok>file`。

集成终端的 shell 选择只影响新开的终端标签页，不会改变 Hook 的 Node.js 运行逻辑。

## Git 串行边界

所有纯 Git CLI 命令都固定留在主代理中逐条串行执行，不委派给子代理，也不并行拆分。`git`、`git.exe`、带全局选项的 Git 命令，以及 force push、删除分支、reset、clean 等子命令，都不会触发 Agent Dispatch 的轻量/危险命令分类提示。

复合命令仍逐段分析：Git 段跳过调度分类，后续非 Git 段继续用于识别明确的状态变更。普通未知命令不会仅因命令头不在轻量表中产生路由提示。

Shell 嵌套求值不属于 Git 权限。例如 `git status $(other-command)`、PowerShell 脚本块、进程替换、块注释，以及无法同时确定 Git Bash/PowerShell 语义的转义写法，仍不会被当作纯 Git CLI；但 Agent Dispatch 默认不再为这些单条命令注入通用路由提示。

这里调整的是 Agent Dispatch 的编排策略，不会绕过 Codex sandbox、用户授权、Hook 信任机制或 Git 自身的安全保护。主代理仍应根据用户意图审慎执行破坏性 Git 操作。

## CodeMap Boost、Context Mode 与 Serena 协作

默认轻量 MCP 前缀已覆盖 CodeMap Boost、Context Mode 和 Serena。Context Mode 的 Codex 原生前缀与插件命名空间前缀均受支持；Serena 同时兼容官方 `serena` 名称和常见的 `serena-cross-platform` 名称。调用这些工具时不会产生“必须委派”的误提示，主代理可直接完成上下文压缩、代码图和符号查询。

安装 CodeMap Boost 后，两者按职责协作：Agent Dispatch 选择与搜索范围匹配的代理，CodeMap Boost 负责图刷新、读取屏障和图检索策略。Agent Dispatch 的注入仅保留职责边界，详细规则由 CodeMap Boost 维护。`dispatch_explorer` 与 `dispatch_mapper` 优先使用可用的代码图；图工具不能回答时，结合可用证据并读取源码核对关系，不把未执行的查询说成已查到结果。

Agent Dispatch 不捆绑安装这些 MCP。Context Mode 应作为独立 Codex 插件安装，Serena 应按其 Codex setup 流程注册；未安装的工具不会因为加入前缀而被加载。若使用其他服务器名称，可通过 `mcp_prefixes_add` 增加项目或全局覆盖。CodeMap MCP 可能以 deferred 方式注入，不出现在静态或顶层 schema；声称未加载前，应在可用时检查 `ALL_TOOLS` 中的 `mcp__code_review_graph__*` 或实际调用，不能仅凭顶层列表判断。

## 子 Agent 模型分工

Codex 支持项目级 `.codex/agents/*.toml` 自定义 Agent，并允许每个 Agent 独立设置 `model`、`model_reasoning_effort` 和 `sandbox_mode`。插件会在 `SessionStart` 为当前 Git 项目生成以下本地配置：

| Agent | 默认模型 | 推理强度 | 用途 |
| --- | --- | --- | --- |
| `dispatch_explorer` | `gpt-5.6-luna` | `medium` | 有边界的跨文件搜索、调用链和证据收集。 |
| `dispatch_mapper` | `gpt-5.6-luna` | `medium` | 大范围、跨模块的证据整理；困难关系由主代理拆分或提高执行能力。 |
| `dispatch_researcher` | `gpt-5.6-luna` | `medium` | 官方文档、版本契约和外部事实核对，只读回传来源。 |
| `dispatch_luna_worker` | `gpt-5.6-luna` | `max` | 规格明确、有界、重复性较高的代码实现候选。 |
| `dispatch_terra_worker` | `gpt-5.6-terra` | `high` | 有一定推理与工具需求的日常实现候选。 |
| `dispatch_sol_worker` | `gpt-5.6-sol` | `medium` | 需求明确的复杂代码和较复杂重构的优先候选。 |
| `dispatch_astra_worker` | `gpt-6-astra` | `medium` | 主代理确定计划后，处理跨模块、多重约束或需要持续判断的困难实现与重构。 |
| `dispatch_worker` | 调度时明确选择 | 调度时明确选择 | 不固定模型的通用执行角色，支持任务需要的其他组合。 |
| `dispatch_hard_worker` | 调度时明确选择 | 调度时明确选择 | 困难实现和复杂调试的动态执行角色。 |
| `dispatch_tester` | `gpt-5.6-luna` | `medium` | 按既定计划执行测试、复现和报告；不自行改产品代码。 |
| `dispatch_planner` | `gpt-6-astra` | `xhigh` | 非琐碎计划、架构、接口分析，最终决策仍由主代理负责。 |
| `dispatch_reviewer` | `gpt-6-astra` | `xhigh` | 独立检查正确性、回归和测试缺口。 |
| `dispatch_deep_reviewer` | `gpt-6-astra` | `ultra` | 安全、权限、并发、生产等高风险审查。 |

表格是本插件的可覆盖预设。主代理根据当前任务、上下文和宿主支持选择模型与推理档位；搜索、规划和审查角色也遵循用户显式偏好。切换到 Astra 或其他模型不需要重写整个工作流，也不要求所有角色使用同一个模型或推理档位。

主对话模型不受插件修改，仍由 Codex 桌面版模型选择器或顶层配置决定。生成文件会逐项加入 `.git/info/exclude`；同名手写文件、空文件、已被 Git 跟踪的文件以及符号链接入口均保留。未跟踪且带插件托管头的旧 profile 才能更新或清理。首次生成或修改模型配置后，新建 Codex 任务即可加载新的 Agent 配置。

选择依据是歧义、约束、上下文和验收难度，以及整个任务的上下文、返工、审查与等待成本。批量读取和索引材料整理优先用轻量角色；需求明确的复杂代码、较复杂重构优先考虑 `Sol medium`，跨模块、多重约束且需要持续判断的困难实现与重构考虑 `Astra medium`。小范围机械重构仍使用合适的轻量角色，高歧义任务可以直接选更强执行模型，不必先让轻量模型失败。四个固定执行 profile 是可选预设，不是按“写代码”关键词固定一种模型。推理档位没有跨模型等价关系，`Luna max` 不代表与 `Sol medium` 等价或总成本一定更低。重构默认保留现有行为和接口契约，架构及契约变更仍由主代理按授权决定。

原生 TOML 中显式设置的 `model` / `model_reasoning_effort` 优先于 spawn 参数。临时需要其他组合时，选用未固定这两个字段的 `dispatch_worker` / `dispatch_hard_worker` 并显式传入模型与档位，避免无意继承高成本主任务设置。按宿主 API 的上下文规则传递最少必要信息；当前宿主的完整历史 fork 不接受模型覆盖，不能把覆盖参数和完整 fork 混用。Luna 当前最高支持 `max`，不能写成 `ultra`；Astra 的 `ultra` 以当前 Codex 宿主能力为准，不将 API 文档的档位列表当作所有客户端的能力。

非琐碎实现先完成针对性验证，再交独立审查角色把关；小改由主代理按实际风险审查。审查报告应给出位置、证据、影响和修复验收条件。主代理核实实质问题后，优先复用原 writer 有界修复、重跑受影响检查，再复查修改及其影响面。相同问题反复出现且没有新证据时，应缩小任务、调整模型或由主代理介入，不机械无限重写；风格偏好不成为反复返工的理由。用户要求只用主代理、禁用审查角色或限制并发时遵守其约束，并说明实际审查范围。

审查先核对本次任务意图、构建配置、实际入口和调用契约。只有具体证据能证明影响当前验收目标的缺陷才阻塞；缺少上下文、假设性并发、风格偏好列为非阻塞提示或待核对项。用户为调试添加的 `#if DEBUG`、`#ifdef _DEBUG`、`#if DBG` 和 `KdBreakPoint()` 等默认保留，可以提示用户自行选择，但不因提示停下已授权工作或自动删改。若证据证明它实际进入要求的 Release/交付路径或违反本次运行目标，才按真实影响处理。宏名或断点的字面存在不能替代构建与运行证据，调试代码也不是无条件豁免。

新增 profile 不意味着启动全部角色，默认仍最多 3 个子代理并发。只传任务目标、文件归属、必要证据和验收条件，回传摘要与相关日志路径；保留独立审查上下文。主代理先整合结果并完成必要反馈，再停止不再需要的子代理。CodeMap 负责实际图索引，插件不重复构建索引或用大模型代替索引工具。

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

模型与推理档位的合并规则：

- 同层显式 `model` 和 `model_reasoning_effort` 原样保留，包括空字符串。空字符串省略对应 TOML 字段，交由宿主继承；只清空 `model` 且未指定 effort 时，两者一并继承。
- 只覆盖为不同模型、未同时指定 effort 时，已知模型使用本插件的保守 `medium` 预设，避免沿用旧模型或主任务的 `ultra`。未知型号不猜能力，省略 effort 并提示核对宿主支持。
- 只改描述或重复指定同一模型，不清除上一层的 effort；更近层级显式 effort 仍优先。
- `config.js` 中的已知能力来自 2026-09-05 宿主列表，覆盖 Astra、Sol、Terra、Luna、5.5、5.4-mini 和 Spark。它用于发现不兼容组合，不是账号可用性探测；显式不兼容组合保留配置并在 SessionStart 提示，启动前必须按宿主实际能力处理。

将某个 profile 的 `enabled` 或整个 `agent_profiles.enabled` 设为 `false`，会在下次 SessionStart 清理对应的未跟踪托管文件；配置中已不存在的旧托管角色也会清理。手写、已跟踪文件和符号链接保留，需要由其所有者管理。现有任务中的已加载角色不会因此被远程卸载，请新建任务核对最终角色。

使用 `agent-dispatch-setup` skill 可查看三层来源和有效规则。

## 选型依据与吸收范围

2026-09-07 核对的 [OpenAI 模型选择说明](https://learn.chatgpt.com/zh-Hans/docs/models) 将 Luna 用于明确、重复任务，Terra 用于日常工作，Sol 用于复杂开放任务，Astra 用于最困难的端到端工作；推理强度按任务需要选择。上面的具体档位是本插件的可覆盖起点，未经任务集基准测试，不承诺固定节省比例。

[官方子代理文档](https://learn.chatgpt.com/docs/agent-configuration/subagents) 是原生 TOML、模型优先级和线程控制的依据。[Astra 官方指南](https://developers.openai.com/api/docs/guides/latest-model) 用于确定委派边界和相称验证。

参考社区项目 [codex-astra-luna-orchestrator](https://github.com/donvito/codex-astra-luna-orchestrator) 的有界任务分工、精简证据回传及实现—验证—审查—修复流程。这里复用现有自动生成器和可配置模型候选；不复制其固定主模型、全量配置覆盖、所有执行角色固定 Luna 或广泛强制委派规则。该项目是工作流参考，不是模型能力或成本基准。

## 验证

```bash
npm test
```

安装或更新后需要新建 Codex 任务，并在 `/hooks` 中审查、信任当前 Hook 哈希。
