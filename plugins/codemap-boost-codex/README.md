# CodeMap Boost for Codex

`codemap-boost-codex` 是一个 Codex 插件，用来把 code-review-graph 驱动的代码结构图工作流接入 Codex。

它不会读取或修改旧宿主目录；Codex 持久提示写入 `CODEX_HOME/AGENTS.md`，hook 运行数据写入 Codex 插件数据目录。

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

## 它会做什么

插件会自动注册 5 类 Codex hook：

| Hook | 作用 |
| --- | --- |
| `SessionStart` | 维护 `$CODEX_HOME/AGENTS.md` 的 CodeMap 托管块，保护图谱输出目录，并尝试准备 code-review-graph。 |
| `PostToolUse` | Codex 写文件或运行 Bash 后，后台触发 code-review-graph 增量更新。 |
| `PreToolUse:Bash` | 当 Bash 命令像是在做代码结构搜索时，向 Codex 注入图谱优先提示，不阻止命令。 |
| `UserPromptSubmit` | 当用户问题涉及符号、调用、引用、影响面等结构问题时，提醒 Codex 优先使用图谱 MCP 工具。 |
| `SubagentStart` | 子代理启动时注入同样的 CodeMap 使用规则。 |

## 依赖

推荐安装：

```bash
python -m pip install "code-review-graph[all]"
code-review-graph install --platform codex --no-hooks --no-instructions --no-skills --yes
python -m pip install "graphifyy[all]"
```

`graphifyy` 是 PyPI 包名，安装后提供 `graphify` 命令。`graphify` 是可选能力；缺失时对应功能会静默跳过。

插件首次启动时也会在后台尝试准备缺失的 CLI，并执行：

```bash
code-review-graph install --platform codex --no-hooks --no-instructions --no-skills --yes
```

这一步只注册 code-review-graph MCP，不安装第三方 hooks、不改写 Codex 全局说明、不生成第三方 skills。Codex hooks 和 `$CODEX_HOME/AGENTS.md` 托管块都由本插件自己管理。

如果安装或注册失败，会写入插件数据目录中的失败标记，避免每次会话反复重试。

## 生成文件

项目内可能生成：

```text
.code-review-graph/
graphify-out/
```

插件会在 Git 项目的 `.gitignore` 中追加这两个目录，避免误提交图谱产物。

Codex 全局提示托管块写入：

```text
$CODEX_HOME/AGENTS.md
```

如果未设置 `CODEX_HOME`，Codex 默认使用用户目录下的 `.codex`。
