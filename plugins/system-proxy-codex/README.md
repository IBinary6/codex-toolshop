# System Proxy for Codex

Use an existing local system proxy with Codex to reduce repeated `Reconnecting... 1/5` through `5/5` messages in proxy environments.

## Installation

```text
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
codex plugin add system-proxy-codex@codex-toolshop
```

The first plugin load only enables `features.respect_system_proxy` in `$CODEX_HOME/config.toml`; it does not rewrite `.env` automatically. Fully quit and reopen Codex afterward.

## Configure `.env` and `config.toml`

Requires Python 3.10 or later. Use `python3` on macOS and `py -3` on Windows. The plugin's own hooks also find versioned names such as `python3.12`, Homebrew and python.org locations, and uv-managed interpreters; set `SYSTEM_PROXY_PYTHON` to choose one explicitly:

```text
# macOS
python3 install_system_proxy_codex.py
python3 install_system_proxy_codex.py --port 7890

# Windows
py -3 install_system_proxy_codex.py
py -3 install_system_proxy_codex.py --port 7890
```

Script source:

The remote commands below require the matching release tag to be published. For an unreleased checkout, run the repository's local `scripts/install_system_proxy_codex.py` instead; it uses the bundled components.

```text
https://raw.githubusercontent.com/IBinary6/codex-toolshop/system-proxy-codex-v0.1.4/scripts/install_system_proxy_codex.py
```

Download into the current directory and review before running. For example, on macOS:

```text
python3 -c "import urllib.request; open('install_system_proxy_codex.py','wb').write(urllib.request.urlopen('https://raw.githubusercontent.com/IBinary6/codex-toolshop/system-proxy-codex-v0.1.4/scripts/install_system_proxy_codex.py').read())"
python3 install_system_proxy_codex.py --dry-run
python3 install_system_proxy_codex.py
```

On Windows, replace `python3` with `py -3`. After verifying that you trust the repository URL, you can also run the bootstrap directly:

```text
python3 -c "import urllib.request; exec(compile(urllib.request.urlopen('https://raw.githubusercontent.com/IBinary6/codex-toolshop/system-proxy-codex-v0.1.4/scripts/install_system_proxy_codex.py').read(), 'install_system_proxy_codex.py', 'exec'))"
```

The standalone release script is pinned to `system-proxy-codex-v0.1.4` and verifies downloaded components with SHA-256 before execution.

After installing the plugin, you can also ask Codex:

```text
Use system-proxy-setup to configure the Codex proxy.
Use system-proxy-setup to set the Codex proxy port to 7890.
```

Without arguments, setup detects the Windows, macOS, or Linux static proxy, falling back to `http://127.0.0.1:7897` if none is found. It writes configuration only if the port is reachable. Windows `ProxyOverride` and macOS `ExceptionsList` are merged into `NO_PROXY`; Windows wildcard rules that cannot be safely represented are ignored.

The script manages only `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`, preserving other `.env` content and creating a backup before changes. Existing `wss_proxy` is retained, although current Codex does not read this nonstandard variable.

## Limitations

- Does not install or control proxy applications such as Clash or Clash Verge Rev.
- The initial implementation does not evaluate PAC/WPAD or automatically configure SOCKS-only proxies.
- Changes to `.env` or `config.toml` require a full Codex restart.
