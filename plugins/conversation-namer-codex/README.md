# Conversation Namer for Codex

Generate consistent Codex conversation titles that are easy to scan in the sidebar, while leaving project names and conversation organization unchanged.

## Installation

```text
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
codex plugin add conversation-namer-codex@codex-toolshop
```

The plugin requires Node.js 18 or later and a signed-in `codex` CLI available on `PATH` (the current interface was verified with 0.151.0). It supports Windows and macOS. After installation or an update, trust the changed hooks in Codex and create a new conversation to enable automatic naming.

## Automatic naming

After a new conversation receives its first user message, the plugin asks a lightweight model to generate a title in the background. For desktop tasks, the current task calls `mcp__codex_app__set_thread_title` so both persisted state and the interface update; CLI tasks write through App Server. The main model does not generate the name, read a skill, show a preview, or wait for confirmation. It makes one desktop write call after the title is ready.

```text
MMDD<separator>TYPE<separator>Topic
```

The separator is the fullwidth vertical line (U+FF5C). The model returns only the type and topic. The topic follows the language of the first message. The program reads the conversation's `createdAt` and computes the date in `Asia/Shanghai`. By default, types use the English codes `FEA / DES / FIX / OPT / REL / EXP / DOC / RES`; Chinese type labels are used only when the first request explicitly asks for them.

Each startup conversation claims a naming job only once. Later messages, repeated hooks, resume, clear, and compaction do not rerun it. A background observer watches the first turn at startup, while `UserPromptSubmit` remains a direct entry point. Both paths share an atomic claim marker. For tasks created with `create_thread`, the first request may be a delegation message from `codex_app.create_thread` rather than a regular user message; the observer extracts it from the host's explicit envelope. It reads only the current task's first turn and does not infer a request from titles, previews, or other tasks.

Opening progress updates do not affect naming. The first write uses the plugin's result even if the host assigned a default title while the model was working. Long tasks request the write on the next `PostToolUse`; short answers without tool calls use `Stop`. Both delivery paths share a separate atomic marker, so each task requests at most one desktop write. Continuations triggered by other plugins do not regenerate or redeliver the title. Automatic mode changes only the current main task's title.

Desktop delivery passes the generated title to the host tool as a JSON string, without asking the main model to rewrite it. `PostToolUse` checks the tool name, current task ID, title, and successful response before marking delivery complete. Reading the same title through another App Server connection does not confirm desktop delivery. An explicit current user instruction against renaming or tool calls takes precedence; the hook does not expand authorization.

Greetings, brief questions, and conversation management requests also get titles. The plugin skips naming only when the user explicitly asks it to; if the user specifies a complete title, it uses that text. The model receives only the first message and short naming rules. Its temporary task is not saved as a sidebar conversation and disables project instructions, plugin hooks, MCP, memory, and work tools. Without a valid creation time, the plugin does not guess the date.

## Lightweight model and state

The default is `luna`, resolved against the live `model/list` to the latest compatible Luna release. The `luna`, `sol`, and `astra` settings each stay within their exact family and compare numeric version components, so version 6.10 sorts after 6.9. Incompatible releases are excluded before choosing a version; if that family has no compatible release, the original title remains. With an explicit `model: "auto"` setting, it selects an available text model using low-cost signals in model descriptions, falling back to the Luna, Mini, and Nano families when descriptions lack such signals. The catalog has no comparable actual prices, so automatic selection does not claim to rank models by price.

Candidates must explicitly support `none`, `minimal`, or `low`. Generation uses the lowest level the selected model actually declares. In `auto` mode, within the same selection tier, the lowest supported effort wins; further ties retain catalog order. Hidden models, non-text models, and models with only higher effort levels are excluded. With no suitable candidate, the original title remains. Family aliases are resolved to a full model ID before `thread/start` or `turn/start`. The naming subprocess uses the `default` service tier and does not inherit the main task's Fast or priority tier.

Set a model or timeout in the plugin's `PLUGIN_DATA/config.json` if needed:

```json
{ "model": "luna", "timeoutSeconds": 60 }
```

`model` accepts `luna`, `sol`, `astra`, `auto`, or a full model ID available to the current account. A full ID pins that exact release without switching to another model when it is unavailable. `timeoutSeconds` accepts 5–120 seconds. This configuration affects only naming, not the global Codex model. The plugin reuses existing login and provider settings and starts at most one naming inference per new conversation.

The executable follows the recognized host: desktop tasks on Windows or macOS use the Codex bundled with the desktop app, and CLI tasks use the CLI. If the host is unspecified, it searches for the CLI on `PATH` and for the desktop app. On other platforms with unrecognized desktop layouts, it retains the `PATH` launch path. It does not hard-code a username or version directory or switch hosts after a model call fails.

`PLUGIN_DATA/sessions/` stores state indexed by a hash of the conversation ID and atomic claim markers. It does not store user messages or server diagnostics:

| State | Meaning |
| --- | --- |
| `pending` | Waiting for the first request |
| `started` | One naming inference has been claimed |
| `ready` + `delivery: desktop` | Title generated; desktop write not yet confirmed |
| `ready` + `desktopSync: requested` | Current task asked to call the desktop tool; success not yet confirmed |
| `done` + `desktopSync: acknowledged` | Desktop tool returned the matching task ID and title |
| `done` (CLI) | App Server wrote and read back the same title |
| `skipped / failed` | Skipped or failed; no automatic retry |

When `PLUGIN_DATA` is unset, the path is `$CODEX_HOME/plugins/data/conversation-namer-codex`; `CODEX_HOME` defaults to `.codex` under the user's home directory. A forcibly terminated background process or system shutdown may leave a task in `started`; that state does not prove it is still running or succeeded. If the desktop tool is unavailable, fails, or the main model does not perform delivery, the state remains `ready`. The plugin does not falsely mark it `done` or fall back to UI automation, direct database edits, or an independent App Server write.

The startup observer waits up to 60 seconds with backoff polling and does not call the naming model. If the first request is absent, it stops and leaves `pending`, so a later manual first message can still be named. Once it has the request, generation and writing are also bounded by `timeoutSeconds`. For a tool-created task, `pending` without `.claimed` means the job has not been claimed; `started / failed / skipped` means it entered the naming path and must not trigger another model call.

If a short answer finishes while naming is still in progress, `Stop` waits at most once, for the configured timeout plus five seconds (65 seconds by default; 125 seconds maximum). After a timeout it lets the answer finish. A late generated title may be delivered at a later tool return or stop; inference does not rerun.

## Limitations

- Automatic naming depends on the CLI interfaces `model/list`, `thread/start`, `turn/start`, `thread/read`, and `thread/name/set`. Missing CLI access, login, or interfaces cause failure and retain the original title.
- Desktop writing requires `mcp__codex_app__set_thread_title` in the current task. Desktop/editor tasks whose App Server source is `vscode` use this path. If an editor host lacks the tool, delivery remains unconfirmed. CLI tasks continue to write persistent state. API success alone does not establish that the desktop display was verified.
- Desktop delivery adds one main-task tool call. A short answer without tool calls may add one `Stop` continuation. It neither reads a skill nor reruns the naming model. The first delivery can overwrite a default or manually set title at that point; it makes no further changes after completion.
- After a CLI plugin update, a running desktop process may still cache the old plugin path. If the new version is installed on the command line but a new task reports an old hook or MCP path missing, fully quit and reopen the app, then check a naturally triggered hook. Running a hook manually does not replace that check.
- A first message longer than 20,000 characters or without text is skipped.
