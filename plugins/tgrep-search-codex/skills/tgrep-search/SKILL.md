---
name: tgrep-search
description: 使用后台 tgrep 索引搜索工作树文本、定位字符串与候选文件，或诊断 tgrep 安装、索引和服务。符号关系和影响面继续交给 CodeMap，已知文件直接读取。
---

使用 SessionStart 或 SubagentStart 注入的绝对 CLI 路径；该入口是 CLI，不是 MCP。没有注入时，从本技能目录解析 `../../scripts/tgrep.cjs`，不要猜安装目录。Node 18+，无需 npm install。

```bash
node "/absolute/plugin/scripts/tgrep.cjs" search -F -n -- "needle" .
node "/absolute/plugin/scripts/tgrep.cjs" search --fresh -n -- "pattern" src
node "/absolute/plugin/scripts/tgrep.cjs" search --files -g "*.cpp" -- .
node "/absolute/plugin/scripts/tgrep.cjs" doctor
```

在目标 workdir 调用 CLI。`--` 后是 pattern/paths，flags 放在它前面并分开写（`-F -n`，不是 `-Fn`）。`-e`/`-f` 已提供 pattern 或 `--files` 时，所有位置参数都是 paths。相对 path 和省略 path 的默认范围按调用目录解析；`--root DIR` 只指定服务或扫描 root，不改变 paths 的含义。非 Git cwd 的 `search` 可不带 `--root`，只扫描已解析 paths，不创建服务或索引，也不从 paths 推断 root；`ensure/status/doctor/stop` 仍需显式 `--root DIR`。

普通查询使用健康服务；pending、服务异常、零命中自动直读磁盘复核。编辑后的关键验证用 `--fresh`，因为 watcher 存在延迟，零命中复核不能补全已有部分命中的结果。默认文件上限 64 MiB；超大文件显式 `--no-max-filesize`，GBK 等内容可用 `-E gbk` 直读，字节精确检索使用 rg。

安装未完成时 wrapper 可用 rg 回退，stderr 会标明引擎；回退并非逐字节等价。未知 flags 会明确失败，不透传。使用 `--help` 查看入口，完整支持选项与生命周期见 [插件说明](../../README.md)。不要将“服务启动”说成“索引完成”，退出码 1 才是本次搜索无匹配，2 是错误。

上游 tgrep 每 7 天在后台检查稳定更新；doctor 的 activeVersion/serviceVersion 可能暂时不同，查询按存活服务版本执行。更新错误不应阻断检索；需要立即重试时运行 `node "/absolute/plugin/scripts/tgrep.cjs" check-updates`。该入口不更新 Codex 插件源码。
