# Codex Toolshop

`codex-toolshop` 是 IBinary6 内部使用的 Codex 插件市场，集中维护逆向调试、代码检索、工程规范、任务调度与本地知识工具。各插件按需安装，通过脚本和宿主 hooks 完成日常配置与维护。

## 快速安装

首次使用只需要添加一次 marketplace：

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

按需要安装插件：

```bash
codex plugin add dbg-codex@codex-toolshop
codex plugin add codemap-boost-codex@codex-toolshop
codex plugin add tgrep-search-codex@codex-toolshop
codex plugin add cpp-style-enforcer-codex@codex-toolshop
codex plugin add agent-dispatch-codex@codex-toolshop
codex plugin add local-knowledge-codex@codex-toolshop
codex plugin add conversation-namer-codex@codex-toolshop
codex plugin add system-proxy-codex@codex-toolshop
```

安装或升级后，重新打开一个 Codex 会话，让 hooks、skills 和 MCP 配置重新加载。宿主将新增或变更的 hook 标为未信任时，先在 `/hooks` 中审查并信任；启用插件不等于对应 hook 已获信任，插件不会自行写入信任哈希。

## 平台支持

市场主要面向 Windows 和 macOS；Dbg 和 tgrep 另外提供 Linux 的部署脚本与 CI 验证。各插件的依赖和兼容范围以其说明为准，不能把一种插件的验证范围套用于整个市场。所有插件要求 Node.js 18 或更高版本：

| 平台 | 支持的终端/运行方式 | CI 配置 |
| --- | --- | --- |
| Windows | PowerShell、Git Bash、Windows Python launcher | GitHub Actions `windows-latest` |
| macOS | zsh、bash、`python3`、Apple Silicon 常用工具链 | GitHub Actions `macos-latest` |
| Linux（Dbg、tgrep） | bash；Dbg 需要 Python 及适用调试工具，tgrep 使用固定发布包 | 对应插件的 GitHub Actions `ubuntu-latest` |

`codemap-boost-codex` 还需要 Git，以及 `uv` 或支持 `venv` 的 Python；`cpp-style-enforcer-codex` 的 `clang-format` 和 `iconv-lite` 为可选能力。

## 插件索引

| 插件 | 当前用途 | 日常用法 |
| --- | --- | --- |
| [Dbg](plugins/dbg-codex/README.md) | 发现 Scoop、Homebrew 和手动安装的调试工具，部署 x64dbg、Ghidra、WinDbg、IDA 的扩展及 MCP。 | 首次加载自动部署；`dbg doctor` 再次检测、更新、修复；不兼容版本明确跳过，全程由脚本执行。 |
| `codemap-boost-codex` | 内置 `code-review-graph` 代码图与 Serena 语义 MCP，提供结构、符号、引用和影响面检索。 | 自动准备独立运行时并维护图谱；图先定位，Serena 按需补充。默认关闭 Serena Dashboard、自动打开浏览器和 GUI 日志窗口。 |
| [tgrep-search-codex](plugins/tgrep-search-codex/README.md) | 自动准备固定版本 tgrep，按 Git 工作树维护文本搜索索引和后台服务，与 CodeMap 配合。 | 任务启动自动准备；通过 hook 给出的搜索入口查询。索引未就绪或服务异常时实时扫描，`--fresh` 用于刚修改的内容和完整性核查。 |
| `cpp-style-enforcer-codex` | 自动执行团队 C++ 风格流程，包括 clang-format、版权头、BOM、cpplint 和提交前检查。 | 正常编辑即可；写入 C/C++ 文件后 hook 自动处理，`git commit` 前会检查暂存区 C++ 文件。 |
| `agent-dispatch-codex` | 面向产品、设计、QA、研究、运营和开发，按调查、规划、制作、验证、审查分配有界任务与模型。 | 新会话自动注入通用调度策略；按交付物验收，子代理直接执行、报告结果，并在整合后及时释放。 |
| `local-knowledge-codex` | 为 Codex 提供本地索引知识，覆盖错误方案、用户偏好、事实、决策和工作流。 | 按作用域和相关性只读召回；明确要求保存或存在已验证且获授权的可复用内容时，再按宿主策略写入。 |
| `conversation-namer-codex` | 按创建日期、任务类型和实际主题生成统一的 Codex 会话标题。 | 新任务后台调用轻量模型命名，主任务继续工作；批量整理当前项目时先预览两列表格，确认后才改标题。 |
| `system-proxy-codex` | 自动启用 Codex 系统代理支持，并用 Python 安全配置 `.env`。 | 默认使用系统代理；也可用 `system-proxy-setup` 自动检测或指定 `7897`、`7890` 等端口。 |

## Dbg 怎么用

安装 `dbg-codex` 后，在新 Codex 任务首次加载插件时，脚本自动检测本机调试工具，下载适配的扩展、准备隔离运行时，并生成本机路径和 MCP 启动配置。MCP 由插件自带，无需在 CC Switch 另行登记。之后新增、升级或移动了工具，仍只需执行同一个命令：

```sh
dbg doctor
```

| 平台 | 自动发现来源 | 可部署的组件 |
| --- | --- | --- |
| Windows | Scoop 用户、全局及自定义根目录，活动 `current`、注册安装、PATH 和常见手动安装目录 | x64dbg/x32dbg、Ghidra、WinDbg、兼容的 IDA |
| macOS | Apple Silicon/Intel Homebrew 实际前缀、活动 formula、相关已安装 cask、Applications、PATH 和常见手动安装目录 | Ghidra、兼容的 IDA |
| Linux | Homebrew/Linuxbrew 实际前缀、活动 formula、PATH 和常见手动安装目录 | Ghidra、兼容的 IDA |

Dbg 自动填写发现到的宿主、Python、JDK、扩展目录及 MCP 路径；换电脑后重新按当地环境计算，不沿用上一台电脑的绝对路径。软件未安装就跳过；IDA 8.2、IDA Free 或无法确认兼容性的版本明确标记为不支持。任意自定义目录无法保证自动发现，未命中时可在 Dbg 的 `config.json` 补充路径，再执行 doctor。

原生调试软件仍由用户安装。Ghidra 首次需要在 GUI 中启用扩展，实际调试需要打开对应工具及目标。macOS/Linux 的 `dbg` 安装在 `~/.local/bin`，该目录不在 PATH 时 doctor 会给出配置提示。部署完成与调试目标已连接是两个不同状态，详情见 [Dbg 的组件、配置和验证说明](plugins/dbg-codex/README.md)。

只想减少 Codex 加载的 MCP 时，可以停用或卸载 Dbg 插件；已部署到调试软件中的扩展、独立运行时和备份会保留，卸载插件不等于清除这些本地文件。

## 会话命名怎么用

安装 `conversation-namer-codex` 后，首条用户消息触发一次后台命名。插件从实时模型目录按 Spark、Mini、Luna 家族顺序选择支持低推理档位的轻量模型，生成 `MMDD｜TYPE｜Topic`；主模型继续处理用户请求，不等待命名。日期取会话 `createdAt` 并转换为 `Asia/Shanghai`，类型默认为 `FEA`、`DES`、`FIX`、`OPT`、`REL`、`EXP`、`DOC` 或 `RES`。命名仅处理当前主任务；用户禁止改名、标题已变化、主题不清楚或调用失败时保留原标题。模型选择、状态及宿主界面刷新限制见[插件说明](plugins/conversation-namer-codex/README.md)。

批量整理当前项目时，可以直接说：

```text
重命名当前 Codex 项目中的会话标题
```

批量模式只处理当前项目里的会话，并先输出 `Before / After` 两列表格。只有确认后才会逐项复查并修改会话标题；不会改项目名、会话内容、项目归属、顺序、置顶或归档状态。需要中文类型标签时，在请求中明确说明“使用中文类型”。

## Agent Dispatch 怎么用

安装 `agent-dispatch-codex` 后，新会话会自动加载调度策略：

- 主代理保留目标与需求澄清、关键业务及架构/接口决策、任务拆分、结果审查和最终整合。
- 明确、有界的材料制作、文档与数据处理、设计交付、编码和修复可交给可写执行子代理；角色、模型和推理强度由主代理按复杂度、上下文、风险、可用性和用户显式偏好选择，不按职业固定模型。
- 可独立、可并行且有明确边界的子任务在确有收益时并行委派。
- 简单读取、小范围修改或强耦合步骤继续由主代理完成，避免为了委派而委派。
- 子代理收到独立指令后直接执行，不递归分派，并报告交付物、修改文件、验证方法与证据。
- 子代理结果已整合、阻塞或不再需要时立即停止，避免空闲智能体占用有限名额。
- 模型和推理强度由主代理按任务歧义、约束、风险、可用性、总完成成本以及用户或 skill 的显式选择决定，不按领域词固定 Luna，也不为本地提交准备新增角色或开关；未固定模型的 writer 调度时显式传入模型与档位。
- 非琐碎交付经过针对性验证后独立审查，默认提供 Astra/xhigh 和高风险 Astra/ultra 候选；核实实质问题后有界修复、重跑受影响检查并复查。小改和用户指定的主代理限定保持相称流程。
- 验证对应交付物：产品核对需求覆盖，设计核对体验与一致性，QA 按验收计划复现，研究核对来源，数据核对口径，代码执行相关测试。审查只把证实影响当前验收目标的缺陷作为返修依据；代码场景继续核对构建配置与调用路径，并保留没有缺陷证据的用户调试分支。
- 角色配置是候选默认值，关键词不构成授权或强制分派。只覆盖模型时使用插件的适用推理默认值，不把父任务的 ultra 自动带入另一模型；显式模型与档位保留，实际可用组合由宿主核实。
- 路由先识别只读、主代理限定、代理数量和已有计划；保留依赖查询、审查与实现各自的任务意图，不因“崩溃”把只读诊断转成修改，也不因文档提到 security 就升级模型。
- 普通 Bash/agent 工具命令以及普通单条 Git CLI 默认不产生 `PreToolUse` 路由提示；Git 静默独立于 `pre_tool_nudge`，单条命令不再触发重复的模型建议。只有主代理根据用户请求或明确 skill 工作流显式委派完整本地提交准备时，才可由同工作区单个指定可写代理检查状态、读取 diff、精确暂存目标文件并回传摘要、检查结果、HEAD/index tree OID 和 commit message；最终 commit、远程操作和历史改写仍由主代理完成。
- 安装后无需手动运行 setup；新建任务会注入路由，在 Git 项目生成具名 Agent。非 Git 任务使用宿主已加载的能力或主代理，不假定具名角色已加载。`agent-dispatch-setup` 只用于查看或覆盖配置。
- 专业工具与技能按实际工作选择；代码图只用于代码结构任务。可写角色和路由建议不新增对外发送、发布、付费或修改真实数据的授权。
- Windows 的 PowerShell/Git Bash 与 macOS 的 zsh/bash 都受支持；集成终端 Shell 的选择不会改变 Hook 的 Node.js 运行逻辑。
- 全局配置保存在插件 `PLUGIN_DATA/config.json`，项目配置保存在 `.agent-dispatch-codex/config.json`。

需要查看或修改规则时，在 Codex 中说：

```text
使用 agent-dispatch-setup 查看当前项目的有效调度规则
```

## CodeMap Boost 怎么用

CodeMap/Serena 与 tgrep 的封装运行时支持每周自动检查上游稳定版，在独立目录验证后供后续启动使用，失败保留旧版。CodeMap 还会对官方 `codex-toolshop` 市场中的已安装插件按周调用 Codex 原生更新入口；没有使用时不额外唤醒电脑。更新机制、关闭选项与只读状态命令见 [CodeMap 每周自动更新](plugins/codemap-boost-codex/README.md#每周自动更新)。

安装 `codemap-boost-codex` 后，新任务的原生 MCP 启动器与 hooks 会主动做这些事：

- 检查 `code-review-graph` 是否可用；缺失时先完成 bootstrap，再继续本次启动刷新。
- 通过插件自身 `.mcp.json` 暴露 MCP，不另注册一个同名全局服务器；运行时安装只准备所需依赖。
- 自动安装固定 Serena 1.7.0 到独立私有 venv，关闭 Dashboard、浏览器自动打开和 GUI 日志窗口；保留用户已有的 MCP 管理器配置。语义查询前激活实际目标项目，避免误用插件目录。
- 更新 `$CODEX_HOME/AGENTS.md` 中边界明确的托管块，保留块外内容；边界损坏时报告问题，不猜测替换范围。
- 当前目录是 Git 仓库时，同步完成 build/update；存在未跟踪源码时使用临时 Git index 做 full build。
- 结构、依赖、调用链与影响面优先查询可用图工具，再读源码核对。SessionStart、结构请求和子代理入口保留规则；常见源码搜索前每用户轮补充一次短提醒，用户补充后复位，不阻断命令或重复刷新。
- 源码修改后在后台合并刷新，读取图谱前通过同步 barrier 等待。已知文件直接读取；普通仓库文本与文件发现优先使用可用的 tgrep 搜索入口，需要即时内容或索引不可用时实时扫描。图不可用或覆盖不足时核对源码并说明限制。
- 把 `.code-review-graph/` 和 `graphify-out/` 写入当前仓库的 `.git/info/exclude`，不改项目 `.gitignore`。

如果想手动预热或排障，可以在 Codex 中说：

```text
使用 codemap-boost-setup 帮我配置 CodeMap Boost
```

常用验证命令：

```bash
codex mcp get code-review-graph --json
codex mcp get serena --json
codex plugin list
```

## CodeMap、Serena 与 tgrep 怎么配合

安装 `tgrep-search-codex` 后，受宿主信任的 `SessionStart` hook 在 Git 任务启动或恢复时自动准备 tgrep 并启动 `serve`；缺少索引由服务建立，无需手动执行 `tgrep index` 或 `tgrep serve`。首次下载和建索引在后台进行，查询入口会处理未就绪状态。打开 Codex 首页本身不等于触发任务启动 hook。

| 需求 | 使用方式 |
| --- | --- |
| 调用链、符号关系、引用和影响面 | CodeMap 图查询，再读源码核对。 |
| 精确符号定义、实现与引用 | 图先缩小范围，按需用内置 Serena/LSP 补充；语言服务未就绪时采用源码和文本证据。 |
| 普通仓库文本搜索 | 使用 tgrep 插件注入的 CLI 包装入口，健康索引负责加速。 |
| 刚修改的内容、需要完整且最新的结论 | 包装入口加 `--fresh` 实时扫描；也可使用 `rg`。 |
| 文件发现 | 索引可用时使用 `--files`；即时列表使用 `--fresh --files` 或 `rg --files`。 |
| 已知文件 | 直接读取。 |

包装入口按真实工作树隔离状态、复用服务，索引未完成、服务异常或索引查询零命中时走实时扫描。实时扫描仍遵守查询过滤与大小限制；特殊编码、原始字节或索引范围以外的需求按 [tgrep 插件说明](plugins/tgrep-search-codex/README.md)选择参数。代码定位先查图；未命中或覆盖不足时由 Serena 或文本搜索补充候选，必要时再交给图查关系或 Serena 查符号。证据充分即可结束，不要求每次调用全部工具。tgrep 插件独立负责安装、启动和查询降级；Serena 的语言服务依赖及项目激活见 [CodeMap 说明](plugins/codemap-boost-codex/README.md#内置-serena安静启动与项目边界)。

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
- `Stop` 在本轮结束时统一处理格式化、BOM、版权头、行尾和 cpplint，并触发最终验证闭环。
- Visual Studio 源工程的已编辑 C/C++ 文件强制 CRLF，其他工程通过 `lineEnding` 选择 `lf`、`crlf` 或 `preserve`；缺少末尾换行自动补同种换行，关闭 clang-format 或旧文件风格检查也能生效。
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
codex plugin add dbg-codex@codex-toolshop
codex plugin add codemap-boost-codex@codex-toolshop
codex plugin add tgrep-search-codex@codex-toolshop
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

- Dbg 新安装的工具没有出现：执行 `dbg doctor`，检查报告中的 `not_installed`、`unsupported` 或错误原因；部署完成后新开 Codex 任务加载 MCP。Ghidra 还需在 GUI 中启用扩展。
- `failed to parse plugin hooks config ... unknown field description`：更新到新版插件，并确认缓存中的 `hooks/hooks.json` 顶层只有 `hooks`。
- CodeMap 没有图谱：确认当前目录是 Git 仓库，运行 `code-review-graph status`；新会话会在使用前等待首次 build 完成。
- CodeMap 完全不工作：检查是否设置了 `CODEMAP_BOOST_DISABLE_GRAPH=1` 或 `CODEMAP_BOOST_DISABLE_BOOTSTRAP=1`。
- tgrep 未就绪或新文件未命中：使用插件搜索入口的 `--fresh` 实时扫描，通过该入口的 `status` / `doctor` 查看状态；首次下载、建索引及文件变化同步是不同阶段。hook 未受信任时按宿主界面处理，插件不会自行授予信任。
- C++ 风格检查没有格式化：确认 `clang-format` 可用；缺失时格式化会跳过，但 cpplint 等流程仍继续。
- Agent Dispatch 没有生效：新建任务后打开 `/hooks`，审查并信任当前插件 Hook 哈希。
- 新会话没有自动命名：确认 `conversation-namer-codex` 已启用；新建任务后打开 `/hooks`，审查并信任当前插件 Hook 哈希。升级 hook 后需要重新新建任务。
- Local Knowledge 查不到历史记录：先运行 `local-knowledge-setup`；确认 `~/.bugdb/bugs.db` 存在，并检查 `LOCAL_KNOWLEDGE_HOME` 或旧兼容变量 `BUGDB_HOME` 是否覆盖了路径。旧版数据仍在独立目录时运行 `local-knowledge-migrate`。
