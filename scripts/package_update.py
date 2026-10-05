#!/usr/bin/env python3
"""Create an engine-pinned Windows frontend update and updater setup ZIP.

Only the two rebuilt omni.ja resource archives enter the update payload. Native
engine files are fingerprinted, never replaced; profiles and application.ini
remain outside the update. The setup ZIP installs the two updater scripts once.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import zipfile

from package_windows import verify_native_package

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD_PATHS = ("omni.ja", "browser/omni.ja")
SETUP_PATHS = ("Update-Orbit.cmd", "Update-Orbit.ps1")
UPDATE_NAME = "Orbit-UI-Update.zip"
MANIFEST_NAME = "orbit-update.json"
SETUP_NAME = "Orbit-Update-Setup.zip"
# Firefox's Windows frontend build regenerates these two NSIS utilities
# independently of the pinned Gecko artifact. They uninstall the application
# or install the optional maintenance service; neither loads browser resources.
# UI updates never execute or replace them. All other EXEs/DLLs, including the
# maintenance service itself, remain part of the strict native fingerprint.
ENGINE_EXCLUSIONS = frozenset({"uninstall/helper.exe", "maintenanceservice_installer.exe"})
REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def exact_revision(value: object, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", value):
        raise ValueError(f"{label} must be an exact 40-character Git revision.")
    return value.lower()


def reject_link(path: Path) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT:
        raise ValueError(f"Symlinks and reparse points are not allowed: {path}")
    if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
        raise ValueError(f"Only regular files and directories are allowed: {path}")


def native_package_files(package: Path) -> list[Path]:
    reject_link(package)
    if not package.is_dir():
        raise ValueError("--package must point to the extracted native Orbit directory.")
    paths = []
    for directory, directories, files in os.walk(package, followlinks=False):
        base = Path(directory)
        for name in directories:
            child = base / name
            reject_link(child)
            if base == package and name.casefold() in {"profile", "profiles"}:
                raise ValueError("Do not create updates from a package containing a personal profile.")
        for name in files:
            child = base / name
            reject_link(child)
            paths.append(child)
    return sorted(paths, key=lambda path: path.relative_to(package).as_posix())


def hash_stream(stream) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def file_record(path: Path, relative: str) -> dict:
    reject_link(path)
    if not path.is_file():
        raise ValueError(f"Required native package file is missing: {relative}")
    with path.open("rb") as stream:
        digest, size = hash_stream(stream)
    if not size:
        raise ValueError(f"Required native package file is empty: {relative}")
    return {"path": relative, "sha256": digest, "size": size}


def read_pin(path: Path) -> dict:
    reject_link(path)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Firefox source pin must be an object.")
    revision = exact_revision(value.get("revision"), "Firefox source revision")
    artifact = exact_revision(value.get("artifact_revision"), "Gecko artifact revision")
    if revision != artifact:
        raise ValueError("Frontend update requires the same pinned Firefox source and Gecko artifact revision.")
    return {"revision": revision, "artifact_revision": artifact}


def build_update(package: Path, output: Path, commit: str, *, root: Path = ROOT) -> dict:
    commit = exact_revision(commit, "Orbit commit")
    package = package.absolute()
    output = output.absolute()
    if output == package or package in output.parents:
        raise ValueError("Update output must be outside the native package directory.")
    pin = read_pin(root / "firefox-source.json")
    native_files = native_package_files(package)
    if read_pin(package / "firefox-source.json") != pin:
        raise ValueError("Native package source pin does not match this repository's Firefox pin.")
    verify_native_package(package)
    required_engine = ("orbit.exe", "xul.dll")
    for path in required_engine:
        file_record(package / path, path)
    engine_paths = [
        path for path in native_files
        if path.suffix.casefold() in {".exe", ".dll"}
        and path.relative_to(package).as_posix() not in ENGINE_EXCLUSIONS
    ]
    engine = [file_record(path, path.relative_to(package).as_posix()) for path in engine_paths]
    files = [file_record(package / path, path) for path in PAYLOAD_PATHS]
    updater_files = [root / "scripts/windows" / path for path in SETUP_PATHS]
    for path in updater_files:
        file_record(path, path.name)

    output.mkdir(parents=True, exist_ok=True)
    reject_link(output)
    for name in (UPDATE_NAME, MANIFEST_NAME, SETUP_NAME):
        if (output / name).exists() or (output / name).is_symlink():
            reject_link(output / name)
    update_path = output / UPDATE_NAME
    with zipfile.ZipFile(update_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in PAYLOAD_PATHS:
            archive.write(package / path, path)
    # Verify the bytes actually archived, catching a payload change between
    # hashing and compression. No additional directory or file can enter ZIP.
    with zipfile.ZipFile(update_path) as archive:
        if archive.namelist() != list(PAYLOAD_PATHS):
            raise ValueError("Frontend update ZIP contains an unexpected path.")
        for record in files:
            with archive.open(record["path"]) as stream:
                digest, size = hash_stream(stream)
            if (digest, size) != (record["sha256"], record["size"]):
                raise ValueError(f"Frontend payload changed while packaging: {record['path']}")
    zip_record = file_record(update_path, UPDATE_NAME)
    manifest = {
        "schema_version": 1,
        "platform": "windows-x64",
        **pin,
        "commit": commit,
        "engine_files": engine,
        "files": files,
        "package": {"name": UPDATE_NAME, "sha256": zip_record["sha256"], "size": zip_record["size"]},
    }
    with zipfile.ZipFile(output / SETUP_NAME, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in updater_files:
            archive.write(path, path.name)
    (output / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Created {UPDATE_NAME}: {zip_record['size']} bytes; pinned engine files: {len(engine)}", flush=True)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    build_update(args.package, args.output, args.commit)


if __name__ == "__main__":
    main()
