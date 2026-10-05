"""Integrity and rollback checks for incremental native CSS packaging."""

import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import patch_native_css as css
import test_package_update as package_fixture


class NativeCssTests(unittest.TestCase):
    def setUp(self):
        # Reuse the native packaging fixture, including all required modules
        # and branding assets, instead of weakening the production guard.
        fixture = package_fixture.UpdatePackageTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.package, self.root = fixture.package, fixture.root
        self.jars = (self.package / "omni.ja", self.package / "browser/omni.ja")
        self.baseline = {}
        with zipfile.ZipFile(self.jars[1]) as archive:
            for source in css.CSS_PATHS:
                name = "chrome/browser/content/browser/orbit/" + Path(source).name
                self.baseline[source] = css.git_blob_sha(archive.read(name))
                destination = self.root / source
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(f"/* new {Path(source).name} */\n:root {{ --orbit: #70ded3; }}\n", encoding="utf-8")
        (self.package / "profile").mkdir()
        (self.package / "profile/preserved.txt").write_bytes(b"private profile must remain unchanged")

    def archive_bytes(self):
        return [jar.read_bytes() for jar in self.jars]

    def rebuild_fixture(self, jar, transform):
        with zipfile.ZipFile(jar) as archive:
            entries = [(info, archive.read(info)) for info in archive.infolist()]
        with zipfile.ZipFile(jar, "w") as archive:
            for info, raw in transform(entries):
                archive.writestr(info, raw)

    def split_css_across_archives(self):
        name = "chrome/browser/content/browser/orbit/orbit.css"
        with zipfile.ZipFile(self.jars[1]) as archive:
            raw = archive.read(name)
        self.rebuild_fixture(self.jars[1], lambda entries: [(info, raw) for info, raw in entries if info.filename != name])
        with zipfile.ZipFile(self.jars[0], "a") as archive:
            archive.writestr(name, raw)

    def test_valid_update_preserves_other_members_metadata_engine_and_profile(self):
        jar = self.jars[1]
        info = zipfile.ZipInfo("chrome/browser/content/keep.bin", (2020, 2, 3, 4, 5, 6))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100640 << 16
        info.internal_attr = 1
        info.comment = b"retained member comment"
        info.extra = b"\xfe\xca\x02\x00ab"
        with zipfile.ZipFile(jar, "a") as archive:
            archive.comment = b"retained archive comment"
            archive.writestr(info, bytes(range(256)))
        before = {}
        with zipfile.ZipFile(jar) as archive:
            for info in archive.infolist():
                before[info.filename] = (archive.read(info), info)
        untouched = {path: path.read_bytes() for path in self.package.rglob("*") if path.is_file() and path not in self.jars}
        root_archive = self.jars[0].read_bytes()
        self.assertEqual(css.patch_native_css(self.package, self.baseline, self.root), ["browser/omni.ja"])
        self.assertEqual(self.jars[0].read_bytes(), root_archive)
        for path, raw in untouched.items():
            self.assertEqual(path.read_bytes(), raw)
        with zipfile.ZipFile(jar) as archive:
            self.assertEqual(archive.namelist(), list(before))
            self.assertEqual(archive.comment, b"retained archive comment")
            for info in archive.infolist():
                old, metadata = before[info.filename]
                source = next((path for path in css.CSS_PATHS if info.filename.endswith("orbit/" + Path(path).name)), None)
                self.assertEqual(archive.read(info), (self.root / source).read_bytes() if source else old)
                for field in ("date_time", "compress_type", "external_attr", "internal_attr", "comment", "extra", "create_system", "create_version", "extract_version", "volume"):
                    self.assertEqual(getattr(info, field), getattr(metadata, field), (info.filename, field))

    def test_old_css_mismatch_rejects_before_any_archive_change(self):
        self.baseline[css.CSS_PATHS[-1]] = "0" * 40
        before = self.archive_bytes()
        with self.assertRaisesRegex(ValueError, "Git blob mismatch"):
            css.patch_native_css(self.package, self.baseline, self.root)
        self.assertEqual(self.archive_bytes(), before)
        self.assertFalse(list(self.package.rglob("*.orbit-css-*")))

    def test_windows_crlf_old_css_matches_committed_lf_without_changing_new_bytes(self):
        def windows_checkout(entries):
            result = []
            for info, raw in entries:
                source = next((path for path in css.CSS_PATHS if info.filename.endswith("orbit/" + Path(path).name)), None)
                if source:
                    canonical = raw + b"\n:root {\n  --old: 1;\n}\n"
                    self.baseline[source] = css.git_blob_sha(canonical)
                    raw = canonical.replace(b"\n", b"\r\n")
                result.append((info, raw))
            return result
        self.rebuild_fixture(self.jars[1], windows_checkout)
        source = self.root / css.CSS_PATHS[0]
        source.write_bytes(source.read_bytes().replace(b"\n", b"\r\n"))
        with zipfile.ZipFile(self.jars[1]) as archive:
            other = {info.filename: archive.read(info) for info in archive.infolist() if not any(info.filename.endswith("orbit/" + Path(path).name) for path in css.CSS_PATHS)}
        css.patch_native_css(self.package, self.baseline, self.root)
        with zipfile.ZipFile(self.jars[1]) as archive:
            for path in css.CSS_PATHS:
                self.assertEqual(archive.read("chrome/browser/content/browser/orbit/" + Path(path).name), (self.root / path).read_bytes())
            for name, raw in other.items():
                self.assertEqual(archive.read(name), raw)

    def test_lone_cr_or_other_content_changes_are_not_checkout_normalization(self):
        expected = css.git_blob_sha(b"first\nsecond\n")
        self.assertTrue(css.matches_old_css(b"first\r\nsecond\r\n", expected))
        self.assertFalse(css.matches_old_css(b"first\rsecond\r\n", expected))
        self.assertFalse(css.matches_old_css(b"first\r\nchanged\r\n", expected))

    def test_duplicate_css_across_archives_rejects_without_changes(self):
        name = "chrome/browser/content/browser/orbit/orbit.css"
        with zipfile.ZipFile(self.jars[1]) as archive:
            old = archive.read(name)
        with zipfile.ZipFile(self.jars[0], "a") as archive:
            archive.writestr(name, old)
        before = self.archive_bytes()
        with self.assertRaisesRegex(ValueError, "Duplicate Orbit CSS"):
            css.patch_native_css(self.package, self.baseline, self.root)
        self.assertEqual(self.archive_bytes(), before)

    def test_duplicate_zip_member_rejects_without_changes(self):
        name = "chrome/browser/content/browser/orbit/orbit.css"
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.jars[1], "a") as archive:
                archive.writestr(name, b"duplicate")
        before = self.archive_bytes()
        with self.assertRaisesRegex(ValueError, "Duplicate archive resource"):
            css.patch_native_css(self.package, self.baseline, self.root)
        self.assertEqual(self.archive_bytes(), before)

    def test_missing_resource_rejects_without_changes(self):
        self.rebuild_fixture(self.jars[1], lambda entries: [(info, raw) for info, raw in entries if not info.filename.endswith("orbit/orbit-chrome.css")])
        before = self.archive_bytes()
        with self.assertRaisesRegex(ValueError, "orbit-chrome.css"):
            css.patch_native_css(self.package, self.baseline, self.root)
        self.assertEqual(self.archive_bytes(), before)

    def test_invalid_baseline_paths_or_hashes_reject_without_changes(self):
        before = self.archive_bytes()
        for invalid in ({}, {**self.baseline, "../xul.dll": "a" * 40}, {**self.baseline, css.CSS_PATHS[0]: "HEAD"}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                css.patch_native_css(self.package, invalid, self.root)
        self.assertEqual(self.archive_bytes(), before)

    def test_duplicate_json_baseline_path_is_rejected(self):
        path = self.root / "baseline.json"
        key = json.dumps(css.CSS_PATHS[0])
        path.write_text("{" + key + ':"' + "a" * 40 + '",' + key + ':"' + "a" * 40 + '"}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate baseline path"):
            css.load_baseline(path)

    def test_non_utf8_source_rejects_before_any_archive_change(self):
        (self.root / css.CSS_PATHS[-1]).write_bytes(b"\xff")
        before = self.archive_bytes()
        with self.assertRaises(UnicodeDecodeError):
            css.patch_native_css(self.package, self.baseline, self.root)
        self.assertEqual(self.archive_bytes(), before)

    def test_later_archive_replace_failure_rolls_back_exact_originals(self):
        self.split_css_across_archives()
        before = self.archive_bytes()
        original_replace = css.os.replace
        count = 0
        def replace(source, destination):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("simulated later archive replacement failure")
            return original_replace(source, destination)
        with patch.object(css.os, "replace", side_effect=replace):
            with self.assertRaisesRegex(OSError, "later archive"):
                css.patch_native_css(self.package, self.baseline, self.root)
        self.assertEqual(self.archive_bytes(), before)
        self.assertFalse(list(self.package.rglob("*.orbit-css-*")))

    def test_post_package_validation_failure_rolls_back_archives(self):
        before = self.archive_bytes()
        with patch.object(css, "verify_native_package", side_effect=[None, ValueError("post-build verification failure")]):
            with self.assertRaisesRegex(ValueError, "post-build"):
                css.patch_native_css(self.package, self.baseline, self.root)
        self.assertEqual(self.archive_bytes(), before)


if __name__ == "__main__":
    unittest.main()
