# agent-dispatch-codex

将 Claude Code `agent-dispatch` 的主代理调度语义移植到 Codex：主代理负责拆分和整合，可独立并行的有界工作交给子代理；子代理直接执行，不递归分派，并报告修改文件和验证结果。

## 为什么不是原样复制 Claude Hook

Codex 当前的 `PreToolUse` 只可靠覆盖部分 Bash、`apply_patch` 和 MCP 调用，而且该事件没有 Claude 版用于识别子代理的 `agent_id`。若照搬“非白名单直接 block”，主代理派出的子代理也会被同一 Hook 拦截。

本插件因此使用 Codex 原生分层策略：

| Hook | 行为 |
| --- | --- |
| `SessionStart` | 创建配置骨架并向主代理注入调度策略。 |
| `UserPromptSubmit` | 对复杂/多阶段提示补充一次紧凑调度提醒。 |
| `PreToolUse` | 对未知或高风险 Bash/MCP 调用添加软提示，不执行 deny。 |
| `SubagentStart` | 告知子代理直接完成已分配工作，不再次分派。 |

## Shell 兼容

插件 Hook 本身由 Node.js 执行，不依赖集成终端选择。工具提示解析同时支持：

- Git Bash 的 `&&`、`||`、`;`、管道和重定向；
- PowerShell 的 `;`、管道、常用只读 cmdlet 和 Windows 可执行文件后缀；
- 无空格分隔写法，例如 `npm test&&rm -rf .` 和 `echo ok>file`。

Git Bash 只影响新开的集成终端标签页，不会把 Hook 与 Codex agent 的 Windows 命令宿主混在一起。

## 子 Agent 模型分工

Codex 支持项目级 `.codex/agents/*.toml` 自定义 Agent，并允许每个 Agent 独立设置 `model`、`model_reasoning_effort` 和 `sandbox_mode`。插件会在 `SessionStart` 为当前 Git 项目生成以下本地配置：

| Agent | 默认模型 | 推理强度 | 用途 |
| --- | --- | --- | --- |
| `dispatch_explorer` | `gpt-5.6-luna` | `medium` | 快速、只读的代码探索与证据收集。 |
| `dispatch_worker` | `gpt-5.6-luna` | `medium` | 有明确边界的编码和修复任务。 |
| `dispatch_reviewer` | `gpt-5.6-sol` | `high` | 正确性、安全性和测试缺口审查。 |

主对话模型不受插件修改，仍由 Codex 桌面版模型选择器或顶层配置决定。生成文件会逐项加入 `.git/info/exclude`；若同名文件不是插件生成的，插件会保留用户文件，不覆盖。首次生成或修改模型配置后，新建 Codex 任务即可加载新的 Agent 配置。

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
        "model": "gpt-5.6-luna",
        "model_reasoning_effort": "low"
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

将某个 profile 的 `model` 设为空字符串可继承主会话模型；将 `enabled` 设为 `false` 会删除对应的插件托管文件。模型是否可用仍取决于当前账号和工作区策略。

使用 `agent-dispatch-setup` skill 可查看三层来源和有效规则。

## 验证

```bash
npm test
```

安装或更新后需要新建 Codex 任务，并在 `/hooks` 中审查、信任当前 Hook 哈希。
