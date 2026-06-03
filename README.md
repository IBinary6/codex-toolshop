# Codex Toolshop

`codex-toolshop` 是一个 Codex 插件市场仓库，用来集中维护可复用的 Codex 插件。

## 添加插件市场

复制下面命令即可把这个市场添加到 Codex：

```bash
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
```

添加完成后，就可以从 `codex-toolshop` 市场安装其中的插件。

## 当前插件

当前共有 2 个插件：

| 插件 | 用途 | 安装说明 |
| --- | --- | --- |
| `cpp-style-enforcer-codex` | 为 Codex 自动接入团队 C++ 编码规范工作流，包括格式化、版权头、BOM、cpplint 与提交前检查。 | [查看插件 README](plugins/cpp-style-enforcer-codex/README.md) |
| `codemap-boost-codex` | 为 Codex 自动接入 code-review-graph 代码结构图工作流，包括 AGENTS.md 托管提示、图谱更新和结构搜索提醒。 | [查看插件 README](plugins/codemap-boost-codex/README.md) |
