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
| `SessionStart` | Codex 会话启动、恢复或清理上下文后 | 准备 C++ 风格配置和必要运行环境。 |
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
.claude-cpp-style/cpp-style.json
```

保留 `.claude-cpp-style` 是为了兼容团队已有项目配置，不需要迁移旧项目。

## 运行态数据

插件运行时的可写数据优先使用 Codex 提供的环境变量：

```text
CLAUDE_PLUGIN_DATA
```

如果宿主没有提供该环境变量，插件会回退到用户级 Codex 插件数据目录。插件安装目录本身按只读、可替换包处理。

## 依赖

- Node.js 18+
- Python 3，用于运行内置 `cpplint.py`
- `clang-format` 可选；缺失时插件会尽量安全降级或尝试准备可用工具

hook 默认保持安静，只在需要阻止操作或提示关键问题时输出 Codex hook 决策。

