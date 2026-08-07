# CodeMap Boost for Codex

`codemap-boost-codex` 是一个 Codex 插件，用来把 `code-review-graph` 驱动的代码结构图工作流接入 Codex。

插件本身不会读取或修改旧宿主目录。Codex 持久提示写入 `$CODEX_HOME/AGENTS.md`，运行数据写入 Codex 插件数据目录。

## 与 Claude Code 版的语义对应

两边追求同一条用户语义：**安装后主动维护代码图，结构类问题优先用图谱，读取图谱前保证刷新完成**。

| 语义能力 | Codex 版 | Claude Code 版 |
| --- | --- | --- |
| 会话启动维护图谱 | 原生 MCP 启动器准备运行时，`SessionStart` 同步 build/update | `SessionStart` 后台 build/update，缺 CLI 时提示 setup |
| 修改后更新图谱 | `PostToolUse` 同步刷新 | `PostToolUse` / `CwdChanged` 后台刷新 |
| 读取前屏障 | 图谱 MCP `PreToolUse` 同步刷新，失败则 deny | 图谱 MCP `PreToolUse` 同步刷新，失败则 deny |
| grep/agent 引导 | `Bash` / prompt / subagent 软提示优先用图谱；subagent 不重复刷新 | `Grep` / `Agent` 强提示优先用图谱 |
| 依赖安装 | 插件原生 MCP 首次加载时自动准备私有运行时 | 通过 `/codemap-boost-setup` 显式确认安装 |

Codex 版会把 grep 注入这类 Claude 专属能力改写到 `AGENTS.md`、`UserPromptSubmit`、`SubagentStart` 和 Bash 提示里；这是平台机制不同，不是能力缺口。

## 安装即用

前置环境只要求：可用的 `codex` CLI、Git，以及以下依赖安装器之一：

- 推荐 `uv`；插件会用它创建固定 Python 3.12 的私有 venv。
- 无 `uv` 时使用支持 `venv` 的 Python，依次尝试 3.12、3.11 和当前 Python。

不要求用户预先安装 `code-review-graph`，也不要求安装后再运行 setup。正常安装只有两条命令：

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

```bash
codex plugin add codemap-boost-codex@codex-toolshop
```

安装后创建一个新的 Codex 任务。插件自带的 `.mcp.json` 会在任务加载 MCP 时直接启动跨平台 Node 入口；入口会在 Codex 插件数据目录中创建或修复隔离的 CRG venv，然后启动 `code-review-graph serve`。首次安装不依赖 SessionStart 事后注册 MCP，因此主代理和自动子代理能在同一新任务中获得图工具。

插件原生 MCP 明确设置 `startup_timeout_sec = 600`，给首次创建 venv、安装依赖和 CRG 冷启动留出时间。多个任务同时首次启动时通过安装锁串行化，不会并发重建同一个 venv。

可以用下面的命令验证 Codex 已解析插件原生 MCP：

```bash
codex mcp get code-review-graph --json
```

正常结果是 stdio、`command = node`、参数为 `scripts/mcp-server.cjs`、`cwd` 位于已安装插件根目录，并显示 `startup_timeout_sec = 600`。这个 `cwd` 只负责稳定定位插件启动脚本；图查询前的 `PreToolUse` 会把当前任务的 Git 根目录补入 CRG 的 `repo_root`，避免误查插件目录。已经启动的旧任务不会动态补载新插件能力，所以“新建任务”是 Codex 的加载边界，不是额外配置步骤。

## 自动启用

原生 MCP 启动器是默认安装路径：它解析与 Codex hooks 相同的 marketplace-qualified 插件数据目录，维护私有运行时并启用 CodeMap。`SessionStart` 继续负责 `$CODEX_HOME/AGENTS.md` 托管块、旧版插件全局 MCP 覆盖迁移和当前 Git 仓库的 build/update。

从旧版本升级时，如果 `config.toml` 中还存在插件以前创建的私有运行时绝对路径注册，它会比插件原生 MCP 优先。SessionStart 会根据插件数据目录路径证明其归属后自动移除，且不会删除无关的用户配置。发生迁移后，新建一个任务即可，不需要手工 setup。旧式 `uvx code-review-graph serve` 无法仅凭命令判断是插件还是用户创建，因此不会自动删除；`--doctor` 会把这类同名覆盖明确列出，交由用户确认。

## setup 与 doctor 后补选项

`codemap-boost-setup` 保留为修复、诊断和显式预热入口，不属于正常安装步骤。需要时可以在 Codex 中输入：

```text
使用 codemap-boost-setup 帮我配置 CodeMap Boost
```

setup 会执行这些动作：

- 在插件数据目录维护独立的 `crg-runtime` venv，不读取用户级 site-packages，也不修改用户 PATH。
- 优先用 `uv` + Python 3.12 创建 venv；无 uv 时用系统 Python 的 `venv`，然后只向该 venv 安装 `code-review-graph[all]`。
- 安装后用与上游相同的 Python `-I` 隔离模式加载 Python、JavaScript、TypeScript、TSX parser；仅 CLI 存在不再视为健康。
- 检查同名 MCP；只自动移除能由插件数据目录路径证明归属的旧版私有运行时全局覆盖，不再创建全局 MCP 注册，也不会擅自删除用户创建的 `uvx` 配置。
- 健康检查或旧注册迁移失败时写入诊断 marker 并返回非零。
- 可选安装 `graphifyy[all]`，用于提供 `graphify` 命令。

只需要检查、不希望修改任何配置时，在目标项目目录运行：

```bash
node "<plugin-root>/scripts/setup.cjs" --doctor
```

`--doctor` 是只读诊断，不安装依赖、不执行 MCP add/remove、不构建图谱，也不修改 `AGENTS.md`、`.gitignore` 或插件 marker。它会分别报告：

- Codex CLI 的实际路径、版本、`CODEX_HOME` 和插件数据目录。
- 插件私有 CRG 运行环境及 parser 健康状态。
- 插件原生 MCP 声明、600 秒启动超时，以及是否存在会遮蔽它的同名全局配置。
- 当前目录对应的 Git 仓库和项目图谱 `status`。
- 当前任务工具状态为 `UNKNOWN`：外部 CLI 无法读取已启动任务的工具快照，需在新任务中确认 `mcp__code_review_graph__*` 是否出现。
- 可直接执行的修复命令，以及修复后是否必须完整重启并创建新任务。

诊断结果为 `READY` 时退出码为 `0`；需要修复或构建时退出码为 `1`。`--doctor` 不能与 `--build`、`--with-graphify` 或 `--skip-install` 一起使用，以保证只读。

setup 脚本应以目标项目作为工作目录运行；这样 `.gitignore` 和初始图谱都会落在当前项目，而不是插件仓库。

正常安装和日常使用都不需要运行 setup。后续 SessionStart / PostToolUse hook 会自动 build 或 update 图谱。

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

插件原生 MCP 负责首次准备私有 CRG 运行环境；6 类 Codex hook 负责指导、图谱构建和增量更新。原生 MCP 启动失败时，`SessionStart` 仍会执行后台自愈，为下一个任务恢复运行时。显式禁用时 hook 保持静默。

| Hook | 私有 CRG 运行环境健康后的作用 |
| --- | --- |
| `SessionStart` | 迁移旧版插件全局 MCP 覆盖，维护 `$CODEX_HOME/AGENTS.md` 的 CodeMap 托管块，并同步完成 build/update；不会修改项目 `.gitignore`。 |
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
- 设置 `CODEMAP_BOOST_DISABLE_BOOTSTRAP=1` 可关闭 SessionStart 后台自愈；设置 `CODEMAP_BOOST_DISABLE_GRAPH=1` 可完全关闭图谱行为。
