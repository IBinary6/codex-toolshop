import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dbg_core import DbgError
from ghidra_adapter import user_settings_dir
from ghidra_adapter import javac_path, system_java_candidates
from ghidra_adapter import build_extension, install_ghidra, source_layout
from discovery import Installation
from runtime import Context as RuntimeContext


class GhidraPathsTests(unittest.TestCase):
    def test_xdg_precedes_platform_default(self):
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, {"XDG_CONFIG_HOME": d}), patch("ghidra_adapter.Path.home", return_value=Path(d)):
            for platform in ("win32", "darwin", "linux"):
                with patch("ghidra_adapter.sys.platform", platform):
                    self.assertEqual(user_settings_dir("12.1.3"), Path(d) / "ghidra/ghidra_12.1.3_PUBLIC")

    def test_explicit_ghidra_settings_directory_precedes_xdg(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "support").mkdir()
            custom = root / "custom"
            (root / "support/launch.properties").write_text(
                f"#VMARGS=-Dapplication.settingsdir=ignored\nVMARGS=-Dapplication.settingsdir={custom}\n", encoding="utf-8")
            with patch("ghidra_adapter.Path.home", return_value=root):
                self.assertEqual(user_settings_dir("12.1.3", root), custom / "ghidra/ghidra_12.1.3_PUBLIC")

    def test_custom_directory_outside_home_uses_user_prefix(self):
        with tempfile.TemporaryDirectory() as d, patch("ghidra_adapter.Path.home", return_value=Path(d) / "home"), patch("ghidra_adapter.getpass.getuser", return_value="tester"):
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(Path(d) / "shared")}):
                self.assertEqual(user_settings_dir("12.1.3"), Path(d) / "shared/tester-ghidra/ghidra_12.1.3_PUBLIC")

    def test_unknown_version_is_not_guessed(self):
        with self.assertRaises(DbgError):
            user_settings_dir("")

    def test_brew_jdk_outside_path_is_probed_and_old_jdk_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve()
            host = root / "ghidra"
            host.mkdir()
            old = root / "java17/bin/javac"
            current = root / "brew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/javac"
            if os.name == "nt":
                old, current = old.with_suffix(".exe"), current.with_suffix(".exe")
            for path in (old, current):
                path.parent.mkdir(parents=True)
                path.touch()
            with patch.dict(os.environ, {}, clear=True), patch("ghidra_adapter.shutil.which", return_value=str(old)), patch("ghidra_adapter.system_java_candidates", return_value=iter([current])), patch("ghidra_adapter.user_settings_dir", return_value=root / "settings"), patch("ghidra_adapter.run_command", side_effect=lambda args, **kw: "javac 17.0.1" if args[0] == old else "javac 21.0.9"):
                self.assertEqual(javac_path(Installation("ghidra", host, "12.1.3")), current)

    def test_brew_active_jdk_layout_is_available_on_macos_and_linux(self):
        with tempfile.TemporaryDirectory() as d:
            prefix = Path(d).resolve()
            (prefix / "opt/openjdk@21").mkdir(parents=True)
            (prefix / "opt/openjdk-unrelated").mkdir()
            for platform in ("darwin", "linux"):
                with patch("ghidra_adapter.sys.platform", platform), patch("homebrew.homebrew_prefixes", return_value=[prefix]):
                    candidates = list(system_java_candidates())
                    self.assertIn(prefix / "opt/openjdk@21/bin/javac", candidates)
                    self.assertIn(prefix / "opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/javac", candidates)
                    self.assertFalse(any("openjdk-unrelated" in str(x) for x in candidates))


class GhidraLayoutTests(unittest.TestCase):
    def _archive(self, root, layout):
        archive = root / "upstream.zip"
        files = {
            "GhidraMCP/bridge_mcp_ghidra.py": "print('legacy bridge')\n",
        }
        if layout == "v1":
            files["GhidraMCP/src/main/java/com/lauriewired/GhidraMCPPlugin.java"] = (
                "new InetSocketAddress(port)\n"
            )
        elif layout == "v2":
            files.update({
                "GhidraMCP/extension/src/main/java/com/lauriewired/GhidraMCPPlugin.java": "class Plugin {}\n",
                "GhidraMCP/src/ghidra_mcp/__init__.py": "",
                "GhidraMCP/src/ghidra_mcp/__main__.py": "from ghidra_mcp.cli import main\nmain()\n",
                "GhidraMCP/src/ghidra_mcp/cli.py": "def main(): pass\n",
                "GhidraMCP/pyproject.toml": "[project]\nname = 'ghidra-mcp'\nversion = '2.0.0'\n",
                "GhidraMCP/extension/Module.manifest": "",
            })
        with zipfile.ZipFile(archive, "w") as output:
            for name, content in files.items():
                output.writestr(name, content)
        return archive

    def _install(self, root, archive):
        class Context:
            downloader = type("Downloader", (), {"fetch": lambda self, url: archive})()

            def __init__(self):
                self.runtime_calls = []
                self.deployed = []

            def latest_release(self, repo):
                return {"tag_name": "v2.0.0"}

            def resolve_commit(self, repo, tag):
                return "a" * 40

            def stage(self, name, version):
                return RuntimeContext(root, {}, root / "backup").stage(name, version)

            def ensure_runtime(self, name, requirements, *, import_modules=None, find_modules=None):
                self.runtime_calls.append((name, requirements, import_modules, find_modules))
                return root / "python"

            def deploy(self, files):
                self.deployed.append(files)
                return [str(path) for path in files]

        context = Context()
        jar = root / "GhidraMCP.jar"
        jar.write_bytes(b"class files")
        with patch("ghidra_adapter.build_extension", return_value=jar) as build:
            result = install_ghidra([Installation("ghidra", root / "host", "12.1.4")], context)
        return result, context, build

    def test_official_package_layout_installs_revision_scoped_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result, context, build = self._install(root, self._archive(root, "v2"))
            name, requirements, import_modules, find_modules = context.runtime_calls[0]
            self.assertEqual(name, "ghidra-package-" + "a" * 40)
            self.assertEqual(len(requirements), 1)
            self.assertTrue(Path(requirements[0]).is_absolute())
            self.assertEqual(import_modules, ["ghidra_mcp.cli"])
            self.assertEqual(find_modules, ["ghidra_mcp.__main__"])
            self.assertEqual(source_layout(Path(requirements[0])), "v2")
            self.assertEqual(result["runtime"]["command"][:3], [str(root / "python"), "-m", "ghidra_mcp"])
            self.assertEqual(build.call_args.args[-1], "v2")
            self.assertEqual(len(context.deployed), 1)
            deployed_manifest = next(
                source for target, source in context.deployed[0].items()
                if target.name == "Module.manifest"
            )
            self.assertEqual(deployed_manifest.read_bytes(), b"")

    def test_legacy_bridge_layout_is_still_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result, context, build = self._install(root, self._archive(root, "v1"))
            self.assertEqual(context.runtime_calls[0][0], "ghidra-bridge-v1")
            self.assertTrue(Path(result["runtime"]["command"][1]).is_file())
            self.assertEqual(build.call_args.args[-1], "v1")
            self.assertIsNone(context.runtime_calls[0][2])
            self.assertIsNone(context.runtime_calls[0][3])
            deployed_manifest = next(
                source for target, source in context.deployed[0].items()
                if target.name == "Module.manifest"
            )
            self.assertEqual(deployed_manifest.read_bytes(), b"")

    def test_incomplete_package_does_not_fall_back_to_legacy_bridge(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = self._archive(root, "v1")
            with zipfile.ZipFile(archive, "a") as output:
                output.writestr("GhidraMCP/src/ghidra_mcp/__init__.py", "")
            with self.assertRaisesRegex(DbgError, "layout is incomplete"):
                self._install(root, archive)

    def test_build_cache_tracks_resources_and_keeps_v2_java_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            java = source / "extension/src/main/java/com/lauriewired/GhidraMCPPlugin.java"
            java.parent.mkdir(parents=True)
            java.write_text("class Plugin {}\n", encoding="utf-8")
            package = source / "src/ghidra_mcp"
            package.mkdir(parents=True)
            for name in ("__init__.py", "__main__.py", "cli.py"):
                (package / name).touch()
            (source / "pyproject.toml").touch()
            (source / "extension/Module.manifest").touch()
            resource = source / "extension/src/main/resources/META-INF/services/example"
            resource.parent.mkdir(parents=True)
            resource.write_text("first", encoding="utf-8")
            host = root / "host"
            library = host / "Ghidra/lib/example.jar"
            library.parent.mkdir(parents=True)
            library.touch()
            output = root / "output"
            calls = []

            def compile_fake(command, **kwargs):
                calls.append(command)
                target = output / "classes/com/lauriewired/GhidraMCPPlugin.class"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"class")
                return ""

            with patch("ghidra_adapter.javac_path", return_value=root / "javac"), patch(
                "ghidra_adapter.run_command", side_effect=compile_fake
            ):
                jar = build_extension(source, Installation("ghidra", host, "12.1.4"), output)
                build_extension(source, Installation("ghidra", host, "12.1.4"), output)
                self.assertEqual(len(calls), 1)
                resource.write_text("second", encoding="utf-8")
                build_extension(source, Installation("ghidra", host, "12.1.4"), output)
            self.assertEqual(len(calls), 2)
            self.assertEqual(java.read_text(encoding="utf-8"), "class Plugin {}\n")
            with zipfile.ZipFile(jar) as built:
                self.assertEqual(built.read("META-INF/services/example"), b"second")
