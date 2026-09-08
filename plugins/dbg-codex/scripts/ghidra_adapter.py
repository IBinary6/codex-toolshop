"""从固定上游提交针对本机 Ghidra API 构建扩展，避免安装版本不匹配的 JAR。"""
from __future__ import annotations

import hashlib
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import sys
import zipfile

from dbg_core import DbgError, atomic_json, load_json, safe_extract_zip, sha256_file
from runtime import run_command

REPOSITORY = "LaurieWired/GhidraMCP"


def custom_settings_base(path: Path) -> Path:
    if not path.is_absolute():
        raise DbgError("Ghidra 设置基目录必须是绝对路径")
    # 宿主在 home 之外的共享基目录中加用户名，防止不同用户共用扩展配置。
    within_home = path.resolve().is_relative_to(Path.home().resolve())
    username = getpass.getuser().replace(" ", "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "ghidra" if within_home else username + "-ghidra"
    return path / name


def user_settings_dir(version: str, root: Path | None = None) -> Path:
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version):
        raise DbgError("无法识别 Ghidra 版本，未猜测用户扩展目录")
    if root is not None:
        launch = root / "support/launch.properties"
        if launch.is_file():
            for line in launch.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("VMARGS=-Dapplication.settingsdir="):
                    custom = line.strip().split("=", 2)[2].strip()
                    if custom:
                        path = Path(custom)
                        if not path.is_absolute():
                            raise DbgError("Ghidra application.settingsdir 必须是绝对路径")
                        return custom_settings_base(path) / f"ghidra_{version}_PUBLIC"
    if os.environ.get("XDG_CONFIG_HOME"):
        base = custom_settings_base(Path(os.environ["XDG_CONFIG_HOME"].strip()))
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", str(Path.home() / "AppData/Roaming"))) / "ghidra"
    elif sys.platform == "darwin":
        base = Path.home() / "Library/ghidra"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "ghidra"
    return base / f"ghidra_{version}_PUBLIC"


def javac_path(installation) -> Path:
    candidates = []
    launch = installation.root / "support/launch.properties"
    if launch.is_file():
        for line in launch.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("JAVA_HOME_OVERRIDE="):
                value = line.strip().split("=", 1)[1]
                if value:
                    candidates.append(Path(value) / "bin/javac")
    if os.environ.get("JAVA_HOME"):
        candidates.append(Path(os.environ["JAVA_HOME"]) / "bin/javac")
    found = shutil.which("javac")
    if found:
        candidates.append(Path(found))
    saved = user_settings_dir(installation.version, installation.root) / "java_home.save"
    if saved.is_file():
        candidates.append(Path(saved.read_text(encoding="utf-8").strip()) / "bin/javac")
    for candidate in candidates:
        if os.name == "nt" and candidate.suffix.lower() != ".exe":
            candidate = candidate.with_suffix(".exe")
        if not candidate.is_file():
            continue
        try:
            output = run_command([candidate, "-version"], timeout=10)
        except DbgError:
            continue
        match = re.search(r"javac\s+(\d+)", output)
        if match and int(match.group(1)) >= 21:
            return candidate
    raise DbgError("Ghidra 扩展构建需要 JDK 21+ 的 javac；请先完成 Ghidra 的 JDK 安装")


def build_extension(source: Path, installation, output: Path) -> Path:
    """使用宿主 JAR 编译原上游 Java；唯一适配是将 HTTP 监听限定到本机。"""
    compiler = javac_path(installation)
    sources = sorted((source / "src/main/java").rglob("*.java"))
    sources = [p for p in sources if p.name != "App.java"]
    if not sources:
        raise DbgError("Ghidra 上游发布中缺少 Java 源码")
    jars = sorted((installation.root / "Ghidra").glob("**/lib/*.jar"))
    if not jars:
        raise DbgError("宿主 Ghidra 缺少编译所需的 JAR")
    fingerprint = hashlib.sha256(json.dumps([
        installation.version, str(installation.root.resolve()),
        [(p.name, sha256_file(p)) for p in sources], "loopback-v1",
    ]).encode()).hexdigest()
    output.mkdir(parents=True, exist_ok=True)
    jar = output / "GhidraMCP.jar"
    marker = load_json(output / "build.json", default={})
    if marker.get("fingerprint") == fingerprint and jar.is_file():
        if marker.get("jar_hash") == sha256_file(jar):
            return jar
    patched_sources = []
    for src in sources:
        data = src.read_text(encoding="utf-8")
        if src.name == "GhidraMCPPlugin.java":
            old = "new InetSocketAddress(port)"
            if data.count(old) != 1:
                raise DbgError("Ghidra 上游监听实现已变化，需要更新适配器")
            data = data.replace(old, 'new InetSocketAddress("127.0.0.1", port)')
        dest = output / "src" / src.relative_to(source / "src/main/java")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(data, encoding="utf-8")
        patched_sources.append(dest)
    classes = output / "classes"
    classes.mkdir(exist_ok=True)
    args = ["--release", "21", "-encoding", "UTF-8", "-classpath",
            os.pathsep.join(str(p) for p in jars), "-d", str(classes),
            *[str(p) for p in patched_sources]]
    # javac 参数文件规避 Windows 命令行长度限制，路径不交给 shell 解释。
    argfile = output / "javac.args"
    argfile.write_text("\n".join('"' + x.replace("\\", "/").replace('"', '\\"') + '"' for x in args), encoding="utf-8")
    run_command([compiler, "@" + str(argfile)], timeout=180)
    classfiles = sorted(classes.rglob("*.class"))
    if not any(p.name == "GhidraMCPPlugin.class" for p in classfiles):
        raise DbgError("Ghidra 编译未产生目标插件类")
    temporary = output / "GhidraMCP.next.jar"
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
        for p in classfiles:
            archive.write(p, p.relative_to(classes).as_posix())
        resources = source / "src/main/resources/META-INF"
        if resources.is_dir():
            for p in resources.rglob("*"):
                if p.is_file():
                    archive.write(p, "META-INF/" + p.relative_to(resources).as_posix())
    os.replace(temporary, jar)
    atomic_json(output / "build.json", {"fingerprint": fingerprint, "jar_hash": sha256_file(jar)})
    return jar


def install_ghidra(installations, ctx):
    release = ctx.latest_release(REPOSITORY)
    tag = release["tag_name"]
    revision = ctx.resolve_commit(REPOSITORY, tag)
    stage = ctx.stage("ghidra", revision)
    source_dir = stage / "upstream"
    archive = ctx.downloader.fetch(f"https://github.com/{REPOSITORY}/archive/{revision}.zip")
    safe_extract_zip(archive, source_dir)
    candidates = list(source_dir.glob("*/bridge_mcp_ghidra.py"))
    if len(candidates) != 1:
        raise DbgError("Ghidra 上游源码布局已变化")
    source = candidates[0].parent
    # 固定运行时主版本范围；每次部署记录实际环境，避免修改全局 site-packages。
    python = ctx.ensure_runtime("ghidra-bridge-v1", ["mcp>=1.9,<2", "requests>=2.32,<3"])
    bridge = stage / "bridge_mcp_ghidra.py"
    shutil.copy2(source / "bridge_mcp_ghidra.py", bridge)
    files = {}
    for installation in installations:
        output = ctx.stage("ghidra-build", revision + installation.version + str(installation.root))
        jar = build_extension(source, installation, output)
        properties = output / "extension.properties"
        properties.write_text(
            "name=GhidraMCP\ndescription=Ghidra MCP bridge managed by Dbg\n"
            f"author=LaurieWired\nversion={installation.version}\nghidraVersion={installation.version}\n",
            encoding="utf-8",
        )
        module = output / "Module.manifest"
        module.write_text("GHIDRA_MODULE_NAME=GhidraMCP\nGHIDRA_MODULE_DESC=HTTP bridge managed by Dbg\n", encoding="utf-8")
        target = user_settings_dir(installation.version, installation.root) / "Extensions/GhidraMCP"
        files[target / "lib/GhidraMCP.jar"] = jar
        files[target / "extension.properties"] = properties
        files[target / "Module.manifest"] = module
    changed = ctx.deploy(files)
    return {
        "version": tag, "source": REPOSITORY, "revision": revision,
        "files": [str(p) for p in files], "changed": changed,
        "runtime": {"command": [str(python), str(bridge), "--ghidra-server", "http://127.0.0.1:8080/"], "env": {}},
        "message": "已针对本机 Ghidra 编译扩展并部署 MCP；首次需在 Ghidra 内启用 GhidraMCPPlugin",
    }
