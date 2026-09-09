---
name: tgrep-search
description: 使用后台 tgrep 索引搜索工作树文本、定位字符串与候选文件，或诊断 tgrep 安装、索引和服务。符号关系和影响面继续交给 CodeMap，已知文件直接读取。
---

使用 SessionStart 注入的绝对 CLI 路径；没有注入时，从本技能目录解析 `../../scripts/tgrep.cjs`，不要猜安装目录。Node 18+，无需 npm install。

```bash
node "/absolute/plugin/scripts/tgrep.cjs" search -F -n -- "needle" .
node "/absolute/plugin/scripts/tgrep.cjs" search --fresh -n -- "pattern" src
node "/absolute/plugin/scripts/tgrep.cjs" search --files -g "*.cpp" -- .
node "/absolute/plugin/scripts/tgrep.cjs" doctor
```

`--` 后是 pattern/paths，flags 放在它前面并分开写（`-F -n`，不是 `-Fn`）。`-e`/`-f` 已提供 pattern 或 `--files` 时，所有位置参数都是 paths。相对路径按调用目录解析；`--root DIR` 指定服务所属范围，不改变 paths 的含义。非 Git 目录需显式 `--root DIR`，只扫描。

普通查询使用健康服务；pending、服务异常、零命中自动直读磁盘复核。编辑后的关键验证用 `--fresh`，因为 watcher 存在延迟，零命中复核不能补全已有部分命中的结果。默认文件上限 64 MiB；超大文件显式 `--no-max-filesize`，GBK 等内容可用 `-E gbk` 直读，字节精确检索使用 rg。

安装未完成时 wrapper 可用 rg 回退，stderr 会标明引擎；回退并非逐字节等价。未知 flags 会明确失败，不透传。使用 `--help` 查看入口，完整支持选项与生命周期见 [插件说明](../../README.md)。不要将“服务启动”说成“索引完成”，退出码 1 才是本次搜索无匹配，2 是错误。
