# Dbg

Install the plugin and ask Codex to use WinDbg, x64dbg, x32dbg, IDA or Ghidra. The plugin supplies its invocation instructions automatically and starts only the requested MCP services. No separate skill installation, manual MCP registration or user-facing activation command is required. The `doctor` command remains available for extension deployment and repair.

## Installation and routine use

```sh
codex plugin add dbg-codex@codex-toolshop
```

Open a new Codex task after installation to load the plugin. Its `UserPromptSubmit` hook supplies internal invocation instructions without starting a debugger service. Ordinary chats no longer run automatic deployment. The first real debugger operation prepares missing deployment through the existing doctor workflow. A process lock combines concurrent preparation; failed automatic attempts are spaced at least ten minutes apart, while an explicit doctor retries immediately.

To install a newly added tool, check for updates, or repair deployment, run:

```sh
dbg doctor
```

You can also run the plugin source entry point directly:

```sh
node scripts/launch.cjs doctor
node scripts/launch.cjs doctor --tool ghidra --json
```

The existing `dbg-doctor` skill only invokes the deployment command; ordinary use does not require selecting a skill. AI need not infer paths or download URLs or modify configuration. If the host asks you to trust the plugin hooks, follow its normal confirmation flow; the plugin does not change trust records. A tool catalog is read when its endpoint is requested rather than registering five permanent stdio services at chat startup.

On Windows, the `dbg` entry point is automatically added to the current user's PATH. On macOS/Linux, it is installed in `~/.local/bin`. If that directory is not on PATH, doctor gives the needed shell configuration hint; you can also run `~/.local/bin/dbg doctor` directly.

## Components and compatibility

| Component | Deployment | Requirements |
| --- | --- | --- |
| x64dbg | Native duty1g x32/x64 extensions, loopback and token configuration, and an HTTP-to-stdio proxy | Windows; open the debugger with the deployed plugin |
| Ghidra | Extension compiled against the local Ghidra API, plus an isolated Python MCP bridge | A JDK compatible with the installed Ghidra (at least 21, or 25 for Ghidra 12.2). Enable GhidraMCPPlugin inside Ghidra on first use. |
| WinDbg | Official `DbgX.Mcp.Proxy.exe` preferred; legacy mcp-windbg/cdb/kd compatibility backend available | Windows; current WinDbg with MCP Service for native; Debugging Tools cdb.exe or kd.exe for legacy |
| IDA MCP | ida-pro-mcp 1.4.0 GUI plugin and isolated stdio service | IDA 8.3+; the idalib service, which has a different deployment model, is not installed |
| IDA-NO-MCP | Upstream Python export plugin | Deployed only for IDA versions confirmed by the adapter; export is not an MCP service |

Unsupported versions report `unsupported`; incompatible components are not downloaded and other tools continue. A missing host reports `not_installed`. `deployed` means files and supporting runtime are ready; it does not mean the GUI is open or a debugging target is connected. When the host is missing, the requested endpoint offers only a status query tool and does not claim debugging capability.

[IDA Free has no IDAPython API](https://hex-rays.com/ida-free), so the two Python plugins are not deployed even for newer version numbers.

x64dbg and x32dbg have separate `x64dbg` and `x32dbg` endpoint names. Each connects to its matching architecture to avoid controlling the wrong instance when both debuggers are open.

### Session processes and reuse

Version 0.2 replaces the five automatically registered `mcp__dbg_*` namespaces with the plugin's on-demand command entry point. A chat creates one local coordinator only when a debugger endpoint is requested. Each requested endpoint has its own MCP connection and owned backend; other endpoints do not start. Different chats do not share debugging state. The coordinator exits when all its endpoints are released, leaving no idle debugger frontend.

Each endpoint is released after 60 seconds without a real request. Initialization, outstanding tool calls and callbacks prevent idle retirement; a long-running analysis is not killed merely because it produces no output. `Stop`, `Interrupt` and `SessionEnd` hooks release the corresponding chat's services. Turn markers protect a newer turn from a delayed older cleanup hook. If hooks are unavailable, idle retirement remains the fallback.

The next operation starts a new service. This restores the ability to call tools, not the previous debugging state: select and verify the target again, especially with the legacy cdb/kd backend. Failed commands are never automatically replayed. Windows uses a private Job object and owner handle for backend descendants; POSIX uses an owned process group. The plugin does not select processes by name or terminate other chats or manually opened debugger GUI windows.

The internal commands are also available for troubleshooting:

```sh
node scripts/launch.cjs tools windbg
node scripts/launch.cjs call windbg <tool-name> --args-file <arguments.json>
node scripts/launch.cjs status
node scripts/launch.cjs stop
```

Commands use the current Codex session identity; outside Codex pass `--session <session-id>`. `status` and `stop` do not start a service. Read the selected endpoint's real tool catalog before constructing arguments. The legacy `mcp <endpoint>` command remains available for explicit stdio clients, which retain responsibility for closing their connection. Processes started by 0.1.x retain their old lifecycle until their host connections close; installing new files does not replace running processes.

On Windows, discovery checks Scoop user, global, and custom roots, the active `current` version, registered installations, and PATH. On macOS/Linux, it queries actual Homebrew prefixes for Apple Silicon, Intel Mac, Linuxbrew, and custom installations. It reads active formula `opt`/`libexec` directories and real paths of relevant installed casks. Without a package manager, it still checks PATH, application directories, and controlled one-level manual installation directories. Mac IDA discovery prefers the version in the application's `Info.plist` rather than relying on its directory name. An active Scoop `current` version takes precedence over historical directories.

Dbg reads the installed Ghidra's Java minimum and compiler target from `Ghidra/application.properties`. It can find Homebrew OpenJDK outside PATH and JDKs in standard macOS/Linux installation directories. Discovery reads package manager metadata. To register a Ghidra installation in a custom directory, add its root to the `paths` section of `config.json` in the Dbg data directory.

```json
{
  "paths": {"ghidra": ["D:/Tools/ghidra_12.1.3_PUBLIC"], "ida": ["D:/Tools/IDA Pro 9.0"]},
  "disabled": []
}
```

`paths` accepts `x64dbg`, `ghidra`, `windbg`, and `ida`. `disabled` accepts component names `x64dbg`, `ghidra`, `windbg`, `ida-mcp`, and `ida-export`. Disabling affects future deployment and MCP startup; it does not delete installed files.

### WinDbg native and compatibility backends

The `windbg` endpoint launches the official proxy over stdio with no arguments. Discovery checks the stable `%LOCALAPPDATA%/Microsoft/WindowsApps/Microsoft.WinDbg_8wekyb3d8bbwe/DbgX.Mcp.Proxy.exe` app execution alias and PATH. `paths.windbg` can also name the proxy executable or its directory. Dbg uses the installed Microsoft executable in place; doctor records launch metadata without launching WinDbg, starting MCP Service, or copying Microsoft files. The official proxy needs WinDbg 1.2610.1001.0 or later. The app alias does not encode a version, so a blank deployment version means it was not determined; the MCP `serverInfo.version` is a separate value.

Select a backend in the Dbg data directory's `config.json`, then run `dbg doctor --tool windbg`:

```json
{"windbg":{"backend":"auto"}}
```

- `auto` (default): prefer the official proxy. If it is absent, deploy the legacy cdb/kd backend. When selecting native, retain an already deployed, usable legacy runtime as backup; do not download mcp-windbg or build its isolated Python environment merely to prepare a backup.
- `native`: require the official proxy. Missing proxy or unsupported platform reports `unsupported`, and startup never falls back to legacy.
- `legacy`: explicitly deploy and use mcp-windbg with cdb/kd and its existing symbol-path configuration.

In `auto`, a saved backup is used only if the native executable has disappeared or Windows fails to create the proxy process. The interpreter and at least one cdb/kd executable must still exist. A diagnostic on stderr identifies the switch. Once the official process has been created, its exit code and protocol behavior are preserved: there is no automatic retry or command replay through legacy. Session availability, another connected client, secure-mode restrictions, and sampling failures do not trigger fallback. To choose legacy after such a failure, set `windbg.backend` explicitly and run doctor. A backup is a separate cdb/kd backend; it does not attach to the selected GUI session automatically.

In WinDbg, enable and start MCP Service for the intended window using WinDbg's normal confirmation flow. The proxy connects to that window's per-process named pipe. With exactly one available session it connects automatically; otherwise use `list_sessions`, `connect_session` with the intended process ID, and `disconnect_session` to switch. Each session permits one active MCP client. Verify the target type and execution state against WinDbg before issuing debugging commands. Dbg does not disconnect other clients or change WinDbg's default secure mode.

Microsoft officially supports VS Code with GitHub Copilot and GitHub Copilot CLI. Codex uses the generic stdio interface on a best-effort basis. Some protected operations require MCP sampling for prompt-injection classification; a client or policy that cannot provide sampling may fail those operations. Proxy discovery or an MCP handshake does not establish support for every debugging command or a live target.

See Microsoft's [WinDbg MCP overview](https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/windbg-mcp-overview), [setup](https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/set-up-windbg-mcp), and [connection troubleshooting](https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/troubleshoot-windbg-mcp-setup-connection-issues).

## Data, updates, and recovery

- Windows: `%LOCALAPPDATA%/Dbg`
- macOS: `~/Library/Application Support/Dbg`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/dbg`
- All platforms: set `DBG_HOME` to override the data directory.

MCP backends run from that data directory so they do not lock the plugin cache as their working directory. Scripts are still loaded by absolute path from the plugin directory. The on-demand coordinator keeps private ownership and turn records in the current user's home. It releases its owned services on idle retirement or explicit lifecycle cleanup; manually opened GUI windows remain outside that ownership.

The plugin host supplies Node.js 18+. Scripts prefer Python 3.11+ and look for it as `python3`, `python`, `python3.11`–`python3.14`, in Homebrew and python.org locations, and in a previously prepared isolated interpreter. If none is found, an isolated uv prepares Python 3.12 without changing system Python. First-time preparation runs under a lock so concurrent on-demand calls cannot install at the same time; a lock left by a killed process is released as soon as its owner is gone. Dependencies live in separate venvs. Downloads use HTTPS and verify an upstream SHA-256 digest when available. The cache always retains a local digest and redownloads damaged content.

GitHub API calls are anonymous by default. Existing `GH_TOKEN` or `GITHUB_TOKEN` environment variables are used automatically, sent only to `https://api.github.com`, never forwarded through redirects, and never written to state. CI uses its task-scoped read-only token to avoid anonymous rate limits on shared egress.

An explicit doctor checks stable releases or exact commits each time. IDA MCP is pinned to the adapted GUI version 1.4.0; upstream architecture changes require a Dbg adapter update. The Ghidra bridge comes from LaurieWired, pinned to a commit, and its Java extension is compiled for the local Ghidra. GhidraMCP 2.0 uses the official Python package and a per-commit isolated runtime; its Java source is compiled unchanged because upstream already binds locally. For the older single-file bridge, only its Java listener is restricted to `127.0.0.1`. Unknown or incomplete upstream layouts produce an explicit error.

`state.json` stores file ownership, hashes, and launch configuration, including the local x64dbg token; do not commit or share it. `last-report.json` is a deployment summary without runtime tokens. Managed files are backed up to `backups` before modification, and missing files are repaired. Manually changed managed files and unknown extensions with the same name report conflicts instead of being overwritten. An existing dedicated x64dbg MCP JSON configuration is migrated narrowly, preserving noncritical fields and backing it up. A failed update preserves the previous working launch entry point.

The plugin does not modify global MCP configuration, the CC Switch database, or other plugin registrations. Clean up legacy configuration separately to prevent two sources from claiming one entry point.

## Verification and upstream projects

```sh
npm test
```

Tests cover platform discovery, first and repeated runs, version upgrades, missing-file repair, file conflicts, rollback, cache damage, path traversal, and the MCP status protocol. CI runs isolated tests on Windows, macOS, and Linux. It also installs Homebrew Ghidra on macOS and verifies discovery, JDK selection, extension compilation, and Python MCP initialize, tools/list, and EOF exit. This protocol check does not require opening the GUI. Compatibility with GUI tools and real target calls still requires host verification on the relevant platform.

After Dbg is disabled or uninstalled, new tasks no longer load its invocation and lifecycle hooks. Existing on-demand services still retire when idle. Extensions copied into host tools, isolated runtimes, command entry points, and backups remain. There is currently no uninstall script that removes these files automatically.

Upstream code is downloaded at runtime and remains subject to each repository's license:

- [duty1g/x64dbg-mcp-server](https://github.com/duty1g/x64dbg-mcp-server)
- [LaurieWired/GhidraMCP](https://github.com/LaurieWired/GhidraMCP)
- [svnscha/mcp-windbg](https://github.com/svnscha/mcp-windbg)
- [Microsoft WinDbg MCP](https://learn.microsoft.com/en-us/windows-hardware/drivers/debuggercmds/windbg-mcp-overview) (installed with WinDbg; not downloaded by Dbg)
- [mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp)
- [P4nda0s/IDA-NO-MCP](https://github.com/P4nda0s/IDA-NO-MCP)
