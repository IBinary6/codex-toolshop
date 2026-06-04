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

## 显式启用

安装插件只会注册 Codex hook，不会自动安装 Python 依赖、不会自动注册 `code-review-graph` MCP，也不会自动启动后台图谱构建。

推荐在 Codex 中输入：

```text
使用 codemap-boost-setup 帮我配置 CodeMap Boost
```

setup 会执行这些动作：

- 检查 `code-review-graph` 是否已经可用；已安装则不重复安装。
- 缺失时才安装 `code-review-graph[all]`。
- 注册 Codex MCP，但禁止第三方工具写入 hooks、instructions、skills。
- 写入启用 marker；只有 marker 存在后，后台 build/update 和提示注入才会生效。
- 可选安装 `graphifyy[all]`，用于提供 `graphify` 命令。

setup 脚本应以你的目标项目作为工作目录运行；这样 `.gitignore` 和初始图谱都会落在当前项目，而不是插件仓库。

底层依赖命令如下；如果只执行这些命令，还需要通过 setup 写入插件启用 marker：

```bash
python -m pip install "code-review-graph[all]"
code-review-graph install --platform codex --no-hooks --no-instructions --no-skills --yes
```

`graphify` 是可选能力；需要时再安装：

```bash
python -m pip install "graphifyy[all]"
```

## 它会做什么

插件会注册 5 类 Codex hook。未显式 setup 时，这些 hook 保持静默，不会启动后台 Python 任务。

| Hook | setup 后的作用 |
| --- | --- |
| `SessionStart` | 维护 `$CODEX_HOME/AGENTS.md` 的 CodeMap 托管块，保护图谱输出目录，并在图谱缺失时启动一次后台 build。 |
| `PostToolUse` | Codex 写文件或运行 Bash 后，按锁和节流规则后台触发 `code-review-graph update`。 |
| `PreToolUse:Bash` | 当 Bash 命令像是在做代码结构搜索时，向 Codex 注入图谱优先提示，不阻止命令。 |
| `UserPromptSubmit` | 当用户问题涉及符号、调用、引用、影响面等结构问题时，提醒 Codex 优先使用图谱 MCP 工具。 |
| `SubagentStart` | 子代理启动时注入同样的 CodeMap 使用规则。 |

## 生成文件

项目内可能生成：

```text
.code-review-graph/
graphify-out/
```

setup 后插件会在 Git 项目的 `.gitignore` 中追加这两个目录，避免误提交图谱产物。

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
