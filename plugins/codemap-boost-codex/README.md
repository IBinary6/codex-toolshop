# CodeMap Boost for Codex

`codemap-boost-codex` 自带 `code-review-graph` 和 Serena 两个原生 MCP：代码图负责结构定位与影响面，Serena 通过语言服务补充符号定义、实现和引用。

插件本身不会读取或修改旧宿主目录。Codex 持久提示写入 `$CODEX_HOME/AGENTS.md`，运行数据写入 Codex 插件数据目录。

## 与 Claude Code 版的语义对应

两边追求同一条用户语义：**结构类问题优先用图谱，读取图谱前保证刷新完成**。Codex 从 0.1.36 起把重运行时和刷新延后到实际使用。

| 语义能力 | Codex 版 | Claude Code 版 |
| --- | --- | --- |
| 会话启动维护图谱 | 轻量 Node MCP 提供发现；`SessionStart` 只维护指导和兼容配置 | `SessionStart` 后台 build/update，缺 CLI 时提示 setup |
| 修改后更新图谱 | 延后到下次图读取，使用源码及数据库指纹检查新鲜度 | `PostToolUse` / `CwdChanged` 后台刷新 |
| 读取前屏障 | 图谱 MCP `PreToolUse` 同步刷新，失败则 deny | 图谱 MCP `PreToolUse` 同步刷新，失败则 deny |
| 检索引导 | AGENTS、SessionStart、结构请求与子代理入口使用同一份工具发现与证据分工规则；非 Git 会话也只获得这份轻量指导 | `Grep` / `Agent` 强提示优先用图谱 |
| 依赖安装 | 首次实际使用自动准备精确版本私有运行时 | 通过 `/codemap-boost-setup` 显式确认安装 |

CodeMap 的常驻规则由托管 `AGENTS.md` 块与入口注入共用同一份三点文案：工具与目标、文本与回退、证据与刷新。安装、运行时和 hook 的按需技术细节见下文；图工具验证与文本检索降级见 [setup skill 的 Verification](skills/codemap-boost-setup/SKILL.md#verification)。

CodeMap 可独立安装，不依赖个人技能。工具按问题相互配合：

1. **分别发现**：在当前工具目录和延迟发现入口中分别确认 CRG 与 Serena。CRG 显式使用目标 Git 工作树的 `repo_root`；Serena 先激活目标项目的绝对路径。会话或 MCP 启动器的 `cwd` 都不能代替目标根目录。
2. **按入口回退**：已知文件直接读；文本和文件枚举通过 `tgrep-search-codex` 的实际 CLI 入口核验，并以目标目录为工作目录，未就绪时用 `rg`。工具缺失只是当前时点的结果；当前立即回退，下一轮或后续自然需要时再发现，不忙等或保留永久负缓存。
3. **按证据互补**：CRG 查关系和影响面，Serena/LSP 查精确符号，tgrep/rg 查文本。只补足当前缺少的证据，证据充分即停，不强制每次调用三套工具。

## 内置 Serena：安静启动与项目边界

从 0.1.31 起，插件安装后由原生 MCP 自动准备 Serena，初始兼容基线为 `serena-agent==1.7.0`，后续按周自动检查更新，无需另写 `uvx` 配置。Serena 和 CRG 使用各自的私有 venv。稳定用户配置位于 `<plugin-data>/serena-home`；每个 MCP 连接使用独立的私有会话配置，语言服务可执行文件仍复用稳定目录，运行时使用独立版本目录。

每次启动都显式传入以下参数，即使配置文件曾启用界面，也保持无界面启动：

```text
start-mcp-server --context codex
--enable-web-dashboard false
--open-web-dashboard false
--enable-gui-log-window false
```

三个选项分别关闭 Dashboard 服务、浏览器自动打开和 GUI 日志窗口。末尾单独写一个 `false` 会被上游解析成项目名，不能用来关闭界面。[官方启动参数](https://github.com/oraios/serena/blob/v1.7.0/src/serena/cli.py)

MCP 的工作目录用于定位插件脚本，所以启动器不使用 `--project-from-cwd`，也不把插件仓库自动激活为用户项目。模型首次使用语义工具前，通过 Serena `activate_project` 激活当前目标的绝对根目录，切换项目后重新确认。已有项目的 `.serena/project.yml` 仍会生效；插件不重写项目配置，也不修改 CC Switch 或其他管理器登记的 Serena。已有另一套 Serena 时选一个实例使用；是否禁用旧实例由用户在对应宿主管理。

封装支持 Windows、macOS 和 Linux。Serena 1.7.0 要求 Python 3.11–3.14；包安装成功与语言服务可用是两项检查。语言服务可能在首次激活时下载依赖；例如 C/C++ 使用 clangd，跨文件分析通常需要项目提供 `compile_commands.json`。具体平台和依赖以 [官方语言支持说明](https://oraios.github.io/serena/01-about/020_programming-languages.html) 为准。语言服务不可用时继续使用图、源码和文本证据。

从 0.1.39 起，Serena 前端在激活 C/C++ 工程和读取其语义结果前准备编译参数。优先使用工程根目录的有效 `compile_commands.json`，其次使用明确选择的数据库或 `build/` 内唯一有效数据库；相对目录会在私有副本中规范化。Windows 的单个 `.vcxproj` 工程没有数据库时，通过实际 Visual Studio 的 MSBuild Evaluation API 提取选定配置、工具集、SDK、逐文件宏、包含目录、强制包含及语言标准，默认优先选择 Release 和宿主对应架构。只求值，不执行 Build、Target、Task 或自定义构建。生成文件位于 `<plugin-data>/serena-build/<工程标识>/<参数版本>/`，不改项目源码、构建配置或系统 clangd 配置。

编译数据库路径在 Windows、macOS 和 Linux 上使用相同的准备流程；MSBuild 是仅在 Windows 上调用的适配器。macOS/Linux 工程可使用构建系统已有的数据库或通过私有配置选择数据库目录。没有有效数据库时会明确报告参数准备受限，保留原生 Serena 与图谱、文本检索的可用能力，不猜测某个 Windows 工具链。连接数据和资源目录按真实路径隔离，兼容符号链接目录。

多个项目或数据库存在歧义时，在对应 `<plugin-data>/serena-build/<工程标识>/config.json` 中填写 `project`、`configuration`、`platform` 或 `databaseDir`；路径相对实际工程根目录。根目录已有的有效数据库仍优先。缺少工具链、参数无法可靠转换或用户已有 C++ language server 自定义配置接管时，结果会明确报告限制，保留原生能力，不宣称引用完整。其他语言继续使用原生 Serena 配置。

构建配置、导入文件或编译数据库变化时，前端等待原生请求和回调结束，再停止自己拥有的后端并以新参数恢复；同一连接切换工程也重新确认实际路径。缓存同时跟踪可选导入文件的存在状态和通配符成员变化；只修改现有源码内容不使构建输入缓存失效。无法完整跟踪的动态构建表达式会保守重新求值，不声称参数仍然有效。参数版本进入语言服务缓存标识，防止源码没变、宏变了却复用旧符号。工具发现仍来自实际 Serena 后端；工程准备成功不等于语言服务或引用查询已经通过，验收仍需真实查询。

自动管理的 clangd 默认使用两个异步工作线程（`-j=2`），后台索引继续启用，减少 Windows 工程并行解析头文件时的内存峰值。已有稳定私有配置 `serena-home/serena_config.yml` 的 `ls_specific_settings.cpp.ls_extra_args` 可显式设置 `-j=4` 等参数；用户设置优先。它限制并发数，不限制引用结果数量。升级候选同时检查前端的真实 clone、resolve 和 apply 配置流程，失败保留当前运行时。

仓库 CI 对 Windows、macOS、Linux 运行插件校验、研究工具测试、tgrep 原生生命周期、Serena 原生烟测及 CRG 兼容性测试。Serena 烟测使用临时 TypeScript/C++ 工程，检查跨文件引用、编译参数变化后的符号刷新和连接退出。CI 配置存在不等于对应平台已经通过；发布验收需查看实际运行结果，本机结果按实际操作系统单独报告。

只读诊断命令为 `node "<plugin-root>/scripts/serena-server.cjs" --doctor`；完整运行时验证使用插件目录下的 `npm run test:serena-smoke`，覆盖隔离安装、MCP 握手、无界面启动、临时项目激活和真实符号查询。正常使用不需要执行这些诊断命令。

## 每周自动更新

工具运行时与插件源码分别更新，安装成功不会永久跳过上游版本检查：

- **CRG 与 Serena**：CRG 在首次实际使用后调度自己的更新，Serena 启动仅调度 Serena 更新。所有任务共用 7 天检查间隔与安装锁。候选版本安装到独立目录，CRG 通过 parser、刷新适配器及真实 MCP 元数据导出检查，Serena 通过 MCP/CLI 契约及关闭界面验证后，才更新版本指针；后续启动使用新版。
- **tgrep**：由独立 `tgrep-search-codex` 插件负责按周检查 GitHub 官方 release、校验发布资产并验证搜索服务。CodeMap 不重复启动 tgrep 更新流程。
- **插件源码**：已从官方 `codex-toolshop` Git marketplace 安装的 CodeMap，在实际图读取后按周调用 Codex 原生 marketplace 更新入口，并检查已启用插件的缓存版本。此流程覆盖该市场的已安装插件，不安装未安装的插件，不主动启用已禁用的插件，不更新其他市场。源码目录中的开发测试不会触发用户插件升级。

运行时更新不替换正在使用的 venv，也不删除旧版；网络、安装或兼容性验证失败时继续使用旧版，并记录检查时间和错误。现有 MCP 不在任务中途重启；插件源码更新也需要后续新任务加载。如果 Codex CLI 缺失、缓存被占用或原生更新失败，记录诊断并保留现有缓存，不强行终止进程或删除锁定目录。

MCP 启动器定位脚本后，会切换到插件数据目录运行，子进程也使用该目录，避免 Windows 因常驻进程的工作目录位于插件缓存而阻止更新备份。数据目录不代表目标项目，图查询仍须传入真实 `repo_root`，Serena 仍须激活目标项目。升级前已启动的旧进程不会自动改变工作目录；若仍报缓存占用，应在当前任务完成后正常退出并重新打开 Codex。

这是“使用时触发、每 7 天至多自动检查一次”，不是电脑关闭时仍运行的定时任务。没有版本变化时不会重装。需要主动检查或查看状态时，在插件目录运行：

```bash
node scripts/runtime-update.cjs --doctor
node scripts/runtime-update.cjs --check-now
node scripts/plugin-update.cjs --doctor
node scripts/plugin-update.cjs --check-now
```

`--doctor` 只读；`--check-now` 显式执行一次检查。受控环境可用 `CODEMAP_BOOST_DISABLE_RUNTIME_UPDATES=1` 固定工具版本，用 `CODEX_TOOLSHOP_DISABLE_PLUGIN_UPDATES=1` 关闭插件源码自动刷新。禁用更新不妨碍首次准备缺失的基本运行时。

## 安装即用

前置环境要求：

- Codex 桌面宿主必须能直接从自己的 `PATH` 解析 `node`。插件不会硬编码 Homebrew、nvm 或 Windows 安装目录；终端里可用不代表桌面宿主一定继承了同一份 `PATH`。
- Node.js 版本必须为 18 或更高版本，并且需要可用的 Git。
- 独立 `codex` CLI 仅用于旧版全局 MCP 覆盖迁移与 doctor 的可选检查，不是插件原生 MCP 启动的前提。
- 依赖安装器推荐使用 `uv`，插件会用它创建固定 Python 3.12 的私有 venv；无 `uv` 时使用支持 `venv` 的 Python，依次尝试 3.12、3.11 和当前 Python。

不要求用户预先安装 `code-review-graph` 或 Serena，也不要求安装后再运行 setup。正常安装只有两条命令：

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

```bash
codex plugin add codemap-boost-codex@codex-toolshop
```

安装后创建一个新的 Codex 任务。插件自带的 `.mcp.json` 会在任务加载 MCP 时启动两个跨平台 Node 入口。CRG 入口立即提供工具与提示模板发现，首次实际请求才准备并启动 Python 后端；Serena 仍准备自己的隔离 venv 并启动 stdio 服务。工具发现不依赖 SessionStart 事后注册 MCP，主代理和自动子代理能在同一新任务中发现工具。

插件原生 MCP 设置 `startup_timeout_sec = 600`，CRG 另设置 `tool_timeout_sec = 600`，容纳首次请求中的冷启动。准备运行时仍采用 570 秒共享绝对预算，安装锁等待、venv 创建、依赖安装与健康探针都只使用剩余时间。图读取前 hook 的安装和索引刷新也共用 570 秒预算。单条安装命令以 5 分钟为上限，等待安装锁以 9 分钟为上限；多个任务通过安装锁串行准备同一 venv。

### CRG 按需启动

`initialize`、`ping`、工具、提示模板和资源列表由轻量 Node 前端提供，不启动 `serve` 或语义模型。内置发现快照由真实 CRG 2.3.9 导出；没有运行时的首次使用安装同一精确版本。已有运行时使用匹配版本的缓存或快照，未知版本仅通过短暂的 Python 元数据导出生成发现信息；导出明确禁止导入 Torch、Transformers 和 SentenceTransformer。候选升级先导出并校验发现信息，再提升活动版本。每个 MCP 连接冻结运行时选择，避免发现后切换执行版本。

首次工具调用、获取提示模板或其他需要后端的请求会启动原始 `code-review-graph serve`。Windows 保留上游主线程模型预热，避免工作线程首次加载 Torch/DLL/OpenMP 的已知挂起风险。首次普通结构查询也会承担这次初始化；该阶段不拆分结构图谱和语义模型。从 0.1.37 开始，最后一项后端工作完成后空闲 10 分钟，回收自有重型后端的进程树，保留轻量 MCP 前端与磁盘图谱。准备、启动、请求和回调等待期间不回收；已转发的取消请求仍等后端响应或退出，未确认结束时保守保持忙态。发现与 ping 不延长空闲时间。回收期间的新请求等待清理完成，再共享一次重新握手与 Windows 预热；日志级别会重放。连接结束、stdin EOF 或终止信号也会清理后端进程树。

`SessionStart` 和修改后的 `PostToolUse` 不探测、安装、构建或后台刷新 CRG。实际读取前仍校验真实 Git 工作树，准备运行时并刷新索引；未跟踪源码通过临时 Git index 进入图谱，保持用户真实 index 不变。不同 worktree 分别维护自己的图谱。

真实功能与 Windows 内存对比使用 `npm run test:crg-smoke -- --data-dir <private-data-dir> --output <report.json>`。它在临时仓库验证发现阶段无重后端、首次图查询、Windows 模型加载、五个提示模板、编辑与未跟踪源码、worktree 隔离、真实向量搜索、并发复用和 EOF 清理。`--plugin-root <old-plugin> --baseline --discovery-only` 可测旧版启动基线；报告中的工作集包含共享页面，不能直接作为净物理内存节省值。

回收验收使用 `npm run test:crg-idle -- --data-dir <private-data-dir> --output <report.json>`，默认等待完整 10 分钟，再验证图谱、向量搜索、并发恢复与 EOF 清理，比较同一后端进程树的工作集和 Private Bytes。`--plugin-root <installed-plugin>` 可指向 Codex 实际安装目录。`--idle-ms 5000` 仅用于显式加速烟测，不改变生产默认值，也不能替代完整 10 分钟验证；生产没有环境变量覆盖此间隔。

可以用下面的命令验证 Codex 已解析插件原生 MCP：

```bash
codex mcp get code-review-graph --json
```

正常结果是 stdio、`command = node`、参数为 `scripts/mcp-server.cjs`、`cwd` 位于已安装插件根目录，并显示 `startup_timeout_sec = 600`。这个 `cwd` 只负责稳定定位插件启动脚本；图查询前的 `PreToolUse` 会把当前任务的 Git 根目录补入 CRG 的 `repo_root`，避免误查插件目录。新安装或升级后，建议新建 Codex 任务可靠加载插件能力；当前任务尚未确认工具可用时，先按回退路径工作，并在后续自然需要时重新发现。

MCP 工具可能以 deferred 方式注入，因此不会出现在静态 schema 或顶层工具列表中。仅因当前顶层列表没有 `mcp__code_review_graph__` 不能断言 MCP 未加载；声称不可用前，应在可用时检查 `ALL_TOOLS` 中的 `mcp__code_review_graph__*`，或实际调用合适的图工具，确认后再使用降级检索，也不要声称未执行的图查询已经完成。

## 自动启用

原生 MCP 启动器是默认安装路径：它解析与 Codex hooks 相同的 marketplace-qualified 插件数据目录，在首次实际使用时维护私有运行时。`SessionStart` 负责 `$CODEX_HOME/AGENTS.md` 托管块和旧版插件全局 MCP 覆盖迁移，当前 Git 仓库的 build/update 延后到图读取屏障。

从旧版本升级时，如果 `config.toml` 中还存在插件以前创建的私有运行时绝对路径注册，它会比插件原生 MCP 优先。SessionStart 会逐个验证 PATH 中的 Codex CLI 候选，跳过存在但不能执行的桌面应用入口，再根据插件数据目录路径证明归属后移除旧注册；不会删除无关的用户配置。发生迁移后，新建一个任务即可，不需要手工 setup。独立 Codex CLI 不可用时无法检查这项旧版覆盖，但新安装的插件原生 MCP 启动本身不依赖 CLI。旧式 `uvx code-review-graph serve` 无法仅凭命令判断是插件还是用户创建，因此不会自动删除；`--doctor` 会把这类同名覆盖明确列出，交由用户确认。

## setup 与 doctor 后补选项

`codemap-boost-setup` 保留为修复、诊断和显式预热入口，不属于正常安装步骤。需要时可以在 Codex 中输入：

```text
使用 codemap-boost-setup 帮我配置 CodeMap Boost
```

setup 会执行这些动作：

- 在插件数据目录维护独立 CRG venv：初始目录为 `crg-runtime`，按周更新验证通过的版本位于 `crg-runtimes/<version>`。以 doctor 返回的实际路径为准，不读取用户级 site-packages，也不修改用户 PATH。
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

- 刷新适配器与当前 CRG 的接口及解析器兼容性；`CRG status` 成功仅表示数据库状态可读取，不代表刷新校验能执行。适配器探针不会打开或修改用户图数据库。
- 图工具屏障会区分刷新锁等待超时与刷新执行失败；执行失败会附上有限长度的底层错误，不能仅靠等待消除的故障不再统一提示等待后台刷新。

- 当前 Node.js 版本是否满足 `>=18.0.0`；这项检查基于实际启动 doctor 的 Node，不猜测 Homebrew、nvm 或其他安装位置。
- 可执行的独立 Codex CLI 路径、版本、`CODEX_HOME` 和插件数据目录；CLI 不可用时标记为 `WARN`，不把可选检查误报成插件损坏。
- 插件私有 CRG 运行环境及 parser 健康状态。
- 插件原生 MCP 声明、600 秒启动超时，以及是否存在会遮蔽它的同名全局配置。
- 当前目录对应的 Git 仓库和项目图谱 `status`。
- 当前任务工具状态为 `UNKNOWN`：外部 CLI 无法读取已启动任务的工具快照；MCP 也可能 deferred，不能仅凭静态/顶层列表判断，需在新任务中按可用性检查 `ALL_TOOLS` 或实际调用 `mcp__code_review_graph__*`。
- 可直接执行的修复命令，以及修复后是否必须完整重启并创建新任务。

诊断结果为 `READY` 时退出码为 `0`；需要修复或构建时退出码为 `1`。`--doctor` 不能与 `--build`、`--with-graphify` 或 `--skip-install` 一起使用，以保证只读。

setup 脚本应以目标项目作为工作目录运行；这样 `.gitignore` 和初始图谱都会落在当前项目，而不是插件仓库。

正常安装和日常使用都不需要运行 setup。图谱的 build/update 在实际图读取前完成；SessionStart 和修改后的 PostToolUse 保持轻量。

setup 内部执行的等价流程如下，仅用于排障；正常安装不要手动执行，更不要使用 `pip install --user`：

```bash
uv venv --python 3.12 "<plugin-data>/crg-runtime"
uv pip install --python "<plugin-data>/crg-runtime/<python>" --upgrade "code-review-graph[all]"

# 没有 uv 时，macOS 使用 python3：
python3 -m venv "<plugin-data>/crg-runtime"
"<plugin-data>/crg-runtime/<python>" -m pip install --upgrade "code-review-graph[all]"

# Windows 使用 Python Launcher：
py -3 -m venv "<plugin-data>/crg-runtime"
"<plugin-data>\crg-runtime\Scripts\python.exe" -m pip install --upgrade "code-review-graph[all]"
```

`graphify` 是可选能力；需要时再安装：

```bash
# macOS
python3 -m pip install "graphifyy[all]"

# Windows
py -3 -m pip install "graphifyy[all]"
```

## 它会做什么

插件原生 MCP 在首次实际使用时准备私有 CRG 运行环境；6 类 Codex hook 负责指导和图读取前的同步准备。首次准备失败时返回具体诊断，后续实际请求可以重试；显式 setup 保留修复入口。显式禁用时 hook 保持静默。

| Hook | 作用 |
| --- | --- |
| `SessionStart` | 注入共享的轻量检索指导。Git 会话维护旧版全局 MCP 覆盖、托管指导和忽略规则；不探测、安装或刷新 CRG。 |
| `PostToolUse` | 接收修改事件并静默返回；源码变化和 worktree 创建延后到下一次实际图读取验证。 |
| `PreToolUse:MCP` | 调用 code-review-graph 项目图工具前同步准备运行时并刷新或验证图谱；准备失败时阻止该读取并提供诊断。全局仓库注册表查询不依赖当前项目图。 |
| `PreToolUse:Bash` | 常见源码搜索前补充一句条件式图优先提醒；同一用户轮内原子去重，不阻断/改写命令，不刷新图谱。tgrep 的命令注入与提醒由 `tgrep-search-codex` 独立管理，CodeMap 不重复注入。明确的文件名、文档、配置和日志检索静默。 |
| `UserPromptSubmit` | 结构问题注入同一份指导；非 Git 会话不写提醒状态，Git 会话的实际图查询仍由 MCP 屏障保证刷新。 |
| `SubagentStart` | 子代理启动时只注入同一份指导，不探测运行时或重复 build/update；真实 Git 图读取仍由 `PreToolUse:MCP` 屏障同步兜底。 |

完整重建会先清除所有 file-backed 图记录，再重新解析当前源码；这个步骤会按数据库中的原始路径清理旧 Windows 分隔符别名、已删除文件的节点及其引用边，也会清理关联 embeddings，但保留图的 metadata 与 provenance。Python proof 使用 v2 标记并绑定实际 CRG 包身份及业务表的 schema/内容摘要；JS 快路径使用 v4 marker，绑定源码、选中 runtime 路径和 `graph.db`/非空 WAL 的轻量 stat 签名。源码和运行时未变而数据库 stamp 变化时，读取屏障会在 SQLite 一致性事务内核对既有结构 proof，显式生成 embeddings 后的正常读取保留向量；节点、边、派生表或其他业务结构失配仍完整修复。结构摘要覆盖 FTS 及 shadow 表，排除 embeddings、SQLite 内部对象、proof 自身和允许单独推进的 Git SHA/分支元数据；核对失败仍会撤销可信标记，不能把残留图当作最新状态。

搜索提醒按宿主的会话、轮次、会话目录及可选子代理标识隔离；每次用户补充消息都复位，即使仍在同一轮。状态仅在插件数据目录 `search-reminders/` 中保存散列文件名和空标记，不记录用户正文、命令或原始路径。缺少标识或状态不可写时使用无状态软提示，无法保证去重。命令识别是轻量启发式，不能据此判断实际工作目录、用户意图或权限。

Codex 将 `exec_command`（含 Code Mode 内层调用）映射成 `Bash` 与 `tool_input.command`；不需要解析外层 JavaScript。提示后命令仍可执行；自动流程的验证应同时检查入口输出、提示频率和真实图查询，不能只看 Hook 退出码。

## 与 Agent Dispatch 协作

两者同时安装时，Agent Dispatch 提供可覆盖的角色预设，主代理按任务、用户偏好和宿主可用模型决定是否委派；CodeMap Boost 负责图刷新、读取屏障和检索规则。子代理启动时不重复刷新，实际图谱读取由同步屏障兜底。

例如“查 auth 模块被谁依赖”先做图查询，范围较大且分派有收益时再由 Dispatch 建议搜索角色；“只读诊断崩溃”保持只读；“按已有计划实现迁移”沿用方案。角色建议不改变 CodeMap 的检索优先级，也不把查询自动升级为修改任务。

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
- `CODEMAP_BOOST_DISABLE_BOOTSTRAP=1` 控制保留的显式后台自愈入口；正常 SessionStart 不再调用该入口。设置 `CODEMAP_BOOST_DISABLE_GRAPH=1` 可完全关闭图谱行为。
