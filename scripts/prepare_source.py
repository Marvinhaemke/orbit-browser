#!/usr/bin/env python3
"""Fetch one pinned Firefox revision and apply Orbit's native source overlay.

Uses native upstream Git hashes, including for MOZ_ARTIFACT_REVISION. This source
revision supports those hashes directly in mozbuild/artifacts.py. No extension,
installed Firefox, guessed release URL, or approximate Gecko revision is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def load_pin(root: Path = ROOT) -> dict:
    return json.loads((root / "firefox-source.json").read_text(encoding="utf-8"))


def run_git(source: Path, *args: str, capture: bool = False) -> str:
    result = subprocess.run(
        ["git", "-c", "core.longpaths=true", "-C", str(source), *args],
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout if capture else ""


def fetch_source(source: Path, pin: dict) -> None:
    if " " in str(source):
        raise ValueError("Firefox's source path must not contain spaces.")
    source.mkdir(parents=True, exist_ok=True)
    if not (source / ".git").exists():
        if any(source.iterdir()):
            raise ValueError(f"Refusing to initialize a non-empty source directory: {source}")
        run_git(source, "init")
        run_git(source, "config", "core.autocrlf", "false")
        run_git(source, "remote", "add", "origin", pin["repository"])
        # One commit is enough because artifact_revision is an exact native Git
        # hash. Never download all Firefox history for this frontend prototype.
        run_git(source, "fetch", "--no-tags", "--depth=1", "origin", pin["revision"])
        run_git(source, "checkout", "--detach", "FETCH_HEAD")
    head = run_git(source, "rev-parse", "HEAD", capture=True).strip()
    if head != pin["revision"]:
        raise ValueError(
            f"Source is at {head}, expected {pin['revision']}. "
            "Choose a fresh --source directory; existing checkouts are not reset."
        )


def git_blob_hash(text: str) -> str:
    raw = text.encode("utf-8")
    return hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()


def transform(path: str, original: str) -> str:
    """Small native registration/branding changes, reviewed against the pin."""
    if path == "browser/components/moz.build":
        return original.replace('    "originattributes",\n', '    "orbit",\n    "originattributes",\n', 1)
    if path == "browser/components/BrowserComponents.manifest":
        return original + (
            "\n# Orbit native browser-window integration\n"
            "category browser-window-delayed-startup moz-src:///browser/components/orbit/Orbit.sys.mjs Orbit.init\n"
            "category browser-window-unload-delayed-startup moz-src:///browser/components/orbit/Orbit.sys.mjs Orbit.uninit\n"
        )
    if path == "browser/base/jar.mn":
        return original.replace(
            "%  content browser %content/browser/ contentaccessible=yes\n",
            "%  content browser %content/browser/ contentaccessible=yes\n\n"
            "        content/browser/orbit/orbit.html (content/orbit/orbit.html)\n"
            "        content/browser/orbit/orbit.css  (content/orbit/orbit.css)\n"
            "        content/browser/orbit/orbit.js   (content/orbit/orbit.js)\n",
            1,
        )
    if path == "browser/branding/unofficial/configure.sh":
        return original.replace("MOZ_APP_DISPLAYNAME=Nightly", "MOZ_APP_DISPLAYNAME='Orbit Prototype'").replace(
            "MOZ_MACBUNDLE_ID=nightlyunofficial", "MOZ_MACBUNDLE_ID=io.orbitbrowser.prototype"
        )
    if path == "browser/branding/unofficial/locales/en-US/brand.ftl":
        return original.replace(" = Nightly", " = Orbit Prototype").replace(
            "-brand-product-name = Firefox", "-brand-product-name = Orbit"
        ).replace("-vendor-short-name = Mozilla", "-vendor-short-name = Orbit")
    if path == "browser/branding/unofficial/locales/en-US/brand.properties":
        return original.replace("=Nightly", "=Orbit Prototype")
    if path == "browser/branding/unofficial/pref/firefox-branding.js":
        return original + (
            "\n// Orbit prototypes are updated only by rebuilding this fork.\n"
            'pref("app.update.url", "");\n'
            'pref("app.update.url.manual", "https://github.com/Marvinhaemke/orbit-browser/actions");\n'
            'pref("app.update.url.details", "https://github.com/Marvinhaemke/orbit-browser");\n'
            'pref("app.update.auto", false);\n'
            'pref("browser.shell.checkDefaultBrowser", false);\n'
            'pref("browser.tabs.splitView.enabled", true);\n'
            'pref("browser.startup.page", 3);\n'
        )
    raise ValueError(f"No reviewed transform for {path}")


def apply_overlay(source: Path, root: Path = ROOT) -> None:
    pin = load_pin(root)
    pending: list[tuple[Path, str]] = []
    # Validate every touched upstream file before changing any file. Re-running
    # is safe, but changed upstream or manually edited parent files fail closed.
    for path, expected_blob in pin["upstream_modified_files"].items():
        destination = source / path
        original = destination.read_text(encoding="utf-8")
        if git_blob_hash(original) == expected_blob:
            changed = transform(path, original)
            if changed == original:
                raise ValueError(f"Registration anchor disappeared: {path}")
        else:
            # Obtain the pristine pinned text locally, without network, to
            # distinguish an idempotent reapply from upstream drift.
            pristine = run_git(source, "show", f"{pin['revision']}:{path}", capture=True)
            if git_blob_hash(pristine) != expected_blob or original != transform(path, pristine):
                raise ValueError(f"Unexpected upstream change or local edit in {path}; no files were changed.")
            changed = original
        pending.append((destination, changed))

    overlay = root / "overlay"
    required = [
        "browser/components/orbit/Orbit.sys.mjs",
        "browser/components/orbit/moz.build",
        "browser/base/content/orbit/orbit.html",
        "browser/base/content/orbit/orbit.css",
        "browser/base/content/orbit/orbit.js",
    ]
    for path in required:
        if not (overlay / path).is_file():
            raise ValueError(f"Missing required native overlay file: {path}")

    for destination, changed in pending:
        destination.write_text(changed, encoding="utf-8", newline="\n")
    for origin in sorted(overlay.rglob("*")):
        if origin.is_file():
            destination = source / origin.relative_to(overlay)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(origin, destination)
    shutil.copy2(root / "configs" / "mozconfig", source / ".mozconfig")
    (source / ".orbit-source.json").write_text(json.dumps(pin, indent=2) + "\n", encoding="utf-8")
    print(f"Orbit native UI applied to Firefox {pin['revision']} at {source}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / ".upstream-source")
    parser.add_argument("--apply-only", action="store_true", help="Apply to an already checked-out pinned source.")
    args = parser.parse_args()
    source = args.source.resolve()
    pin = load_pin()
    if not args.apply_only:
        fetch_source(source, pin)
    elif run_git(source, "rev-parse", "HEAD", capture=True).strip() != pin["revision"]:
        raise ValueError("--apply-only requires the exact pinned source revision.")
    apply_overlay(source)


if __name__ == "__main__":
    main()
