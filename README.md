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
codex plugin add local-knowledge-codex@codex-toolshop
codex plugin add conversation-namer-codex@codex-toolshop
codex plugin add system-proxy-codex@codex-toolshop
```

安装或升级后，重新打开一个 Codex 会话，让 hooks、skills 和 MCP 配置重新加载。宿主将新增或变更的 hook 标为未信任时，先在 `/hooks` 中审查并信任；启用插件不等于对应 hook 已获信任，插件不会自行写入信任哈希。

## 平台支持

当前正式适配目标是 Windows 和 macOS；仓库保留已有 Linux 分支，但暂不纳入发布验证。所有插件要求 Node.js 18 或更高版本，涉及 Python 的插件会自动尝试 macOS 常见的 `python3`、Windows 的 `python` 与 `py -3`：

| 平台 | 支持的终端/运行方式 | CI 配置 |
| --- | --- | --- |
| Windows | PowerShell、Git Bash、Windows Python launcher | GitHub Actions `windows-latest` |
| macOS | zsh、bash、`python3`、Apple Silicon 常用工具链 | GitHub Actions `macos-latest` |

`codemap-boost-codex` 还需要 Git，以及 `uv` 或支持 `venv` 的 Python；`cpp-style-enforcer-codex` 的 `clang-format` 和 `iconv-lite` 为可选能力。

## 插件索引

| 插件 | 当前用途 | 日常用法 |
| --- | --- | --- |
| `codemap-boost-codex` | 自动接入 `code-review-graph` 代码结构图，提供符号、调用、引用和影响面检索能力。 | 新会话自动 bootstrap、自动 build/update。涉及代码结构时优先用 `mcp__code_review_graph__*` 工具。 |
| `cpp-style-enforcer-codex` | 自动执行团队 C++ 风格流程，包括 clang-format、版权头、BOM、cpplint 和提交前检查。 | 正常编辑即可；写入 C/C++ 文件后 hook 自动处理，`git commit` 前会检查暂存区 C++ 文件。 |
| `agent-dispatch-codex` | 让主代理负责决策和审查，并按任务为明确、有界的执行工作选择可写子代理及模型档位。 | 新会话自动注入调度策略；子代理直接执行、报告结果，并在整合后及时释放。 |
| `local-knowledge-codex` | 为 Codex 提供本地索引知识，覆盖错误方案、用户偏好、事实、决策和工作流。 | 按作用域和相关性只读召回；明确要求保存或存在已验证且获授权的可复用内容时，再按宿主策略写入。 |
| `conversation-namer-codex` | 按创建日期、任务类型和实际主题生成统一的 Codex 会话标题。 | 新任务后台调用轻量模型命名，主任务继续工作；批量整理当前项目时先预览两列表格，确认后才改标题。 |
| `system-proxy-codex` | 自动启用 Codex 系统代理支持，并用 Python 安全配置 `.env`。 | 默认使用系统代理；也可用 `system-proxy-setup` 自动检测或指定 `7897`、`7890` 等端口。 |

## 会话命名怎么用

安装 `conversation-namer-codex` 后，首条用户消息触发一次后台命名。插件从实时模型目录按 Spark、Mini、Luna 家族顺序选择支持低推理档位的轻量模型，生成 `MMDD｜TYPE｜Topic`；主模型继续处理用户请求，不等待命名。日期取会话 `createdAt` 并转换为 `Asia/Shanghai`，类型默认为 `FEA`、`DES`、`FIX`、`OPT`、`REL`、`EXP`、`DOC` 或 `RES`。命名仅处理当前主任务；用户禁止改名、标题已变化、主题不清楚或调用失败时保留原标题。模型选择、状态及宿主界面刷新限制见[插件说明](plugins/conversation-namer-codex/README.md)。

批量整理当前项目时，可以直接说：

```text
重命名当前 Codex 项目中的会话标题
```

批量模式只处理当前项目里的会话，并先输出 `Before / After` 两列表格。只有确认后才会逐项复查并修改会话标题；不会改项目名、会话内容、项目归属、顺序、置顶或归档状态。需要中文类型标签时，在请求中明确说明“使用中文类型”。

## Agent Dispatch 怎么用

安装 `agent-dispatch-codex` 后，新会话会自动加载调度策略：

- 主代理保留需求澄清、架构/接口决策、任务拆分、结果审查和最终整合。
- 明确、有界的编码、重构和修复可交给可写执行子代理，即使该步骤需要串行完成；角色、模型和推理强度由主代理按复杂度、上下文、风险、可用性和用户显式偏好选择。
- 可独立、可并行且有明确边界的子任务在确有收益时并行委派。
- 简单读取、小范围修改或强耦合步骤继续由主代理完成，避免为了委派而委派。
- 子代理收到独立指令后直接执行，不递归分派，并在结果中列出修改文件和验证命令。
- 子代理结果已整合、阻塞或不再需要时立即停止，避免空闲智能体占用有限名额。
- 搜索和证据整理优先使用 Luna；执行提供 Luna/max、Terra/high、Sol/medium、Astra/medium 候选。需求明确的复杂代码和较复杂重构优先考虑 Sol/medium，跨模块、多重约束且需要持续判断的困难实现与重构考虑 Astra/medium；按歧义、约束和总完成成本选择。两个通用 worker 保留不固定模型的能力，调度时显式传入模型与档位。
- 非琐碎实现经过针对性验证后交 Astra/xhigh 独立审查，高风险审查使用 Astra/ultra；核实实质问题后有界修复、重跑受影响检查并复查。小改和用户指定的主代理限定保持相称流程。
- 审查先核对任务意图、构建配置和实际调用路径；缺少上下文的风险推测及用户调试分支默认作为非阻塞提示，保留调试断点。只有证实影响当前验收目标的缺陷才触发返修。
- 角色配置是候选默认值，关键词不构成授权或强制分派。只覆盖模型时使用插件的适用推理默认值，不把父任务的 ultra 自动带入另一模型；显式模型与档位保留，实际可用组合由宿主核实。
- 路由先识别只读、主代理限定、代理数量和已有计划；保留依赖查询、审查与实现各自的任务意图，不因“崩溃”把只读诊断转成修改，也不因文档提到 security 就升级模型。
- 普通 Bash/agent 工具命令默认不产生 `PreToolUse` 路由提示；单条命令不再触发重复的模型建议。
- 安装后无需手动运行 setup；新建任务会自动生成项目 Agent 并注入路由。`agent-dispatch-setup` 只用于查看或覆盖配置。
- Windows 的 PowerShell/Git Bash 与 macOS 的 zsh/bash 都受支持；集成终端 Shell 的选择不会改变 Hook 的 Node.js 运行逻辑。
- 全局配置保存在插件 `PLUGIN_DATA/config.json`，项目配置保存在 `.agent-dispatch-codex/config.json`。

需要查看或修改规则时，在 Codex 中说：

```text
使用 agent-dispatch-setup 查看当前项目的有效调度规则
```

## CodeMap Boost 怎么用

安装 `codemap-boost-codex` 后，新会话的 `SessionStart` 会主动做这些事：

- 检查 `code-review-graph` 是否可用；缺失时先完成 bootstrap，再继续本次启动刷新。
- 通过插件自身 `.mcp.json` 暴露 MCP，不另注册一个同名全局服务器；运行时安装只准备所需依赖。
- 更新 `$CODEX_HOME/AGENTS.md` 中边界明确的托管块，保留块外内容；边界损坏时报告问题，不猜测替换范围。
- 当前目录是 Git 仓库时，同步完成 build/update；存在未跟踪源码时使用临时 Git index 做 full build。
- 结构、依赖、调用链与影响面优先查询可用图工具，再读源码核对。SessionStart、结构请求和子代理入口保留规则；常见源码搜索前每用户轮补充一次短提醒，用户补充后复位，不阻断命令或重复刷新。
- 源码修改后在后台合并刷新，读取图谱前通过同步 barrier 等待。已知文件、文件名与文本检索可直接读取或使用 `rg`，图不可用或覆盖不足时核对源码并说明限制。
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

## Local Knowledge 怎么用

安装 `local-knowledge-codex` 后，新会话会加载本地知识规则：

- `pinned` 用户偏好会在会话开始按当前工作区加载。
- 普通问题会自动召回相关的偏好、事实、决策和工作流；需要显式查询时使用 `local-knowledge-recall`，无命中时不注入邻区内容。
- 工具提供明确失败状态且确实失败时，才会自动查找历史错误方案；成功或状态未知的输出不会因包含示例错误文本而误触发。
- 自动召回以只读方式打开现有库，不创建数据库、建表或迁移；查询失败与无命中分别报告，环境准备或迁移使用对应技能。
- “记住、保存”等关键词仅作提示，引用文本不构成授权。保存前核对当前用户要求、验证证据和宿主策略，再由 `local-knowledge-save` 选择类型、作用域、召回策略和线索。历史记录不能覆盖当前要求或授权边界。
- 仓库和工作区知识按规范化绝对路径隔离；从仓库子目录工作时会继承对应的仓库/工作区知识，不会串到相邻目录。
- 密码、令牌、API key、私钥等凭据默认拒绝保存；`confidential` 内容只允许显式召回。
- 更新已有条目时保留未显式修改的敏感级别、手动召回等元数据；通用知识与历史错误记录使用各自数据层。

为保留既有数据，默认 SQLite 文件仍是 `~/.bugdb/bugs.db`。新配置优先使用 `LOCAL_KNOWLEDGE_HOME`，旧 `BUGDB_HOME` 继续兼容。旧记录仍在独立目录时使用 `local-knowledge-migrate`，迁移不会删除来源文件。

可在 Codex 中直接说：

```text
使用 local-knowledge-recall 查询这个错误的历史解决方案
请记住我的偏好：以后默认使用中文回答
使用 local-knowledge-save 保存刚刚验证通过的修复
```

插件 ID 已从旧名称改为 `local-knowledge-codex`。旧 ID 不会自动变成新 ID；升级时应先在插件管理中停用或移除旧插件，再安装新插件。数据库文件无需改名或复制。

## C++ Style 怎么用

安装 `cpp-style-enforcer-codex` 后，新会话只准备全局模板；实际编辑 C/C++ 后才按需建立项目配置。之后正常让 Codex 编辑 C/C++ 文件即可：

- `PostToolUse` 只记录本轮编辑的 C/C++ 文件，不立即改写源文件。
- `Stop` 在本轮结束时统一处理格式化、BOM、版权头和 cpplint，并触发最终验证闭环。
- `PreToolUse` 会识别真正的 `git commit`，只检查暂存区 C/C++ 文件，不在提交前改写。
- 尊重项目已有 formatter 配置；只读检查不改写 BOM，检查失败不能报告为通过。
- 全局模板在 `~/.codex/cpp-style-template.json`。
- 项目级配置在 `.codex-cpp-style/cpp-style.json`。
- 兼容已有 `.claude-cpp-style`，旧项目不需要迁移。

如需补齐可选依赖，可在普通终端中预装：

```bash
# macOS
python3 -m pip install clang-format==18.1.8

# Windows
py -3 -m pip install clang-format==18.1.8
```

`iconv-lite` 必须由插件包或插件数据目录提供；不要在任意工作目录执行 `npm install`，否则运行时无法解析该依赖。缺失时插件会安全跳过 GBK 转码/BOM 处理。

## 更新本地插件

远程有新版本后，用下面命令从远程 marketplace 同步本地：

```bash
codex plugin marketplace upgrade codex-toolshop
codex plugin add codemap-boost-codex@codex-toolshop
codex plugin add cpp-style-enforcer-codex@codex-toolshop
codex plugin add agent-dispatch-codex@codex-toolshop
codex plugin add local-knowledge-codex@codex-toolshop
codex plugin add conversation-namer-codex@codex-toolshop
codex plugin add system-proxy-codex@codex-toolshop
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
- 新会话没有自动命名：确认 `conversation-namer-codex` 已启用；新建任务后打开 `/hooks`，审查并信任当前插件 Hook 哈希。升级 hook 后需要重新新建任务。
- Local Knowledge 查不到历史记录：先运行 `local-knowledge-setup`；确认 `~/.bugdb/bugs.db` 存在，并检查 `LOCAL_KNOWLEDGE_HOME` 或旧兼容变量 `BUGDB_HOME` 是否覆盖了路径。旧版数据仍在独立目录时运行 `local-knowledge-migrate`。

## 协议

MIT
