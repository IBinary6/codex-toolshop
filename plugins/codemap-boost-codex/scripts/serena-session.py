"""Private Serena session configuration; modify only owned directories, without writing project configuration."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

import yaml
from serena.config.serena_config import SerenaConfig, ProjectConfig, RegisteredProject


def read_yaml(file):
    if not file.is_file():
        return {}
    with file.open(encoding="utf-8-sig") as stream:
        value = yaml.safe_load(stream)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("configuration must be a mapping")
    return value


def write_yaml(file, value):
    temporary = file.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        yaml.safe_dump(value, stream, allow_unicode=True, sort_keys=False)
    os.replace(temporary, file)


def config_for(data):
    config = SerenaConfig()
    for key in ("project_serena_folder_location", "ls_specific_settings"):
        if key in data:
            setattr(config, key, data[key])
    return config


def project_config(root, config):
    file = Path(config.get_project_yml_location(str(root)))
    if not file.is_file():
        return None
    # load() fills missing fields; use the same native dictionary parsing and local overrides without calling save.
    data, _ = ProjectConfig._load_yaml_dict(str(file))
    local = Path(ProjectConfig._project_local_yml_path(str(file)))
    overrides = []
    if local.is_file():
        values, _ = ProjectConfig._load_yaml_dict(str(local), apply_defaults=False)
        if values:
            overrides = list(values)
            data.update(values)
    data.setdefault("project_name", root.name)
    return ProjectConfig._from_dict(data, local_override_keys=overrides)


def resolve(data, target):
    config = config_for(data)
    # Trust only existing absolute registered paths; legacy relative entries must not broaden project scope from frontend cwd.
    for entry in data.get("projects", []) or []:
        root = Path(entry)
        if not root.is_absolute() or not root.is_dir():
            continue
        try:
            project = project_config(root, config)
            if project:
                config.projects.append(RegisteredProject(project_root=str(root.resolve()), project_config=project))
        except Exception:
            continue
    registered = config.get_registered_project(target, autoregister=False)
    if registered:
        return {"root": str(Path(registered.project_root).resolve()), "name": registered.project_name,
                "languages": [item.value for item in registered.project_config.language_servers]}
    root = Path(target)
    if root.is_absolute() and root.is_dir():
        project = project_config(root, config)
        return {"root": str(root.resolve()), "name": project.project_name if project else None,
                "languages": [item.value for item in project.language_servers] if project else None}
    return {"root": None, "diagnostics": ["Project name did not resolve to a trusted absolute path; continuing with limited native Serena functionality."]}


def managed_cpp(cpp):
    args = cpp.get("ls_extra_args", []) or []
    return any(str(arg).startswith("--compile-commands-dir") for arg in args) or any(
        key in cpp for key in ("ls_base_cmd", "ls_path", "compile_commands_dir")
    )


def has_jobs_arg(args):
    return any(arg == "-j" or arg.startswith("-j=") or
               (arg.startswith("-j") and arg[2:].isdigit()) for arg in args)


def main(request):
    home = Path(request["home"])
    if not home.is_absolute():
        raise ValueError("session home must be absolute")
    file = home / "serena_config.yml"
    baseline = home / "frontend-base.yml"
    command = request["command"]
    if command == "clone":
        home.mkdir(parents=True, exist_ok=False)
        source = Path(request["source"])
        if (source / "serena_config.yml").is_file():
            data = read_yaml(source / "serena_config.yml")
            for name in ("contexts", "modes", "prompts", "custom_tools"):
                if (source / name).is_dir():
                    shutil.copytree(source / name, home / name)
        else:
            # Generate the official template in the private home without registering or generating projects.
            SerenaConfig.from_config_file()
            data = read_yaml(file)
        write_yaml(file, data)
        write_yaml(baseline, data)
        return {"ok": True}
    data = read_yaml(file)
    if command == "resolve":
        return resolve(data, request["project"])
    if command != "apply":
        raise ValueError("unknown command")
    base = read_yaml(baseline)
    settings = copy.deepcopy(base.get("ls_specific_settings", {}) or {})
    cpp = settings.get("cpp", {}) or {}
    root = request.get("root")
    project = project_config(Path(root), config_for(base)) if root else None
    project_cpp = (project.ls_specific_settings or {}).get("cpp", {}) if project else {}
    diagnostics = []
    preparation = request.get("preparation", {})
    if managed_cpp(cpp) or project_cpp:
        diagnostics.append("Existing user C++ language-server configuration takes precedence; preserved configuration without injecting the automatic compilation database.")
    elif preparation.get("databaseDir") and preparation.get("status") == "ready":
        cpp = copy.deepcopy(cpp)
        database = Path(preparation["databaseDir"])
        args = list(cpp.get("ls_extra_args", []) or [])
        # Preserve background indexing and user arguments; limit only the default async worker count for managed clangd.
        if not has_jobs_arg(args):
            args.append("-j=2")
        if not preparation.get("nativeRootDatabase"):
            args.append(f"--compile-commands-dir={database}")
        cpp["ls_extra_args"] = args
        # Native cache fingerprints omit ls_extra_args; distinguish effective arguments through output directories.
        fingerprint = hashlib.sha256(json.dumps([root, preparation.get("generation"), preparation.get("status"),
            str(database), preparation.get("nativeRootDatabase"), cpp], sort_keys=True).encode("utf-8")).hexdigest()
        cache = home / "compile-cache" / fingerprint
        cache.mkdir(parents=True, exist_ok=True)
        cpp["compile_commands_dir"] = str(cache)
        settings["cpp"] = cpp
    data["ls_specific_settings"] = settings
    write_yaml(file, data)
    return {"ok": True, "diagnostics": diagnostics}


if __name__ == "__main__":
    try:
        result = main(json.loads(sys.stdin.buffer.read().decode("utf-8")))
    except Exception as error:
        # Exceptions may contain configuration values; return only their type without exposing full diagnostics.
        result = {"ok": False, "diagnostics": [f"Serena private configuration failed ({type(error).__name__}); retaining limited native functionality."]}
    sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8"))
