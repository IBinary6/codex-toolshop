# Dbg

用同一个 `doctor` 自动发现、下载、部署、检查更新及修复调试工具扩展与 MCP。安装判断全部由 Node/Python 脚本执行，无模型调用，不需要 CC Switch 注册 MCP。

## 安装与日常使用

```sh
codex plugin add dbg-codex@codex-toolshop
```

安装后在新 Codex 任务加载插件。宿主没有保证可用的“安装完成”脚本事件，因此首次 `SessionStart` 或首次 MCP 启动会调用同一套 doctor；并发入口通过进程锁合并。成功初始化后，同版本自动入口快速返回。失败的自动尝试间隔至少十分钟，显式命令立即重试。

后续安装新工具、检查更新或修复部署，执行：

```sh
dbg doctor
```

也可以直接运行插件源码入口：

```sh
node scripts/launch.cjs doctor
node scripts/launch.cjs doctor --tool ghidra --json
```

`dbg-doctor` skill 只负责调用该入口；不需要 AI 推断路径、下载地址或修改配置。MCP 列表在任务启动时加载，刚增加工具后需新开任务。宿主要求信任 hook 时，由宿主正常确认；插件不修改信任记录。MCP 启动入口仍可执行首次部署。

## 组件与兼容范围

| 组件 | 部署内容 | 使用前提 |
| --- | --- | --- |
| x64dbg | duty1g 原生 x32/x64 扩展、回环地址与令牌配置、HTTP 到 stdio 代理 | Windows；打开已部署插件的调试器 |
| Ghidra | 按本机 Ghidra API 编译版本匹配的扩展；独立 Python MCP bridge | 已安装 Ghidra 和 JDK 21+；首次在 Ghidra 启用 GhidraMCPPlugin |
| WinDbg | 隔离环境中的 mcp-windbg；自动绑定 cdb/kd 和符号缓存 | Windows；需要 Debugging Tools 的 cdb.exe 或 kd.exe，只有 GUI WinDbg 不足以运行该后端 |
| IDA MCP | ida-pro-mcp 1.4.0 GUI 插件与隔离 stdio 服务 | IDA 8.3+；不安装需要不同部署模型的 idalib 服务 |
| IDA-NO-MCP | 上游 Python 导出插件 | 仅在适配器确认的 IDA 版本范围内部署；导出不是 MCP 服务 |

不受支持的版本显示 `unsupported`，不下载不兼容组件，不阻塞其他工具。宿主未安装显示 `not_installed`。`deployed` 表示文件与配套运行时已准备完成，不表示 GUI 已打开或调试目标已连接。缺少宿主时，固定 MCP 入口只提供状态查询工具，不假冒调试能力。

x64dbg 与 x32dbg 使用独立入口 `dbg-x64dbg`、`dbg-x32dbg`，分别连接对应架构，避免同时打开两个调试器时操作到错误的实例。

Windows 自动发现 Scoop 用户/全局/自定义根、活动 `current`、已注册安装及 PATH。macOS/Linux 使用 PATH 和常见安装位置。Scoop 当前活动版本优先于历史目录。未命中非标准目录时，在 Dbg 数据目录的 `config.json` 显式添加根目录，无需重装插件：

```json
{
  "paths": {"ghidra": ["D:/Tools/ghidra_12.1.3_PUBLIC"], "ida": ["D:/Tools/IDA Pro 9.0"]},
  "disabled": []
}
```

`paths` 支持 `x64dbg`、`ghidra`、`windbg`、`ida`；`disabled` 使用组件名 `x64dbg`、`ghidra`、`windbg`、`ida-mcp`、`ida-export`。停用只影响后续部署和 MCP 启动，不删除已安装文件。

## 数据、更新与恢复

- Windows：`%LOCALAPPDATA%/Dbg`
- macOS：`~/Library/Application Support/Dbg`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/dbg`
- 所有平台均可通过 `DBG_HOME` 指定数据目录。

Node.js 18+ 由插件宿主环境提供。脚本优先使用 Python 3.11+；缺失时通过独立 uv 准备 Python 3.12，不改系统 Python。依赖保存在独立 venv。下载按 HTTPS 获取，发布资产有上游 SHA-256 时验证；缓存始终保留本地摘要，损坏时重新下载。

显式 doctor 每次查询稳定发布或精确提交；IDA MCP 固定在已适配的 GUI 版本 1.4.0，上游架构迁移需升级 Dbg 适配器。Ghidra bridge 来自 LaurieWired 上游，属于运行所需的协议桥，不是旧电脑路径包装脚本。源码固定到提交，Java 监听仅调整为 `127.0.0.1`，避免直接使用不匹配本机 Ghidra 版本的预编译 JAR。

`state.json` 保存文件归属、摘要和启动配置，包含本机 x64dbg 令牌，不应提交或共享。`last-report.json` 是不含运行令牌的部署摘要。修改前备份到 `backups`，受管文件缺失会修复；人工改动的受管文件和未知同名扩展会报冲突，避免自动覆盖。x64dbg 已有专用 MCP JSON 配置采用有限迁移，保留非关键字段并备份。更新失败保留已有可用运行入口。

插件不修改全局 MCP 配置、CC Switch 数据库或其他插件登记；旧配置迁移应单独清理，避免两个来源争夺同一入口。

## 验证与上游

```sh
npm test
```

测试覆盖平台发现、首次与重复执行、缺失修复、文件冲突、回滚、缓存损坏、路径穿越和 MCP 状态协议。CI 在 Windows、macOS、Linux 运行隔离测试；GUI 工具的实际兼容性仍以相应平台的宿主验证为准。

上游代码在运行时下载，各自遵循其仓库许可证：

- [duty1g/x64dbg-mcp-server](https://github.com/duty1g/x64dbg-mcp-server)
- [LaurieWired/GhidraMCP](https://github.com/LaurieWired/GhidraMCP)
- [svnscha/mcp-windbg](https://github.com/svnscha/mcp-windbg)
- [mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp)
- [P4nda0s/IDA-NO-MCP](https://github.com/P4nda0s/IDA-NO-MCP)
