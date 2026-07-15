# Codex Toolshop

`codex-toolshop` 是 IBinary6 的 Codex 插件市场，用来集中发布可复用的本地工程插件。目标是安装后尽量自动工作，不要求用户手动维护旧式 hook。

## 快速安装

首次使用只需要添加一次 marketplace：

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

安装推荐工作流插件：

```bash
codex plugin add codemap-boost-codex@codex-toolshop
codex plugin add cpp-style-enforcer-codex@codex-toolshop
codex plugin add agent-dispatch-codex@codex-toolshop
```

安装或升级后，重新打开一个 Codex 会话，让 hooks、skills 和 MCP 配置重新加载。

## 插件索引

| 插件 | 当前用途 | 日常用法 |
| --- | --- | --- |
| `codemap-boost-codex` | 自动接入 `code-review-graph` 代码结构图，提供符号、调用、引用和影响面检索能力。 | 新会话自动 bootstrap、自动 build/update。涉及代码结构时优先用 `mcp__code_review_graph__*` 工具。 |
| `cpp-style-enforcer-codex` | 自动执行团队 C++ 风格流程，包括 clang-format、版权头、BOM、cpplint 和提交前检查。 | 正常编辑即可；写入 C/C++ 文件后 hook 自动处理，`git commit` 前会检查暂存区 C++ 文件。 |
| `agent-dispatch-codex` | 保护主代理上下文，把可独立并行的有界任务分派给子代理。 | 新会话自动注入调度策略；子代理直接执行并报告修改文件和验证结果。 |

## Agent Dispatch 怎么用

安装 `agent-dispatch-codex` 后，新会话会自动加载调度策略：

- 主代理必须委派可独立、可并行且有明确边界的子任务。
- 简单读取、小范围修改或强串行步骤继续由主代理完成，避免为了委派而委派。
- 子代理收到独立指令后直接执行，不递归分派，并在结果中列出修改文件和验证命令。
- PowerShell 和 Git Bash 都受支持；集成终端 Shell 的选择不会改变 Hook 的 Node.js 运行逻辑。
- 全局配置保存在插件 `PLUGIN_DATA/config.json`，项目配置保存在 `.agent-dispatch-codex/config.json`。

需要查看或修改规则时，在 Codex 中说：

```text
使用 agent-dispatch-setup 查看当前项目的有效调度规则
```

## CodeMap Boost 怎么用

安装 `codemap-boost-codex` 后，新会话的 `SessionStart` 会主动做这些事：

- 检查 `code-review-graph` 是否可用；缺失时先完成 bootstrap，再继续本次启动刷新。
- 注册 Codex MCP，且使用 `--no-hooks --no-instructions --no-skills`，避免第三方安装器写入额外 hook 或提示词。
- 写入 `$CODEX_HOME/AGENTS.md` 的托管块，提醒 Codex 优先使用图谱工具。
- 当前目录是 Git 仓库时，同步完成 build/update；存在未跟踪源码时使用临时 Git index 做 full build。
- 写文件或执行可能修改源码的 Bash 后同步刷新；`git status`、`rg`、测试等只读命令不会重复刷新。
- 把 `.code-review-graph/` 和 `graphify-out/` 写入当前仓库的 `.git/info/exclude`，不改项目 `.gitignore`。

如果想手动预热或排障，可以在 Codex 中说：

```text
使用 codemap-boost-setup 帮我配置 CodeMap Boost
```

常用验证命令：

```bash
code-review-graph --version
code-review-graph status
codex plugin list
```

## C++ Style 怎么用

安装 `cpp-style-enforcer-codex` 后，新会话会准备 C++ 风格配置。之后正常让 Codex 编辑 C/C++ 文件即可：

- `PostToolUse` 只记录本轮编辑的 C/C++ 文件，不立即改写源文件。
- `Stop` 在本轮结束时统一处理格式化、BOM、版权头和 cpplint，并触发最终验证闭环。
- `PreToolUse` 会识别真正的 `git commit`，只检查暂存区 C/C++ 文件，不在提交前改写。
- 全局模板在 `~/.codex/cpp-style-template.json`。
- 项目级配置在 `.codex-cpp-style/cpp-style.json`。
- 兼容已有 `.claude-cpp-style`，旧项目不需要迁移。

如需补齐可选依赖，可在普通终端中预装：

```bash
python -m pip install clang-format==18.1.8
npm install iconv-lite@0.6.3
```

## 更新本地插件

远程有新版本后，用下面命令从远程 marketplace 同步本地：

```bash
codex plugin marketplace upgrade codex-toolshop
codex plugin add codemap-boost-codex@codex-toolshop
codex plugin add cpp-style-enforcer-codex@codex-toolshop
codex plugin add agent-dispatch-codex@codex-toolshop
```

然后重启 Codex 或新开会话。查看当前版本：

```bash
codex plugin list
```

## 故障排查

- `failed to parse plugin hooks config ... unknown field description`：更新到新版插件，并确认缓存中的 `hooks/hooks.json` 顶层只有 `hooks`。
- CodeMap 没有图谱：确认当前目录是 Git 仓库，运行 `code-review-graph status`；新会话会在使用前等待首次 build 完成。
- CodeMap 完全不工作：检查是否设置了 `CODEMAP_BOOST_DISABLE_GRAPH=1` 或 `CODEMAP_BOOST_DISABLE_BOOTSTRAP=1`。
- C++ 风格检查没有格式化：确认 `clang-format` 可用；缺失时格式化会跳过，但 cpplint 等流程仍继续。
- Agent Dispatch 没有生效：新建任务后打开 `/hooks`，审查并信任当前插件 Hook 哈希。

## 协议

MIT
