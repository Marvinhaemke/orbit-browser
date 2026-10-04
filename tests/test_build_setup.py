"""Guards for applying the native overlay and packaging a rebuilt browser."""

import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


prepare = module("prepare_source")
package = module("package_windows")


class SourceGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / "firefox"
        self.root = self.base / "orbit"
        self.source.mkdir()
        self.root.mkdir()
        self.fixture = json.loads((ROOT / "tests/fixtures/upstream.json").read_text(encoding="utf-8"))
        shutil.copy2(ROOT / "firefox-source.json", self.root / "firefox-source.json")
        (self.root / "configs").mkdir()
        shutil.copy2(ROOT / "configs/mozconfig", self.root / "configs/mozconfig")
        for path, text in self.fixture.items():
            destination = self.source / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(text, encoding="utf-8", newline="\n")
        for path in (
            "browser/components/orbit/Orbit.sys.mjs",
            "browser/components/orbit/moz.build",
            "browser/base/content/orbit/orbit.html",
            "browser/base/content/orbit/orbit.css",
            "browser/base/content/orbit/orbit.js",
        ):
            destination = self.root / "overlay" / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("test overlay\n", encoding="utf-8")

    def pristine_git_show(self, source, *args, **kwargs):
        self.assertEqual(args[0], "show")
        path = args[1].split(":", 1)[1]
        return self.fixture[path]

    def test_fixtures_match_exact_upstream_pin(self):
        pin = prepare.load_pin(self.root)
        self.assertEqual(pin["revision"], pin["artifact_revision"])
        self.assertEqual(set(pin["upstream_modified_files"]), set(self.fixture))
        for path, blob in pin["upstream_modified_files"].items():
            self.assertEqual(prepare.git_blob_hash(self.fixture[path]), blob, path)

    def test_native_registration_and_idempotent_reapply(self):
        prepare.apply_overlay(self.source, self.root)
        first = {path: (self.source / path).read_bytes() for path in self.fixture}
        with patch.object(prepare, "run_git", side_effect=self.pristine_git_show):
            prepare.apply_overlay(self.source, self.root)
        second = {path: (self.source / path).read_bytes() for path in self.fixture}
        self.assertEqual(first, second)
        manifest = (self.source / "browser/components/BrowserComponents.manifest").read_text(encoding="utf-8")
        self.assertEqual(manifest.count("Orbit.init"), 1)
        self.assertEqual(manifest.count("Orbit.uninit"), 1)
        self.assertIn('    "orbit",', (self.source / "browser/components/moz.build").read_text(encoding="utf-8"))
        self.assertIn("content/browser/orbit/orbit.html", (self.source / "browser/base/jar.mn").read_text(encoding="utf-8"))

    def test_upstream_drift_aborts_without_partial_writes(self):
        drift_path = "browser/base/jar.mn"
        (self.source / drift_path).write_text(self.fixture[drift_path] + "# Unexpected upstream change\n", encoding="utf-8")
        before = {path: (self.source / path).read_bytes() for path in self.fixture}
        with patch.object(prepare, "run_git", side_effect=self.pristine_git_show):
            with self.assertRaisesRegex(ValueError, "Unexpected upstream"):
                prepare.apply_overlay(self.source, self.root)
        self.assertEqual(before, {path: (self.source / path).read_bytes() for path in self.fixture})
        self.assertFalse((self.source / ".orbit-source.json").exists())

    def test_missing_overlay_aborts_before_upstream_edits(self):
        (self.root / "overlay/browser/components/orbit/Orbit.sys.mjs").unlink()
        with self.assertRaisesRegex(ValueError, "Missing required native overlay"):
            prepare.apply_overlay(self.source, self.root)
        for path, text in self.fixture.items():
            self.assertEqual((self.source / path).read_text(encoding="utf-8"), text)

    def test_mozilla_update_policy_is_enforced(self):
        policy = json.loads((ROOT / "configs/policies.json").read_text(encoding="utf-8"))
        self.assertIs(policy["policies"]["DisableAppUpdate"], True)
        modified_prefs = prepare.transform("browser/branding/unofficial/pref/firefox-branding.js", self.fixture["browser/branding/unofficial/pref/firefox-branding.js"])
        self.assertIn('pref("app.update.url", "");', modified_prefs)


class PackageGuardTests(unittest.TestCase):
    def test_unmodified_firefox_distribution_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "browser").mkdir()
            for name in ("firefox.exe", "xul.dll"):
                (folder / name).write_bytes(b"fixture")
            (folder / "application.ini").write_text("[App]\nName=Firefox\n", encoding="utf-8")
            for name in ("omni.ja", "browser/omni.ja"):
                with zipfile.ZipFile(folder / name, "w") as archive:
                    archive.writestr("ordinary-firefox-resource", "fixture")
            with self.assertRaisesRegex(ValueError, "Orbit resource"):
                package.verify_native_package(folder)


if __name__ == "__main__":
    unittest.main()
