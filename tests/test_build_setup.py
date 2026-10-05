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
            "browser/components/orbit/OrbitRadial.sys.mjs",
            "browser/components/orbit/OrbitRadialView.sys.mjs",
            "browser/components/orbit/OrbitRadialChild.sys.mjs",
            "browser/components/orbit/OrbitRadialParent.sys.mjs",
            "browser/components/orbit/OrbitTheme.sys.mjs",
            "browser/components/orbit/moz.build",
            "browser/base/content/orbit/orbit.html",
            "browser/base/content/orbit/orbit.css",
            "browser/base/content/orbit/orbit.js",
            "browser/base/content/orbit/orbit.svg",
            "browser/base/content/orbit/orbit-radial.css",
            "browser/base/content/orbit/orbit-chrome.css",
            "browser/branding/unofficial/content/about-logo.svg",
            "browser/branding/unofficial/content/about-wordmark.svg",
            "browser/branding/unofficial/content/firefox-wordmark.svg",
            "browser/branding/unofficial/content/aboutDialog.css",
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
        self.assertIn("content/browser/orbit/orbit.svg", (self.source / "browser/base/jar.mn").read_text(encoding="utf-8"))
        self.assertIn("content/browser/orbit/orbit-radial.css (content/orbit/orbit-radial.css)", (self.source / "browser/base/jar.mn").read_text(encoding="utf-8"))
        self.assertIn("content/browser/orbit/orbit-chrome.css", (self.source / "browser/base/jar.mn").read_text(encoding="utf-8"))
        for name in ("OrbitRadial.sys.mjs", "OrbitRadialView.sys.mjs", "OrbitRadialChild.sys.mjs", "OrbitRadialParent.sys.mjs", "OrbitTheme.sys.mjs"):
            self.assertEqual((self.source / "browser/components/orbit" / name).read_text(encoding="utf-8"), "test overlay\n")

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

    def test_missing_radial_resource_aborts_before_upstream_edits(self):
        for path in (
            "browser/components/orbit/OrbitRadial.sys.mjs",
            "browser/components/orbit/OrbitRadialView.sys.mjs",
            "browser/components/orbit/OrbitRadialChild.sys.mjs",
            "browser/components/orbit/OrbitRadialParent.sys.mjs",
            "browser/components/orbit/OrbitTheme.sys.mjs",
            "browser/base/content/orbit/orbit-radial.css",
            "browser/base/content/orbit/orbit-chrome.css",
        ):
            with self.subTest(path=path):
                resource = self.root / "overlay" / path
                original = resource.read_bytes()
                resource.unlink()
                with self.assertRaisesRegex(ValueError, "Missing required native overlay"):
                    prepare.apply_overlay(self.source, self.root)
                self.assertEqual({path: (self.source / path).read_text(encoding="utf-8") for path in self.fixture}, self.fixture)
                resource.write_bytes(original)

    def test_mozilla_update_policy_is_enforced(self):
        policy = json.loads((ROOT / "configs/policies.json").read_text(encoding="utf-8"))
        self.assertIs(policy["policies"]["DisableAppUpdate"], True)
        modified_prefs = prepare.transform("browser/branding/unofficial/pref/firefox-branding.js", self.fixture["browser/branding/unofficial/pref/firefox-branding.js"])
        self.assertIn('pref("app.update.url", "");', modified_prefs)


class PackageGuardTests(unittest.TestCase):
    def native_fixture(self, folder, omitted=None):
        (folder / "browser").mkdir(parents=True)
        for name in ("orbit.exe", "xul.dll"):
            (folder / name).write_bytes(b"native-package-test-fixture")
        (folder / "application.ini").write_text("[App]\nName=Orbit\n", encoding="utf-8")
        with zipfile.ZipFile(folder / "omni.ja", "w") as archive:
            for name in ("Orbit.sys.mjs", "OrbitRadial.sys.mjs", "OrbitRadialView.sys.mjs", "OrbitRadialChild.sys.mjs", "OrbitRadialParent.sys.mjs", "OrbitTheme.sys.mjs"):
                if name != omitted:
                    archive.writestr(f"moz-src/browser/components/orbit/{name}", "fixture")
        with zipfile.ZipFile(folder / "browser/omni.ja", "w") as archive:
            for name in ("orbit.html", "orbit.css", "orbit.js", "orbit.svg", "orbit-radial.css", "orbit-chrome.css"):
                if name != omitted:
                    archive.writestr(f"chrome/browser/content/browser/orbit/{name}", "fixture")
            for name in ("about-logo.svg", "about-wordmark.svg", "firefox-wordmark.svg", "aboutDialog.css"):
                if name != omitted:
                    archive.writestr(f"chrome/browser/content/branding/{name}", "fixture")

    def test_package_without_a_required_radial_resource_is_rejected(self):
        for name in ("OrbitRadial.sys.mjs", "OrbitRadialView.sys.mjs", "OrbitRadialChild.sys.mjs", "OrbitRadialParent.sys.mjs", "OrbitTheme.sys.mjs", "orbit-radial.css", "orbit-chrome.css", "about-logo.svg"):
            with self.subTest(resource=name), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                self.native_fixture(folder, omitted=name)
                with self.assertRaisesRegex(ValueError, "Native Orbit resource was not built"):
                    package.verify_native_package(folder)

    def test_complete_download_has_launcher_next_to_executable_and_isolated_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            self.native_fixture(source / "obj-orbit/dist/orbit")
            output = Path(directory) / "download"
            with patch("sys.argv", ["package_windows.py", "--source", str(source), "--output", str(output)]):
                package.main()
            folder = output / "Orbit"
            package.verify_launch_files(folder)
            self.assertFalse((folder / "profile").exists(), "A personal browser profile must not be shipped")
            archives = list(output.glob("Orbit-Windows-x64-*.zip"))
            self.assertEqual(len(archives), 1)
            package.verify_delivery_archive(archives[0])
            extracted = Path(directory) / "extracted"
            with zipfile.ZipFile(archives[0]) as archive:
                archive.extractall(extracted)
            package.verify_launch_files(extracted / "Orbit")
            launcher = (extracted / "Orbit/Launch-Orbit.cmd").read_text(encoding="utf-8")
            self.assertIn('mkdir "%~dp0profile"', launcher)
            self.assertIn('-profile "%~dp0profile"', launcher)
            self.assertIn('-no-remote', launcher)
            self.assertNotIn("%APPDATA%", launcher)
            policies = json.loads((extracted / "Orbit/distribution/policies.json").read_text(encoding="utf-8"))
            self.assertIs(policies["policies"]["DisableAppUpdate"], True)

    def test_archive_without_launcher_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            zip_path = Path(directory) / "incomplete.zip"
            with zipfile.ZipFile(zip_path, "w") as archive:
                archive.writestr("Orbit/orbit.exe", "native-package-test-fixture")
                archive.writestr("Orbit/START-HERE.txt", "fixture")
            with self.assertRaisesRegex(ValueError, "missing Orbit/Launch-Orbit.cmd"):
                package.verify_delivery_archive(zip_path)

    def test_launcher_target_and_profile_cannot_fall_back_to_system_firefox(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "orbit.exe").write_bytes(b"native-package-test-fixture")
            (folder / "START-HERE.txt").write_text("fixture", encoding="utf-8")
            (folder / "Launch-Orbit.cmd").write_text('start "" firefox.exe\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "adjacent executable.*isolated portable profile"):
                package.verify_launch_files(folder)

    def test_unmodified_firefox_distribution_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "browser").mkdir()
            for name in ("orbit.exe", "xul.dll"):
                (folder / name).write_bytes(b"fixture")
            (folder / "application.ini").write_text("[App]\nName=Firefox\n", encoding="utf-8")
            for name in ("omni.ja", "browser/omni.ja"):
                with zipfile.ZipFile(folder / name, "w") as archive:
                    archive.writestr("ordinary-firefox-resource", "fixture")
            with self.assertRaisesRegex(ValueError, "Orbit resource"):
                package.verify_native_package(folder)


if __name__ == "__main__":
    unittest.main()
