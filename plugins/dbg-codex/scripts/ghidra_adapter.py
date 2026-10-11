"""Build the extension from a pinned upstream commit against the local Ghidra API to avoid a mismatched JAR."""
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


def source_layout(source: Path) -> str:
    """Accept only verified single-file bridge or official Python package layouts."""
    modern = source / "extension/src/main/java"
    package = source / "src/ghidra_mcp"
    if modern.exists() or package.exists():
        if (modern / "com/lauriewired/GhidraMCPPlugin.java").is_file() and all(
            (package / name).is_file() for name in ("__init__.py", "__main__.py", "cli.py")
        ) and (source / "pyproject.toml").is_file() and (
            source / "extension/Module.manifest"
        ).is_file():
            return "v2"
        raise DbgError("Official Ghidra upstream package layout is incomplete; unknown structure was not deployed")
    legacy = source / "src/main/java/com/lauriewired/GhidraMCPPlugin.java"
    if legacy.is_file() and (source / "bridge_mcp_ghidra.py").is_file():
        return "v1"
    raise DbgError("Ghidra upstream source layout has changed")


def extension_source(source: Path, layout: str) -> Path:
    return source / "extension" if layout == "v2" else source


def system_java_candidates():
    """Find installed JDKs absent from PATH without writes; enumerate only fixed levels and active brew opt."""
    if sys.platform == "win32":
        return
    from homebrew import homebrew_prefixes
    for prefix in homebrew_prefixes():
        opt = prefix / "opt"
        try:
            entries = sorted(opt.glob("openjdk*"))
        except OSError:
            entries = []
        for entry in entries:
            if not re.fullmatch(r"openjdk(?:@\d+)?", entry.name):
                continue
            yield entry / "libexec/openjdk.jdk/Contents/Home/bin/javac"
            yield entry / "bin/javac"
    roots = ([Path("/Library/Java/JavaVirtualMachines"), Path.home() / "Library/Java/JavaVirtualMachines"]
             if sys.platform == "darwin" else [Path("/usr/lib/jvm"), Path("/usr/java")])
    for root in roots:
        try:
            entries = sorted(root.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_dir():
                yield entry / ("Contents/Home/bin/javac" if sys.platform == "darwin" else "bin/javac")


def custom_settings_base(path: Path) -> Path:
    if not path.is_absolute():
        raise DbgError("Ghidra settings base directory must be absolute")
    # The host adds the username under a shared base outside home to prevent users from sharing extension configuration.
    within_home = path.resolve().is_relative_to(Path.home().resolve())
    username = getpass.getuser().replace(" ", "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "ghidra" if within_home else username + "-ghidra"
    return path / name


def user_settings_dir(version: str, root: Path | None = None) -> Path:
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version):
        raise DbgError("Cannot identify Ghidra version; user extension directory was not guessed")
    if root is not None:
        launch = root / "support/launch.properties"
        if launch.is_file():
            for line in launch.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("VMARGS=-Dapplication.settingsdir="):
                    custom = line.strip().split("=", 2)[2].strip()
                    if custom:
                        path = Path(custom)
                        if not path.is_absolute():
                            raise DbgError("Ghidra application.settingsdir must be absolute")
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
    from itertools import chain
    for candidate in chain(candidates, system_java_candidates()):
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
    raise DbgError("Building the Ghidra extension requires JDK 21+ javac; install the JDK required by Ghidra first")


def build_extension(source: Path, installation, output: Path, layout: str | None = None) -> Path:
    """Compile upstream Java against host JARs; additionally restrict HTTP listening to localhost for the old layout."""
    layout = layout or source_layout(source)
    extension = extension_source(source, layout)
    compiler = javac_path(installation)
    java_root = extension / "src/main/java"
    sources = sorted(java_root.rglob("*.java"))
    sources = [p for p in sources if p.name != "App.java"]
    if not sources:
        raise DbgError("Ghidra upstream release lacks Java source")
    resources = extension / "src/main/resources/META-INF"
    resource_files = sorted(p for p in resources.rglob("*") if p.is_file()) if resources.is_dir() else []
    jars = sorted((installation.root / "Ghidra").glob("**/lib/*.jar"))
    if not jars:
        raise DbgError("Host Ghidra lacks JARs required for compilation")
    fingerprint = hashlib.sha256(json.dumps([
        installation.version, str(installation.root.resolve()),
        layout,
        [(p.relative_to(java_root).as_posix(), sha256_file(p)) for p in sources],
        [(p.relative_to(resources).as_posix(), sha256_file(p)) for p in resource_files],
        "loopback-v1" if layout == "v1" else "native-loopback-v2",
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
        if layout == "v1" and src.name == "GhidraMCPPlugin.java":
            old = "new InetSocketAddress(port)"
            if data.count(old) != 1:
                raise DbgError("Ghidra upstream listener changed; the adapter needs an update")
            data = data.replace(old, 'new InetSocketAddress("127.0.0.1", port)')
        dest = output / "src" / src.relative_to(java_root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(data, encoding="utf-8")
        patched_sources.append(dest)
    classes = output / "classes"
    if classes.exists():
        shutil.rmtree(classes)
    classes.mkdir()
    args = ["--release", "21", "-encoding", "UTF-8", "-classpath",
            os.pathsep.join(str(p) for p in jars), "-d", str(classes),
            *[str(p) for p in patched_sources]]
    # A javac argument file avoids the Windows command-length limit; paths are never interpreted by a shell.
    argfile = output / "javac.args"
    argfile.write_text("\n".join('"' + x.replace("\\", "/").replace('"', '\\"') + '"' for x in args), encoding="utf-8")
    run_command([compiler, "@" + str(argfile)], timeout=180)
    classfiles = sorted(classes.rglob("*.class"))
    if not any(p.name == "GhidraMCPPlugin.class" for p in classfiles):
        raise DbgError("Ghidra compilation did not produce the target plugin class")
    temporary = output / "GhidraMCP.next.jar"
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
        for p in classfiles:
            archive.write(p, p.relative_to(classes).as_posix())
        for p in resource_files:
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
    candidates = [p for p in source_dir.iterdir() if p.is_dir()]
    if len(candidates) != 1:
        raise DbgError("Ghidra upstream source layout has changed")
    source = candidates[0]
    layout = source_layout(source)
    # Pin the runtime major-version range and record the actual environment on each deployment without changing global site-packages.
    if layout == "v2":
        python = ctx.ensure_runtime(
            "ghidra-package-" + revision, [str(source.resolve())],
            import_modules=["ghidra_mcp.cli"],
            find_modules=["ghidra_mcp.__main__"],
        )
        command = [str(python), "-m", "ghidra_mcp"]
    else:
        python = ctx.ensure_runtime("ghidra-bridge-v1", ["mcp>=1.9,<2", "requests>=2.32,<3"])
        bridge = stage / "bridge_mcp_ghidra.py"
        shutil.copy2(source / "bridge_mcp_ghidra.py", bridge)
        command = [str(python), str(bridge)]
    files = {}
    for installation in installations:
        output = ctx.stage("ghidra-build", revision + installation.version + str(installation.root))
        jar = build_extension(source, installation, output, layout)
        properties = output / "extension.properties"
        properties.write_text(
            "name=GhidraMCP\ndescription=Ghidra MCP bridge managed by Dbg\n"
            f"author=LaurieWired\nversion={installation.version}\nghidraVersion={installation.version}\n",
            encoding="utf-8",
        )
        module = output / "Module.manifest"
        upstream_manifest = extension_source(source, layout) / "Module.manifest"
        if upstream_manifest.is_file():
            shutil.copyfile(upstream_manifest, module)
        else:
            # Ghidra accepts an empty manifest when the old source has no such file.
            module.write_bytes(b"")
        target = user_settings_dir(installation.version, installation.root) / "Extensions/GhidraMCP"
        files[target / "lib/GhidraMCP.jar"] = jar
        files[target / "extension.properties"] = properties
        files[target / "Module.manifest"] = module
    changed = ctx.deploy(files)
    return {
        "version": tag, "source": REPOSITORY, "revision": revision,
        "files": [str(p) for p in files], "changed": changed,
        "runtime": {"command": [*command, "--ghidra-server", "http://127.0.0.1:8080/"], "env": {}},
        "message": "Extension compiled for local Ghidra and MCP deployed; enable GhidraMCPPlugin inside Ghidra on first use",
    }
