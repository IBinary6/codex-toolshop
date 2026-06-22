# C++ Style Enforcer for Codex

`cpp-style-enforcer-codex` 是一个 Codex 插件，用来把团队 C++ 编码规范自动接入 Codex 工作流。

安装后，Codex 会通过插件 hooks 自动执行 C++ 风格检查和修复，不需要用户手动配置旧式 hook。

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

插件会自动注册 3 类 hook：

| Hook | 触发时机 | 作用 |
| --- | --- | --- |
| `SessionStart` | Codex 会话启动、恢复或清理上下文后 | 准备 C++ 风格配置；不做网络安装。 |
| `PostToolUse` | Codex 写入或编辑文件后 | 对 C/C++ 文件执行格式化、BOM 处理、版权头处理和 cpplint 检查。 |
| `PreToolUse` | Codex 执行 Bash 命令前 | 识别提交相关命令，对暂存区 C/C++ 文件做提交前检查，违规时阻止提交。 |

核心流程继承团队新版 `cpp-style-enforcer` 规范，重点覆盖：

- `clang-format` 格式化
- UTF-8 BOM 规范化
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

hook 运行期只检测依赖，不执行 `npm install` 或 `pip install`。如需补齐可选依赖，请在常规终端中预先安装，例如：

```bash
python -m pip install clang-format==18.1.8
npm install iconv-lite@0.6.3
```

hook 默认保持安静，只在需要阻止操作或提示关键问题时输出 Codex hook 决策。

## 行尾策略

`cpplint` 不负责统一 LF/CRLF，本插件也不会因为运行 cpplint 改写行尾。CRLF 文件会按原字节检查并保持 CRLF；带 UTF-8 BOM 的文件仅在 cpplint 执行期间临时剥 BOM，结束后恢复原始 BOM 与行尾。

行尾统一应交给 Git 属性、项目规范、`clang-format` 或版权头步骤处理，不通过屏蔽 `whitespace/newline` 来规避；该类别仍用于真正的换行风格违规。
