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
```

安装或升级后，重新打开一个 Codex 会话，让 hooks、skills 和 MCP 配置重新加载。

## 插件索引

| 插件 | 当前用途 | 日常用法 |
| --- | --- | --- |
| `codemap-boost-codex` | 自动接入 `code-review-graph` 代码结构图，提供符号、调用、引用和影响面检索能力。 | 新会话自动 bootstrap、自动 build/update。涉及代码结构时优先用 `mcp__code_review_graph__*` 工具。 |
| `cpp-style-enforcer-codex` | 自动执行团队 C++ 风格流程，包括 clang-format、版权头、BOM、cpplint 和提交前检查。 | 正常编辑即可；写入 C/C++ 文件后 hook 自动处理，`git commit` 前会检查暂存区 C++ 文件。 |

## CodeMap Boost 怎么用

安装 `codemap-boost-codex` 后，新会话的 `SessionStart` 会主动做这些事：

- 检查 `code-review-graph` 是否可用；缺失时在后台尝试安装 `code-review-graph[all]`。
- 注册 Codex MCP，且使用 `--no-hooks --no-instructions --no-skills`，避免第三方安装器写入额外 hook 或提示词。
- 写入 `$CODEX_HOME/AGENTS.md` 的托管块，提醒 Codex 优先使用图谱工具。
- 当前目录是 Git 仓库且缺少 `.code-review-graph/` 时，后台启动初始 build。
- 写文件或运行 Bash 后，按锁和节流规则后台执行 `code-review-graph update`。
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

- `PostToolUse` 会在写入/编辑后处理格式化、BOM、版权头和 cpplint。
- `PreToolUse` 会识别真正的 `git commit`，对暂存区 C/C++ 文件做提交前检查。
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
```

然后重启 Codex 或新开会话。查看当前版本：

```bash
codex plugin list
```

## 故障排查

- `failed to parse plugin hooks config ... unknown field description`：更新到新版插件，并确认缓存中的 `hooks/hooks.json` 顶层只有 `hooks`。
- CodeMap 没有图谱：确认当前目录是 Git 仓库，运行 `code-review-graph status`；首次 build 在后台执行，大仓库可能需要等待。
- CodeMap 完全不工作：检查是否设置了 `CODEMAP_BOOST_DISABLE_GRAPH=1` 或 `CODEMAP_BOOST_DISABLE_BOOTSTRAP=1`。
- C++ 风格检查没有格式化：确认 `clang-format` 可用；缺失时格式化会跳过，但 cpplint 等流程仍继续。

## 协议

MIT
