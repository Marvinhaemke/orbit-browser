#!/usr/bin/env python3
"""Rebuild three existing Orbit CSS resources in a verified native package.

This is an incremental native resource build. Candidate provenance and source
equivalence are checked by CI before this helper; all runtime checks still run.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

from package_windows import verify_native_package

ROOT = Path(__file__).resolve().parents[1]
CSS_PATHS = tuple(
    f"overlay/browser/base/content/orbit/{name}"
    for name in ("orbit.css", "orbit-radial.css", "orbit-chrome.css")
)


def git_blob_sha(raw: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()


def matches_old_css(raw: bytes, expected: str) -> bool:
    if git_blob_sha(raw) == expected:
        return True
    # GitHub returns the committed blob; a Windows native checkout may have
    # expanded its LF line endings before packaging. Candidate provenance
    # separately verifies these exact archive bytes. Allow only that expansion,
    # with no lone CR or other content differences, when checking the Git blob.
    canonical = raw.replace(b"\r\n", b"\n")
    return b"\r" not in canonical and git_blob_sha(canonical) == expected


def validate_baseline(baseline: dict) -> None:
    if not isinstance(baseline, dict) or set(baseline) != set(CSS_PATHS):
        raise ValueError("Baseline must contain exactly the three allowlisted Orbit CSS paths")
    for path, digest in baseline.items():
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{40}", digest):
            raise ValueError(f"Baseline requires an exact lowercase Git blob SHA for {path}")


def load_baseline(path: Path) -> dict:
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate baseline path: {key}")
            result[key] = value
        return result

    baseline = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_keys)
    validate_baseline(baseline)
    return baseline


def adjacent_temp(path: Path, purpose: str) -> Path:
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.orbit-css-{purpose}-", dir=path.parent)
    os.close(descriptor)
    return Path(name)


def patch_native_css(package: Path, baseline: dict, root: Path = ROOT) -> list[str]:
    validate_baseline(baseline)
    verify_native_package(package)
    jars = (package / "omni.ja", package / "browser/omni.ja")
    members = {}
    replacements = {}
    # Read and validate every old resource and every new source before staging
    # or replacing an archive. Never infer an old resource from its filename.
    for jar in jars:
        with zipfile.ZipFile(jar) as archive:
            infos = archive.infolist()
            if len({info.filename for info in infos}) != len(infos):
                raise ValueError(f"Duplicate archive resource in {jar}")
            for source in CSS_PATHS:
                suffix = "orbit/" + Path(source).name
                for info in infos:
                    if info.filename.endswith(suffix):
                        if source in members:
                            raise ValueError(f"Duplicate Orbit CSS resource: {source}")
                        old = archive.read(info)
                        if not matches_old_css(old, baseline[source]):
                            raise ValueError(f"Old CSS Git blob mismatch: {source}")
                        members[source] = (jar, info.filename, old)
    for source in CSS_PATHS:
        if source not in members:
            raise ValueError(f"Missing Orbit CSS resource: {source}")
        current = (root / source).read_bytes()
        current.decode("utf-8")
        jar, name, old = members[source]
        if current != old:
            replacements.setdefault(jar, {})[name] = current

    staged = {}
    backups = {}
    changed = []
    try:
        # Standard ZIP output intentionally removes Firefox's optimized prefix.
        # Member order, compression method, timestamps, attributes, comments,
        # extra fields and every non-CSS uncompressed byte are retained.
        for jar, updates in replacements.items():
            temporary = adjacent_temp(jar, "staged")
            staged[jar] = temporary
            with zipfile.ZipFile(jar) as original, zipfile.ZipFile(temporary, "w") as rebuilt:
                rebuilt.comment = original.comment
                for info in original.infolist():
                    metadata = copy.copy(info)
                    raw = updates.get(info.filename)
                    if raw is None:
                        raw = original.read(info)
                    rebuilt.writestr(metadata, raw)
                    # zipfile supplies default permissions for an all-zero
                    # external_attr; preserve the original central-directory value.
                    metadata.external_attr = info.external_attr
            with zipfile.ZipFile(temporary) as rebuilt:
                if rebuilt.testzip() is not None:
                    raise ValueError(f"Incremental archive failed CRC verification: {jar}")
            backup = adjacent_temp(jar, "original")
            backups[jar] = backup
            shutil.copy2(jar, backup)

        for jar, temporary in staged.items():
            os.replace(temporary, jar)
            changed.append(jar)
        verify_native_package(package)
    except BaseException:
        for jar in reversed(changed):
            os.replace(backups[jar], jar)
        raise
    finally:
        for temporary in (*staged.values(), *backups.values()):
            temporary.unlink(missing_ok=True)
    return [jar.relative_to(package).as_posix() for jar in changed]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    changed = patch_native_css(args.package.resolve(), load_baseline(args.baseline), args.root.resolve())
    print("Rebuilt native Orbit CSS archives: " + (", ".join(changed) or "already current"), flush=True)


if __name__ == "__main__":
    main()
