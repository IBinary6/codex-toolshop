# tgrep Search for Codex

独立插件 `tgrep-search-codex@codex-toolshop`（0.1.2）。Node.js 18+，无 npm 依赖，无 MCP。插件以 Microsoft tgrep **v1.0.5** 为冷安装 fallback，自动检查并验证上游稳定版，按真实 Git 工作树维护服务与私有索引，用于文本、字符串和候选文件搜索。符号、调用链、依赖和影响面仍由 CodeMap 负责，已知文件直接读取。

## 自动运行

可信 hook 的 `SessionStart`（startup/resume/clear/compact）快速启动隐藏 supervisor，并注入当前安装位置的绝对查询命令。这里的 SessionStart 是**任务启动或恢复事件**，不是打开 Codex 首页。hook 是否允许执行由宿主的信任与启用状态决定；插件不会替用户批准 hook。

`UserPromptSubmit` 与查询入口会触碰服务的空闲计时器，服务停止后按需恢复。自动 hook 只处理 Git 工作树，不向普通目录或用户主目录扩展扫描。Git linked worktree 的 `.git` 文件受支持，每个 canonical root 有独立服务与索引。服务始终以工作树根目录为 cwd；搜索路径保持调用者目录的相对含义。

初次下载和建索引不阻塞 hook。`starting/installing/pending` 不代表索引完成。已有二进制时，pending 查询自动加 `--no-index` 直读磁盘；二进制尚不可用时尝试 rg，stderr 明确标明回退。下载失败记录在 `doctor` 的 lastError；没有 tgrep 或 rg 时退出 2，而不是假报无结果。

## 查询与诊断

使用 hook 注入的绝对路径，或在插件目录运行：

```bash
node scripts/tgrep.cjs search -F -n -- "needle" .
node scripts/tgrep.cjs search --fresh -n -- "pattern" src
node scripts/tgrep.cjs search --files -g "*.cpp" -- .
node scripts/tgrep.cjs search -e "first" -e "second" -- src
node scripts/tgrep.cjs search --root /explicit/directory -F -- "needle" /explicit/directory
node scripts/tgrep.cjs ensure
node scripts/tgrep.cjs doctor
node scripts/tgrep.cjs check-updates
node scripts/tgrep.cjs status
node scripts/tgrep.cjs stop
node scripts/tgrep.cjs --help
```

Windows Git Bash 路径含空格时用单引号引用完整脚本路径。flags 位于 `--` 前并分开写（`-F -n`，不接受 `-Fn`）；`--` 后是 pattern 与 paths。使用 `-e/-f` 或 `--files` 时，位置参数全是 paths。`--root` 指定服务 root，但不改变 paths 的含义；指定 Git 子目录时服务 root 会提升为该工作树根，默认查询范围仍是调用目录。非 Git 目录必须显式 `--root`，只实时扫描，不启动服务。显式指定工作树外 paths 时也直读扫描。Windows 已存在的查询路径会解析短文件名和 junction，使用真实路径判断范围并传给后端，因此输出可能显示真实长路径；缺失或不可读路径仍保留，由后端报告错误。Unix 路径处理保持原有行为。

`ensure` 是手动同步安装诊断入口，成功后请求启动服务，不等于索引 ready。`doctor/status` 输出 JSON，包含实际 root、index、runtime、activeVersion、serviceVersion、updates（最近检查时间、结果和错误）、管理状态与最近安装/服务错误。退出码：0 为匹配或管理成功，1 为无匹配，2 为错误。未知或不可映射的 flags 明确退出 2。

支持的查询参数以 `scripts/tgrep.cjs` 的 `switches/values` 为准，包括：大小写、固定字符串、word/line regexp、反向匹配、文件/计数/JSON 输出、行号、上下文、多 pattern、glob、type、encoding、文件大小、hidden/ignore 和 follow。`--stats` 仅在 tgrep 可用时使用；不会盲目透传到 rg。上游的 `--index-path`、serve/index 与任意 tgrep-only 参数不向 search 透传，避免将查询指向其他索引。

## 一致性与边界

- 默认服务和查询都使用 64 MiB 文件上限、同一 root 与私有 index-path；默认 ignore 策略沿用 tgrep。改变 ignore、大小上限、编码或遍历范围的查询自动直读，不改变运行中索引策略。
- ready 要求当前 supervisor 创建的子进程 discovery PID 一致、TCP status 有效、索引完成且 reconcile 无 pending/overdue/error。恢复已有索引还需首次成功 reconcile。查询后再次核对 manager 身份与状态；失联不能静默使用旧磁盘索引。
- 普通索引零命中（包括空 filename listing）会直读复核。watcher 有传播延迟，**非空结果仍可能不完整**；编辑后关键判断、完整性验证或需要磁盘当前内容时使用 `--fresh`。
- 默认 64 MiB 不是“所有文件”。大文件可用 `--no-max-filesize` 或 `--max-filesize SIZE`；这些查询直读。包装器明确传入默认上限，因此直接指定的大文件也受 64 MiB 限制。
- tgrep 默认 BOM 检测；非 UTF-8 内容可能修复成 U+FFFD。显式 `-E gbk` 等编码走实时扫描；字节精确检索用 rg。rg 的 ignore、二进制扩展名和编码行为与 tgrep 存在差异，回退不承诺逐字节等价。
- 查询最多等待 120 秒、缓冲 stdout 最多 32 MiB；超限明确错误 2，不静默截断。缩小路径、用 `-l/-c/-m` 控制输出。错误 2 保留实际错误，不通过换引擎掩盖语法或权限错误。

## 私有运行时与生命周期

默认数据目录是 `$CODEX_HOME/plugins/data/tgrep-search-codex-codex-toolshop`，未设置 CODEX_HOME 时为 `~/.codex/plugins/data/tgrep-search-codex-codex-toolshop`。宿主 `PLUGIN_DATA` 优先；测试或手动隔离可设置 `TGREP_SEARCH_HOME`，优先级最高。

内部为 `runtime/<version>/<platform-arch>` 与 `worktrees/<canonical-root-sha256>/indexes/<version>`。旧版无 version 字段的存活 manager 仍绑定 1.0.5 和原 `index` 目录。不将 `.tgrep` 写入项目。release.json 保留冷安装版本的官方资产 URL 和 SHA256，支持 Windows/macOS/Linux 的 x64/arm64。先下载、校验 SHA256、只提取所需可执行文件、运行版本检查，再原子发布到独立版本目录；不下载 main、不默认安装 Cargo。安装 receipt 保存二进制 SHA256，后续入口发现损坏会明确报错，按提示移除该 runtime 版本目录后 `ensure`。源码见 [官方固定 release](https://github.com/microsoft/tgrep/releases/tag/v1.0.5)。

下载优先使用宿主 curl（沿用其代理设置），无 curl 时使用 Node fetch；Node 18 fetch 不保证采用 shell 代理变量。Windows 显式使用系统 `System32/tar.exe` 解压 zip，macOS/Linux 使用 tar。下载、安装与服务均有互斥锁；只回收确认死亡的拥有者。不能确认身份的活 PID 不会被杀死，doctor 可用于诊断这种保守阻塞。

supervisor 使用只存在私有 state 的随机令牌认证控制请求；token 不输出到 hook/日志。Windows 子进程均以 `windowsHide: true`、`shell: false` 启动。`stop` 只向验证身份的 supervisor 请求停止，由它关闭自己创建的 ChildProcess，不按磁盘 PID 任意杀进程。

默认最后一次查询或 UserPromptSubmit 后 **30 分钟**空闲回收。停止/禁用插件后如需立即退出，先执行 `stop`；否则已有 supervisor 到期回收。强制结束 supervisor、操作系统崩溃等不属于正常停止路径，可能留下孤立 tgrep 进程；插件不会仅凭旧 PID 杀死无法确认归属的进程，可通过操作系统进程工具核对路径和命令行后人工处理。

可选环境变量（服务启动前设置；改变后 `stop` 再启动）：

| 变量 | 用途 |
| --- | --- |
| `TGREP_IDLE_MS` | 空闲回收毫秒数，最小 5000，默认 1800000 |
| `TGREP_QUERY_TIMEOUT_MS` | 查询超时毫秒数，最小 1000，默认 120000 |
| `TGREP_MAX_CPU` | 上游 serve 的 CPU 百分比，1..100；未设置沿用上游默认 50 |
| `TGREP_MAX_MEMORY_MB` | 上游 serve 的内存预算 MiB，1..1048576；未设置沿用上游按系统内存推导的默认值 |

`TGREP_DISABLE_UPDATES=1` 关闭自动检查，供受控环境与测试使用；显式 `check-updates` 仍按用户命令强制检查。

max-memory 是上游索引预算，不是操作系统强制限制。数据目录可保留用于重用；卸载后的缓存删除由用户明确选择。

## 上游工具每周更新

SessionStart 和查询/ensure 入口在后台按 **7 天（604800000 毫秒）**检查一次 `https://api.github.com/repos/microsoft/tgrep/releases/latest`。无需单独提醒或弹窗；没有会话/查询时不运行独立定时器，到下次使用时检查。频率从最近一次检查尝试计时，失败也不会每次查询重复联网；`check-updates` 可立即强制重试。共享 data 下使用调度锁、检查锁和时间状态，使不同任务去重。

只接受 stable release、本机六种受支持平台对应的官方 `microsoft/tgrep` release 资产及其 `assets[].digest` SHA256。缺少 digest、资产命名/平台不兼容、下载失败、哈希不符或版本不高于当前版本，都不会替换当前 active 版本；错误记录到 doctor，不影响既有搜索。不会把自己算出的哈希当成官方校验依据。

候选二进制在系统临时目录中的独立 fixture 验证版本、CLI、index、serve/status/reconcile、索引搜索、无匹配退出码、文件列表和 `--no-index` fresh 行为。全部通过后才原子发布 `active-release.json`。候选失败可保留其独立安装目录供重试，旧 binary 与 index 不被原位替换或删除。

运行中的服务继续使用启动时版本。查询选择该 manager 声明的版本和同版本索引；旧 manager 没有版本字段时兼容绑定 1.0.5/legacy index。active 更新不会强制重启当前服务；空闲退出或显式 stop 后，下次启动采用新版本及独立索引，因此不会拿新 CLI 读旧服务索引。`doctor` 可同时显示 active 与服务版本。

这项功能更新的是 **tgrep 上游工具**，不是 Codex 插件源码。它不修改 marketplace 或插件缓存。

## 验证

```bash
npm test
npm run test:smoke
npm run test:updates
```

unit 在独立临时目录验证参数边界、路径意义、回退映射、互斥和错误码。smoke 会联网下载固定官方包，校验并实际启动服务；只在 mkdtemp 目录创建 Git 仓库、测试提交和 linked worktree，验证 ready 索引查询、子目录范围、fresh/new-file、停止、空闲回收与工作树隔离。测试不修改用户项目内容。

`test:updates` 在独立 data 安装冷版本、验证真实候选协议，并通过公开 check-updates 命令访问官方 latest；当前 latest 等于冷版本时断言未切换。普通 smoke 设置 TGREP_DISABLE_UPDATES=1，避免检索回归因未来上游发布而漂移；另模拟 active 改变以验证存活服务仍绑定旧版本。
