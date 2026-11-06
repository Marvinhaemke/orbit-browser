#!/usr/bin/env python3
"""Build Orbit-Setup.exe, the per-user Windows installer, from the packaged browser.

The installer wraps the same tested folder as the portable ZIP (artifacts/Orbit).
It needs NSIS 3 (makensis). Version numbers come from --version, otherwise from
the CI run number, so every published installer has a newer version.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from package_windows import verify_launch_files, verify_native_package

ROOT = Path(__file__).resolve().parents[1]
INSTALLER_SCRIPT = ROOT / "installer" / "orbit.nsi"
INSTALLER_NAME = "Orbit-Setup.exe"
VERSION_PATTERN = re.compile(r"(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})")
MAXIMUM_VERSION_PART = 65535  # Windows version resources store 16-bit parts
WINDOWS_MAKENSIS = (
    r"C:\Program Files (x86)\NSIS\makensis.exe",
    r"C:\Program Files\NSIS\makensis.exe",
)


def installer_version(explicit: str | None = None, environ: dict | None = None) -> str:
    """Return a three-part version, from --version or 0.1.<CI run number>."""
    environ = os.environ if environ is None else environ
    version = explicit
    if not version:
        run = environ.get("GITHUB_RUN_NUMBER", "")
        version = f"0.1.{run}" if run.isdigit() else "0.1.0"
    if not VERSION_PATTERN.fullmatch(version) or any(int(part) > MAXIMUM_VERSION_PART for part in version.split(".")):
        raise ValueError(f"Installer version must look like 1.2.3, each part at most {MAXIMUM_VERSION_PART}: {version}")
    return version


def find_makensis(explicit: str | None = None) -> str:
    candidates = [explicit, os.environ.get("ORBIT_MAKENSIS"), shutil.which("makensis")]
    candidates += list(WINDOWS_MAKENSIS) if os.name == "nt" else []
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    raise FileNotFoundError("makensis (NSIS 3) was not found. Install NSIS or pass --makensis.")


def verify_installer(path: Path) -> None:
    raw = path.read_bytes()
    if len(raw) < 64 * 1024 or not raw.startswith(b"MZ") or b"NullsoftInst" not in raw:
        raise ValueError(f"makensis did not produce a complete NSIS installer: {path}")


def build_installer(package: Path, output: Path, version: str, makensis: str) -> Path:
    package = package.resolve()
    verify_native_package(package)
    verify_launch_files(package)
    for name in ("Update-Orbit.cmd", "Update-Orbit.ps1", "firefox-source.json"):
        if not (package / name).is_file():
            raise ValueError(f"Incomplete Orbit package for the installer: missing {name}")
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    installer = output / INSTALLER_NAME
    if installer.exists():
        installer.unlink()
    command = [
        makensis,
        "-V2",
        "-INPUTCHARSET", "UTF8",
        f"-DORBIT_SOURCE={package}",
        f"-DORBIT_OUTPUT={installer}",
        f"-DORBIT_VERSION={version}",
        f"-DORBIT_FILE_VERSION={version}.0",
        str(INSTALLER_SCRIPT),
    ]
    subprocess.run(command, check=True)
    verify_installer(installer)
    digest = hashlib.sha256(installer.read_bytes()).hexdigest()
    installer.with_name(installer.name + ".sha256").write_text(f"{digest}  {installer.name}\n", encoding="utf-8")
    return installer


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, default=ROOT / "artifacts" / "Orbit")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts" / "installer")
    parser.add_argument("--version", help="Installer version, for example 0.1.42")
    parser.add_argument("--makensis", help="Path to makensis")
    args = parser.parse_args()
    version = installer_version(args.version)
    installer = build_installer(args.package, args.output, version, find_makensis(args.makensis))
    print(f"Built Orbit {version} installer: {installer}", flush=True)


if __name__ == "__main__":
    main()
