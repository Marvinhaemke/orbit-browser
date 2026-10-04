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


def write_launcher(package: Path) -> None:
    (package / "Launch-Orbit.cmd").write_text(
        '@echo off\r\n'
        'setlocal\r\n'
        'if not exist "%~dp0orbit.exe" (\r\n'
        '  echo Extract the complete Orbit download before starting it.\r\n'
        '  echo Launch-Orbit and orbit.exe must be in the same folder.\r\n'
        '  pause\r\n'
        '  exit /b 1\r\n'
        ')\r\n'
        'if not exist "%~dp0profile" mkdir "%~dp0profile"\r\n'
        'if not exist "%~dp0profile" (\r\n'
        '  echo Orbit could not create its profile in this folder.\r\n'
        '  echo Move the extracted folder to a location you can write to.\r\n'
        '  pause\r\n'
        '  exit /b 1\r\n'
        ')\r\n'
        'start "Orbit Prototype" "%~dp0orbit.exe" -no-remote -profile "%~dp0profile" %*\r\n',
        encoding="utf-8", newline="",
    )


def verify_launch_files(package: Path) -> None:
    for name in ("Launch-Orbit.cmd", "START-HERE.txt", "orbit.exe"):
        if not (package / name).is_file():
            raise ValueError(f"Incomplete Orbit download: missing {name}")
    launcher = (package / "Launch-Orbit.cmd").read_text(encoding="utf-8")
    if '"%~dp0orbit.exe" -no-remote -profile "%~dp0profile"' not in launcher:
        raise ValueError("Orbit launcher must use the adjacent executable and an isolated portable profile.")


def verify_delivery_archive(zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path) as archive:
        for name in ("Orbit/Launch-Orbit.cmd", "Orbit/START-HERE.txt", "Orbit/orbit.exe"):
            if name not in archive.namelist() or not archive.getinfo(name).file_size:
                raise ValueError(f"Incomplete Orbit ZIP: missing {name}")
        launcher = archive.read("Orbit/Launch-Orbit.cmd").decode("utf-8")
        if '"%~dp0orbit.exe" -no-remote -profile "%~dp0profile"' not in launcher:
            raise ValueError("The archived launcher does not select Orbit's isolated portable profile.")


def verify_native_package(package: Path) -> None:
    for name in ("orbit.exe", "xul.dll", "application.ini", "omni.ja", "browser/omni.ja"):
        if not (package / name).is_file():
            raise ValueError(f"Incomplete native Firefox package: missing {name}")
    entries: set[str] = set()
    for jar in (package / "omni.ja", package / "browser" / "omni.ja"):
        with zipfile.ZipFile(jar) as archive:
            entries.update(archive.namelist())
    for suffix in ("browser/components/orbit/Orbit.sys.mjs", "orbit/orbit.html", "orbit/orbit.css", "orbit/orbit.js", "orbit/orbit.svg"):
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
    # Firefox's ZIP packaging target stages the complete distribution here. Never package
    # a system Firefox install or an overlay without the rebuilt browser.
    built_package = source / "obj-orbit" / "dist" / "orbit"
    verify_native_package(built_package)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    package = output / "Orbit"
    if package.exists():
        raise ValueError(f"Output already exists; choose a fresh --output directory: {package}")
    shutil.copytree(built_package, package)
    (package / "distribution").mkdir(exist_ok=True)
    shutil.copy2(ROOT / "configs" / "policies.json", package / "distribution" / "policies.json")
    write_launcher(package)
    (package / "START-HERE.txt").write_text(
        "Orbit Prototype — native Firefox frontend fork\n\n"
        "Extract this complete folder to a writable location. Run Launch-Orbit.cmd.\n"
        "Windows may display the launcher as Launch-Orbit without the extension.\n"
        "Launch-Orbit.cmd, START-HERE.txt, and orbit.exe belong in the same folder.\n"
        "The launcher uses a separate profile stored in this folder.\n"
        "Open the Orbit toolbar button or Alt+Shift+O to see the tab canvas.\n"
        "orbit.exe runs Gecko with Orbit's rebuilt native browser interface.\n"
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
    verify_launch_files(package)
    zip_path = output / f"Orbit-Windows-x64-{pin['revision'][:12]}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(package.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(output).as_posix())
    verify_delivery_archive(zip_path)
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    zip_path.with_suffix(".zip.sha256").write_text(f"{digest}  {zip_path.name}\n", encoding="utf-8")
    print(f"Packaged native Orbit: {zip_path}", flush=True)


if __name__ == "__main__":
    main()
