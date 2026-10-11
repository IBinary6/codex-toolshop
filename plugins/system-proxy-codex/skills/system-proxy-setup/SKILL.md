---
name: system-proxy-setup
description: Configure or inspect Codex proxy settings, including Clash Verge Rev ports, CODEX_HOME/.env, and respect_system_proxy.
---

# System Proxy setup

Use this skill when the user asks to configure, inspect, repair, or change the Codex proxy or mentions repeated `Reconnecting...` attempts.

## Workflow

1. Resolve this skill's plugin root by moving two directories up from this `SKILL.md`.
2. Determine the requested scope before choosing arguments. For inspection, explanation, or diagnosis without a requested repair, include `--dry-run` in the initial command. For an already authorized configuration change, run without it; do not ask for the same authorization again.
3. Map an explicitly requested local port to `--port <PORT>`; map a complete proxy URL to `--proxy-url <URL>`.
4. With no explicit address, run without proxy arguments. The script detects the operating-system proxy and falls back to `http://127.0.0.1:7897` only when that port is reachable.
5. Report the source, actual exit status, whether `.env` changed, and the backup path if created. A dry run is a proposed configuration: it does not verify proxy connectivity or enable the feature. Request a full Codex restart only after an actual configuration change.

Examples:

```text
node "<plugin-root>/hooks/js/run-python.js" --exec "<plugin-root>/scripts/install_system_proxy_codex.py" --skip-plugin-install --dry-run
node "<plugin-root>/hooks/js/run-python.js" --exec "<plugin-root>/scripts/install_system_proxy_codex.py" --skip-plugin-install
node "<plugin-root>/hooks/js/run-python.js" --exec "<plugin-root>/scripts/install_system_proxy_codex.py" --skip-plugin-install --port 7890
node "<plugin-root>/hooks/js/run-python.js" --exec "<plugin-root>/scripts/install_system_proxy_codex.py" --skip-plugin-install --proxy-url http://192.168.1.10:7890
```

## Safety boundaries

- Do not print API keys or unrelated `.env` values.
- Do not add `wss_proxy`; current Codex uses `HTTPS_PROXY`, `HTTP_PROXY`, and `ALL_PROXY` for WSS.
- Do not guess a port after both system detection and the reachable default check fail.
- Do not install, start, stop, or reconfigure Clash or another proxy application.
- Use `--dry-run` when the user asks to inspect without changing files.
