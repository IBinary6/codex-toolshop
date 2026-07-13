# CodeMap Boost for Codex

`codemap-boost-codex` 是一个 Codex 插件，用来把 `code-review-graph` 驱动的代码结构图工作流接入 Codex。

插件本身不会读取或修改旧宿主目录。Codex 持久提示写入 `$CODEX_HOME/AGENTS.md`，运行数据写入 Codex 插件数据目录。

## 安装

1. 添加插件市场：

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

2. 安装当前插件：

```bash
codex plugin add codemap-boost-codex@codex-toolshop
```

3. 重新打开一个 Codex 会话，让插件 hooks 和 skill 生效。

## 自动启用

安装插件后，重新打开 Codex 会话即可自动工作。`SessionStart` 会检查 `code-review-graph`，缺失时尝试安装 `code-review-graph[all]`，然后注册 Codex MCP、写入 `$CODEX_HOME/AGENTS.md` 托管块，并在当前 Git 仓库同步完成 build/update 后再继续使用。

`codemap-boost-setup` 仍保留为手动诊断/预热入口。需要立即验证或手动预热时，可以在 Codex 中输入：

```text
使用 codemap-boost-setup 帮我配置 CodeMap Boost
```

setup 会执行这些动作：

- 检查 `code-review-graph` 是否已经可用；已安装则不重复安装。
- 缺失时才安装 `code-review-graph[all]`。
- 注册 Codex MCP，但禁止第三方工具写入 hooks、instructions、skills。
- 写入诊断 marker；hook 的实际工作门槛是 `code-review-graph` CLI 可用。
- 可选安装 `graphifyy[all]`，用于提供 `graphify` 命令。

setup 脚本应以你的目标项目作为工作目录运行；这样 `.gitignore` 和初始图谱都会落在当前项目，而不是插件仓库。

正常使用不需要每次启动 Codex 都重新运行 setup。后续 SessionStart / PostToolUse hook 会自动 build 或 update 图谱。

底层依赖命令如下；setup 脚本会把依赖检测、MCP 注册和启用状态集中成一条可重复执行的配置入口：

```bash
python -m pip install "code-review-graph[all]"
code-review-graph install --platform codex --no-hooks --no-instructions --no-skills --yes
```

`graphify` 是可选能力；需要时再安装：

```bash
python -m pip install "graphifyy[all]"
```

## 它会做什么

插件会注册 5 类 Codex hook。`SessionStart` 会自动 bootstrap；`code-review-graph` CLI 可用后，结构提示、图谱构建和增量更新自动工作。显式禁用时 hook 保持静默。

| Hook | CLI 可用后的作用 |
| --- | --- |
| `SessionStart` | 安装/注册 `code-review-graph`，维护 `$CODEX_HOME/AGENTS.md` 的 CodeMap 托管块，并同步完成 build/update；不会修改项目 `.gitignore`。 |
| `PostToolUse` | Codex 写文件或执行可能修改源码的 Bash 后同步刷新；只读 Bash 命令不会触发重复刷新。 |
| `PreToolUse:Bash` | 当 Bash 命令像是在做代码结构搜索时，向 Codex 注入图谱优先提示，不阻止命令。 |
| `UserPromptSubmit` | 当用户问题涉及符号、调用、引用、影响面等结构问题时，提醒 Codex 优先使用图谱 MCP 工具。 |
| `SubagentStart` | 子代理启动时注入同样的 CodeMap 使用规则。 |

## 生成文件

项目内可能生成：

```text
.code-review-graph/
graphify-out/
```

SessionStart 会把这两个目录写入当前仓库的 `.git/info/exclude`，避免工作区被图谱产物污染，同时不修改项目 `.gitignore`。显式运行 setup 时，脚本仍会在目标 Git 项目的 `.gitignore` 中追加这两个目录，适合团队希望统一忽略规则的场景。

Codex 全局提示托管块写入：

```text
$CODEX_HOME/AGENTS.md
```

如果未设置 `CODEX_HOME`，Codex 默认使用用户目录下的 `.codex`。

## 重要边界

- 不使用旧宿主目录、旧宿主插件环境变量或旧宿主配置。
- 不让 `code-review-graph install` 写入第三方 hooks、instructions、skills。
- 不绕过 Codex hook trust；trust 是 Codex 的安全边界，需要由用户确认。
- `powershell`、`pwsh`、`bash` 都通过同一条 Node hook 命令执行，不维护多套脚本。
- 设置 `CODEMAP_BOOST_DISABLE_BOOTSTRAP=1` 可关闭 SessionStart 自动安装/注册；设置 `CODEMAP_BOOST_DISABLE_GRAPH=1` 可完全关闭图谱行为。
