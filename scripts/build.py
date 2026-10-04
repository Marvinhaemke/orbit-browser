#!/usr/bin/env python3
"""Bootstrap, build, and package the prepared native Orbit Firefox tree."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / ".upstream-source")
    parser.add_argument("--skip-bootstrap", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve()
    pin = json.loads((ROOT / "firefox-source.json").read_text(encoding="utf-8"))
    prepared = json.loads((source / ".orbit-source.json").read_text(encoding="utf-8"))
    if prepared != pin:
        raise ValueError("Prepared source does not match firefox-source.json; run prepare_source.py first.")
    if os.name == "nt" and not os.environ.get("MOZILLABUILD"):
        raise RuntimeError("On Windows, run this from the MozillaBuild shell (start-shell.bat).")
    env = os.environ.copy()
    env["MOZCONFIG"] = str(source / ".mozconfig")
    # Strict source/engine match: unavailable artifacts cause a build failure,
    # never a fallback to a different Firefox binary version.
    env["MOZ_ARTIFACT_REVISION"] = pin["artifact_revision"]
    env["MACH_HIDE_DEV_DRIVE_SUGGESTION"] = "1"
    env["MACH_TELEMETRY_NO_SUBMIT"] = "1"
    for key in ("MOZ_ARTIFACT_URL", "MOZ_ARTIFACT_FILE", "MOZ_ARTIFACT_TASK"):
        env.pop(key, None)
    base = [sys.executable, str(source / "mach"), "--no-interactive"]
    commands = []
    if not args.skip_bootstrap:
        commands.append(["bootstrap", "--application-choice", "browser_artifact_mode", "--no-system-changes"])
    commands.append(["build"])
    for command in commands:
        print(f"Running mach {' '.join(command)}", flush=True)
        subprocess.run(base + command, cwd=source, env=env, check=True)
    if os.name == "nt":
        # Mozilla's artifact provides firefox.exe. The rebuilt package manifest
        # uses our application name, so include that same engine as orbit.exe.
        native_bin = source / "obj-orbit" / "dist" / "bin"
        shutil.copy2(native_bin / "firefox.exe", native_bin / "orbit.exe")
        # The Windows `package` wrapper also builds an NSIS installer. This
        # supported target stages and compresses the complete portable package.
        package_command = ["build", "--allow-subdirectory-build", "browser/installer/make-package-internal"]
    else:
        package_command = ["package"]
    print(f"Running mach {' '.join(package_command)}", flush=True)
    subprocess.run(base + package_command, cwd=source, env=env, check=True)


if __name__ == "__main__":
    main()
