# System Proxy for Codex

让 Codex 使用已经运行的本地系统代理，减少代理环境下反复出现的 `Reconnecting... 1/5` 到 `5/5`。

## 安装

```text
codex plugin marketplace add https://github.com/IBinary6/codex-toolshop.git
codex plugin add system-proxy-codex@codex-toolshop
```

插件首次加载时只启用 `$CODEX_HOME/config.toml` 中的 `features.respect_system_proxy`，不会自动改写 `.env`。修改后需要完整退出并重新打开 Codex。

## 一键配置 `.env` 和 `config.toml`

要求 Python 3.10 或更高版本。macOS 使用 `python3`，Windows 使用 `py -3`：

```text
# macOS
python3 install_system_proxy_codex.py
python3 install_system_proxy_codex.py --port 7890

# Windows
py -3 install_system_proxy_codex.py
py -3 install_system_proxy_codex.py --port 7890
```

脚本源码：

```text
https://raw.githubusercontent.com/IBinary6/codex-toolshop/system-proxy-codex-v0.1.1/scripts/install_system_proxy_codex.py
```

下载到当前目录后，应先审查再运行。macOS 示例：

```text
python3 -c "import urllib.request; open('install_system_proxy_codex.py','wb').write(urllib.request.urlopen('https://raw.githubusercontent.com/IBinary6/codex-toolshop/system-proxy-codex-v0.1.1/scripts/install_system_proxy_codex.py').read())"
python3 install_system_proxy_codex.py --dry-run
python3 install_system_proxy_codex.py
```

Windows 将上面的 `python3` 替换为 `py -3`。确认仓库地址可信后，也可以直接执行一行 bootstrap：

```text
python3 -c "import urllib.request; exec(compile(urllib.request.urlopen('https://raw.githubusercontent.com/IBinary6/codex-toolshop/system-proxy-codex-v0.1.1/scripts/install_system_proxy_codex.py').read(), 'install_system_proxy_codex.py', 'exec'))"
```

发布脚本固定到 `system-proxy-codex-v0.1.1` 标签，并在执行前校验下载组件的 SHA-256。

也可以安装插件后在 Codex 中说：

```text
使用 system-proxy-setup 一键配置 Codex 代理
使用 system-proxy-setup，把 Codex 代理端口设置为 7890
```

无参数时先检测 Windows、macOS 或 Linux 的静态代理；检测不到时尝试 `http://127.0.0.1:7897`，且只有端口实际可连接才会写配置。Windows 的 `ProxyOverride` 和 macOS 的 `ExceptionsList` 会合并到 `NO_PROXY`；其中 Windows 无法安全转换的通配符会忽略。

脚本只管理 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `NO_PROXY`，会保留其他 `.env` 内容并在修改前备份。现有 `wss_proxy` 会保留，但当前 Codex 不读取该非标准变量。

## 限制

- 不安装或控制 Clash、Clash Verge Rev 等代理软件。
- 首版不求值 PAC/WPAD，也不自动配置 SOCKS-only 代理。
- 修改 `.env` 或 `config.toml` 后必须完整重启 Codex。
