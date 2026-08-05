# CodeMap Boost for Codex

`codemap-boost-codex` 是一个 Codex 插件，用来把 `code-review-graph` 驱动的代码结构图工作流接入 Codex。

插件本身不会读取或修改旧宿主目录。Codex 持久提示写入 `$CODEX_HOME/AGENTS.md`，运行数据写入 Codex 插件数据目录。

## 与 Claude Code 版的语义对应

两边追求同一条用户语义：**安装后主动维护代码图，结构类问题优先用图谱，读取图谱前保证刷新完成**。

| 语义能力 | Codex 版 | Claude Code 版 |
| --- | --- | --- |
| 会话启动维护图谱 | `SessionStart` 自动 bootstrap 并同步 build/update | `SessionStart` 后台 build/update，缺 CLI 时提示 setup |
| 修改后更新图谱 | `PostToolUse` 同步刷新 | `PostToolUse` / `CwdChanged` 后台刷新 |
| 读取前屏障 | 图谱 MCP `PreToolUse` 同步刷新，失败则 deny | 图谱 MCP `PreToolUse` 同步刷新，失败则 deny |
| grep/agent 引导 | `Bash` / prompt / subagent 软提示优先用图谱；subagent 不重复刷新 | `Grep` / `Agent` 强提示优先用图谱 |
| 依赖安装 | Codex 插件可在 SessionStart 自动 bootstrap | 通过 `/codemap-boost-setup` 显式确认安装 |

Codex 版会把 grep 注入这类 Claude 专属能力改写到 `AGENTS.md`、`UserPromptSubmit`、`SubagentStart` 和 Bash 提示里；这是平台机制不同，不是能力缺口。

## 安装（AI 应完整执行）

前置环境只要求：可用的 `codex` CLI、Git，以及以下依赖安装器之一：

- 推荐 `uv`；插件会用它创建固定 Python 3.12 的私有 venv。
- 无 `uv` 时使用支持 `venv` 的 Python，依次尝试 3.12、3.11 和当前 Python。

不要求用户预先手动安装 `code-review-graph`；setup 会检测并安装。用户让 AI 安装插件时，AI 应完成以下整个闭环，不把 setup 留给用户记忆。

1. 检查 `codex`、Git、`uv` 或支持 `venv` 的 Python 是否可用。
2. 添加插件市场：

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

3. 安装当前插件：

```bash
codex plugin add codemap-boost-codex@codex-toolshop
```

4. 用 `codex plugin list --json` 找到 `codemap-boost-codex@codex-toolshop` 的 `source.path`，把它作为 `<plugin-root>`；然后以用户的目标 Git 仓库为工作目录运行：

```bash
node "<plugin-root>/scripts/setup.cjs" --build
```

5. setup 会打印 `managed runtime` 绝对路径。用该路径执行 `--version` 和 `status`，再检查 `codex mcp get code-review-graph --json`。MCP 必须为启用的 stdio，`command` 必须等于该私有运行时路径，参数为 `serve`，且 `cwd` 为 `null`。
6. 提示用户新开一个 Codex 任务，让插件 hooks、skill 和新注册的 MCP 工具一起加载。当前已启动任务不会动态补载 MCP 工具。

setup 必须在目标 Git 仓库执行，不能在插件目录执行；它会完成依赖、MCP、仓库忽略规则和初始图谱预热。正常安装不需要用户另行执行底层依赖命令。

## 自动启用

即使安装 AI 漏跑 setup，插件仍会自愈。`SessionStart` 会检查插件私有运行时及 Python、JavaScript、TypeScript、TSX parser；缺失或损坏时在后台重建隔离 venv，并提示完成后新开任务。运行时健康后，它会同步检查并修复 MCP、写入 `$CODEX_HOME/AGENTS.md` 托管块，并在当前 Git 仓库完成 build/update。旧配置、禁用配置、固定 `cwd`、全局 PATH 命令和 uvx 配置都会迁移到私有运行时。

`codemap-boost-setup` 仍保留为手动诊断/预热入口。需要立即验证或手动预热时，可以在 Codex 中输入：

```text
使用 codemap-boost-setup 帮我配置 CodeMap Boost
```

setup 会执行这些动作：

- 在插件数据目录维护独立的 `crg-runtime` venv，不读取用户级 site-packages，也不修改用户 PATH。
- 优先用 `uv` + Python 3.12 创建 venv；无 uv 时用系统 Python 的 `venv`，然后只向该 venv 安装 `code-review-graph[all]`。
- 安装后用与上游相同的 Python `-I` 隔离模式加载 Python、JavaScript、TypeScript、TSX parser；仅 CLI 存在不再视为健康。
- 使用 `codex mcp get/remove/add` 把 MCP 注册到私有 CRG 绝对路径；不会让第三方工具写入 hooks、instructions、skills。
- 健康检查或注册失败时写入诊断 marker 并返回非零。
- 可选安装 `graphifyy[all]`，用于提供 `graphify` 命令。

setup 脚本应以你的目标项目作为工作目录运行；这样 `.gitignore` 和初始图谱都会落在当前项目，而不是插件仓库。

正常使用不需要每次启动 Codex 都重新运行 setup。后续 SessionStart / PostToolUse hook 会自动 build 或 update 图谱。

setup 内部执行的等价流程如下，仅用于排障；正常安装不要手动执行，更不要使用 `pip install --user`：

```bash
uv venv --python 3.12 "<plugin-data>/crg-runtime"
uv pip install --python "<plugin-data>/crg-runtime/<python>" --upgrade "code-review-graph[all]"
# 没有 uv 时：
python -m venv "<plugin-data>/crg-runtime"
"<plugin-data>/crg-runtime/<python>" -m pip install --upgrade "code-review-graph[all]"
```

`graphify` 是可选能力；需要时再安装：

```bash
python -m pip install "graphifyy[all]"
```

## 它会做什么

插件会注册 6 类 Codex hook。`SessionStart` 会自动 bootstrap；插件私有 CRG 运行环境及 parser 健康后，结构提示、图谱构建和增量更新自动工作。显式禁用时 hook 保持静默。

| Hook | 私有 CRG 运行环境健康后的作用 |
| --- | --- |
| `SessionStart` | 安装/注册 `code-review-graph`，维护 `$CODEX_HOME/AGENTS.md` 的 CodeMap 托管块，并同步完成 build/update；不会修改项目 `.gitignore`。 |
| `PostToolUse` | Codex 写文件或执行可能修改源码的 Bash 后同步刷新；只读 Bash 命令不会触发重复刷新。 |
| `PreToolUse:Bash` | 当 Bash 命令像是在做代码结构搜索时，向 Codex 注入图谱优先提示，不阻止命令。 |
| `PreToolUse:MCP` | 调用 code-review-graph / codegraph / graphify MCP 前同步刷新图谱；CLI 不可用或刷新失败时阻止本次图谱读取。 |
| `UserPromptSubmit` | 当用户问题涉及符号、调用、引用、影响面等结构问题时，提醒 Codex 优先使用图谱 MCP 工具。 |
| `SubagentStart` | 子代理启动时只注入 CodeMap 使用规则，不重复 build/update；首次图谱读取仍由 `PreToolUse:MCP` 屏障同步兜底。 |

## 与 Agent Dispatch 协作

两者同时安装时，Agent Dispatch 负责把有界搜索交给 Luna、广泛扫描交给 Terra；CodeMap Boost 负责图刷新、读取屏障和检索规则。搜索子代理启动时不会再次刷新图，随后第一次图谱 MCP 调用会经过同步屏障，因此既避免每个子代理重复 update，也不会读取过期图谱。

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
