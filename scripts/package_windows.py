#!/usr/bin/env python3
"""Package the native mach output with an isolated Orbit profile launcher."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def verify_native_package(package: Path) -> None:
    for name in ("firefox.exe", "xul.dll", "application.ini", "omni.ja", "browser/omni.ja"):
        if not (package / name).is_file():
            raise ValueError(f"Incomplete native Firefox package: missing {name}")
    entries: set[str] = set()
    for jar in (package / "omni.ja", package / "browser" / "omni.ja"):
        with zipfile.ZipFile(jar) as archive:
            entries.update(archive.namelist())
    for suffix in ("browser/components/orbit/Orbit.sys.mjs", "orbit/orbit.html", "orbit/orbit.css", "orbit/orbit.js"):
        if not any(name.endswith(suffix) for name in entries):
            raise ValueError(f"Native Orbit resource was not built into omni.ja: {suffix}")
    app_ini = (package / "application.ini").read_text(encoding="utf-8")
    if "Name=Orbit" not in app_ini:
        raise ValueError("application.ini was not rebuilt with Orbit's profile identity.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / ".upstream-source")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts")
    args = parser.parse_args()
    source = args.source.resolve()
    # mach package stages the complete native distribution here. Never package
    # a system Firefox install or an overlay without the rebuilt browser.
    built_package = source / "obj-orbit" / "dist" / "firefox"
    verify_native_package(built_package)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    package = output / "Orbit"
    if package.exists():
        raise ValueError(f"Output already exists; choose a fresh --output directory: {package}")
    shutil.copytree(built_package, package)
    (package / "distribution").mkdir(exist_ok=True)
    shutil.copy2(ROOT / "configs" / "policies.json", package / "distribution" / "policies.json")
    (package / "Launch-Orbit.cmd").write_text(
        '@echo off\r\n'
        'setlocal\r\n'
        'if not exist "%~dp0profile" mkdir "%~dp0profile"\r\n'
        'start "Orbit Prototype" "%~dp0firefox.exe" -no-remote -profile "%~dp0profile" %*\r\n',
        encoding="utf-8", newline="",
    )
    (package / "START-HERE.txt").write_text(
        "Orbit Prototype — native Firefox frontend fork\n\n"
        "Extract this complete folder to a writable location. Run Launch-Orbit.cmd.\n"
        "The launcher uses a separate profile stored in this folder.\n"
        "Open the Orbit toolbar button or Alt+Shift+O to see the tab canvas.\n"
        "firefox.exe is the reused Gecko executable filename; this folder contains\n"
        "Orbit's rebuilt native UI, not an extension or a website wrapper.\n"
        "Automatic browser updates are disabled to preserve this fork. Obtain new\n"
        "prototype builds from https://github.com/Marvinhaemke/orbit-browser/actions.\n"
        "Do not overwrite or reuse your normal Firefox profile.\n",
        encoding="utf-8",
    )
    pin = json.loads((ROOT / "firefox-source.json").read_text(encoding="utf-8"))
    shutil.copy2(ROOT / "firefox-source.json", package / "firefox-source.json")
    for name in ("LICENSE", "README.md"):
        if (ROOT / name).is_file():
            shutil.copy2(ROOT / name, package / name)
    zip_path = output / f"Orbit-Windows-x64-{pin['revision'][:12]}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(package.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(output).as_posix())
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    zip_path.with_suffix(".zip.sha256").write_text(f"{digest}  {zip_path.name}\n", encoding="utf-8")
    print(f"Packaged native Orbit: {zip_path}", flush=True)


if __name__ == "__main__":
    main()
