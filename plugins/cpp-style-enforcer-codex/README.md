# C++ Style Enforcer for Codex

`cpp-style-enforcer-codex` 是一个 Codex 插件，用来把团队 C++ 编码规范自动接入 Codex 工作流。

安装后，Codex 会通过插件 hooks 自动执行 C++ 风格检查和修复，不需要用户手动配置旧式 hook。

## 与 Claude Code 版的语义对应

插件兼容团队已有配置：新文件/新项目走全套，老文件按 `legacyChecks` 选择格式化和 lint；提交前 cpplint 检查暂存区快照且不改写工作区。Codex 版额外提供独立行尾修复：**Visual Studio 源工程强制 CRLF，其他工程按配置处理；缺少末尾换行自动补齐，不通过过滤器规避**。

| 语义能力 | Codex 版 | Claude Code 版 |
| --- | --- | --- |
| 编辑后处理 | `PostToolUse` 记录触碰文件，`Stop` 批量处理 | `PostToolUse` 串行处理本次编辑文件 |
| 提交前检查 | 识别真正的 `git commit`，只检查暂存区 C++ 文件 | 同样识别 `git commit` 并检查暂存区 |
| 新老文件策略 | `.codex-cpp-style/cpp-style.json`，兼容 `.claude-cpp-style` | `.claude-cpp-style/cpp-style.json` + 全局模板 |
| cpplint 行尾 | lint 前按项目规则统一行尾并补末尾换行；不屏蔽换行检查 | 原有保持 LF/CRLF 的行为 |
| 依赖安装 | 运行期只检测，不自动 `pip/npm install` | 运行期只检测，不自动 `pip/npm install` |

旧配置继续兼容；上述 Codex 行尾处理不代表已修改或发布 Claude Code 版。

## 安装

1. 添加插件市场：

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

2. 安装当前插件：

```bash
codex plugin add cpp-style-enforcer-codex@codex-toolshop
```

3. 重新打开一个 Codex 会话，让插件 hooks 和 skill 生效。

## 它会做什么

插件会自动注册 4 类 hook：

| Hook | 触发时机 | 作用 |
| --- | --- | --- |
| `SessionStart` | Codex 会话启动、恢复或清理上下文后 | 准备缺失的用户模板；不写项目文件，不做网络安装。 |
| `PostToolUse` | Codex 写入或编辑文件后 | 只把本轮编辑的 C/C++ 文件记录到插件数据目录，不读取或改写源文件。 |
| `Stop` | Codex 准备结束当前轮次时 | 对本轮编辑文件统一执行格式化、BOM、版权头、项目行尾修复和 cpplint；发生改写或仍有违规时让 Codex 继续完成最终验证。 |
| `PreToolUse` | Codex 执行 Bash 命令前 | 识别真正的 `git commit`，只检查暂存区 C/C++ 文件，违规时阻止提交，不在提交前改写文件。 |

核心流程继承团队新版 `cpp-style-enforcer` 规范，重点覆盖：

- `clang-format` 格式化
- 新文件 UTF-8 BOM 规范化；已跟踪文件保持原 BOM 状态
- 版权头插入或更新
- 内置 `cpplint.py` 检查
- 提交前暂存区检查

## 配置

全局模板默认写入：

```text
~/.codex/cpp-style-template.json
```

项目级覆盖配置放在项目根目录下：

```text
.codex-cpp-style/cpp-style.json
```

插件优先读取 `.codex-cpp-style`，同时兼容团队已有的 `.claude-cpp-style` 配置，不需要迁移旧项目。

## 运行态数据

插件运行时的可写数据优先使用 Codex 提供的环境变量：

```text
PLUGIN_DATA
```

如果宿主没有提供该环境变量，插件会回退到用户级 Codex 插件数据目录。插件安装目录本身按只读、可替换包处理。

## 依赖

- Node.js 18+
- Python 3，用于运行内置 `cpplint.py`
- `clang-format` 可选；缺失时格式化步骤静默跳过，其他检查继续
- `iconv-lite` 可选；缺失时 GBK 文件会跳过转码/BOM 处理，避免损坏原文件

hook 运行期只检测依赖，不执行 `npm install` 或 `pip install`。Python 启动器会验证解释器确实为 Python 3；Windows 同时支持标准的 `py -3` 启动方式。

macOS 可在常规终端中执行：

```bash
python3 -m pip install clang-format==18.1.8
```

Windows 可在常规终端中执行：

```text
py -3 -m pip install clang-format==18.1.8
```

`iconv-lite` 必须由插件包或 Codex 注入的插件数据目录提供；不要在任意工作目录执行 `npm install`，否则 hook 无法解析该依赖。缺失时 GBK 转码/BOM 处理会安全跳过。

hook 默认保持安静，只在需要阻止操作或提示关键问题时输出 Codex hook 决策。

## 延迟检查策略

编辑阶段不会立即运行 `clang-format` 或改写 BOM，因此不会在 Codex 连续修改代码时制造中间 diff。每轮编辑完成后，`Stop` 才统一处理本轮触碰的 C/C++ 文件；如果自动规范化改变了文件或 cpplint 仍有违规，Hook 会要求 Codex 检查最终 diff、修复问题并重新验证。为避免无限续跑，已经由 Stop 自动续跑过的轮次只显示剩余问题，不再次强制续跑。提交前 Hook 始终采用只检查、不修改的策略。

`PostToolUse` 全程静默，只记录路径，不向模型上下文注入内容；没有改写和违规时，`Stop` 也静默结束。自动改写报告最多显示 10 个文件路径，其余只显示数量，避免大批量修改时无界占用上下文。

项目配置只在实际编辑后按需生成。新旧文件都优先采用已有 `.clang-format` / `_clang-format`，包括父目录继承的配置；Google 只作缺省风格。cpplint 对 BOM 文件也完全只读，缺少运行时、异常退出或检查不完整时不能当作验证通过。

VS 源工程的新文件和所有已跟踪文件都保留 include 顺序，避免把 `windows.h` 移到依赖其类型或宏的头文件后面；其他工程的新文件仍遵循项目排序配置。已有局部 `clang-format off/on` 保护应保留。VS 的 Stop 和提交检查同步禁用 cpplint 的 `build/include_order`，其余检查继续执行。

自动编辑处理、Stop 和提交检查均排除第三方目录，直接调用插件 cpplint 封装也会排除：`3rd`、`3rdparty`、`3rd_party`、`3rd-party`、`thirdparty`、`third_party`、`third-party`、`thirdpart`、`third_part`、`third-part`、`thridpart`、`thridparty`、`thrid_party`、`thrid-party`、`vendor`、`external`、`deps`、`packages`。匹配完整目录段且不区分大小写，不会因 `third_party_adapter` 等业务名称包含子串就排除。上述目录不会被自动补 BOM、换行、版权、格式化或 lint。未列出的自定义目录名需明确识别为第三方后再决定操作范围；手动运行原始 Python cpplint 时也须先筛选文件，原始 CLI 不带此目录过滤。

## 行尾策略

`Stop` 在格式化、BOM、版权头之后、cpplint 之前执行独立的行尾修复。Visual Studio 源工程的本轮编辑文件强制 CRLF，即使它之前已被改成 LF；其他工程通过全局模板或项目配置的 `lineEnding` 选择 `"lf"`、`"crlf"` 或 `"preserve"`（默认）。`preserve` 保留原正文占多数的行尾，数量相同时按首个行尾，无行尾时采用 LF；混合行尾统一到选定风格。

项目识别只沿源文件祖先目录查找最近的项目标志：`.vcxproj`、`.vcproj`、`.sln`、`.slnx` 表示 VS 源工程；最近的 `CMakeLists.txt` 表示 CMake 源工程。CMake 生成目录中的 VS 文件不会作为原生 VS 标志，也不会扫描旁支 build 目录。两种构建入口在同一目录时按 CMake 处理，可用项目 `lineEnding: "crlf"` 明确需要的行尾；项目标志位于祖先之外时同样可以显式配置。

例如 CMake 工程需要 LF，可以配置：

```json
{ "lineEnding": "lf" }
```

非空正文缺少末尾换行时只补一个同种换行，不增加额外空白行、不移除已有末尾空行。基础行尾规则也适用于关闭 `legacyChecks` 的已编辑旧文件，不依赖 clang-format 是否安装；`enabled: false` 仍关闭全部处理。修复只涉及本轮编辑文件，不启动全仓转换。

独立行尾步骤按字节保留 UTF-8、GBK 和带 BOM 的 UTF-16 编码与 BOM；未识别的含 NUL 内容不冒险转码。已有 BOM 策略保持不变，已跟踪文件不强制增删 BOM。

提交前检查读取 Git 暂存区 blob，并在临时目录中按仓库相对路径运行 cpplint；项目中的 `CPPLINT.cfg` 同样取自暂存区。这样即使 Visual Studio 工作区使用 CRLF、Git 暂存区因 `core.autocrlf` 使用 LF，或者暂存后工作区又有未暂存修改，检查结果仍与实际提交内容一致，工作区文件不会被临时改写。

不屏蔽 `whitespace/ending_newline` 或整个 `whitespace/newline`。内置 cpplint 接受纯 LF 和纯 CRLF，混合行尾提示遵循项目规则，不再建议统一转成 LF；`whitespace/newline` 中其他代码布局检查仍有效。如果缺末尾换行的版本已经暂存，工作区自动修复不会改变 index，需按原暂存范围更新后再检查，保留未暂存修改。
