"""Contract and privacy checks for the frontend-only Windows update bundle."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("orbit_package_update", ROOT / "scripts/package_update.py")
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class UpdatePackageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "repo"
        self.package = self.base / "Orbit"
        self.output = self.base / "update"
        (self.root / "scripts/windows").mkdir(parents=True)
        (self.package / "browser").mkdir(parents=True)
        (self.package / "uninstall").mkdir()
        (self.package / "uninstall/helper.exe").write_bytes(b"per-build uninstall helper fixture")
        (self.package / "maintenanceservice_installer.exe").write_bytes(b"per-build maintenance installer fixture")
        self.pin = {"revision": "a" * 40, "artifact_revision": "a" * 40}
        for directory in (self.root, self.package):
            (directory / "firefox-source.json").write_text(json.dumps(self.pin), encoding="utf-8")
        for name in ("orbit.exe", "xul.dll", "extra.exe", "extra.dll"):
            (self.package / name).write_bytes(b"pinned-native-engine-fixture:" + name.encode())
        (self.package / "platform.ini").write_text("[Build]\nBuildID=20260101010101\n", encoding="utf-8")
        (self.package / "application.ini").write_text("[App]\nName=Orbit\nBuildID=20260102020202\n", encoding="utf-8")
        with zipfile.ZipFile(self.package / "omni.ja", "w") as archive:
            for name in ("Orbit.sys.mjs", "OrbitRadial.sys.mjs", "OrbitRadialView.sys.mjs", "OrbitRadialChild.sys.mjs", "OrbitRadialParent.sys.mjs", "OrbitTheme.sys.mjs", "OrbitInteractions.sys.mjs", "OrbitFocusTools.sys.mjs"):
                archive.writestr(f"moz-src/browser/components/orbit/{name}", "native Orbit module fixture")
        with zipfile.ZipFile(self.package / "browser/omni.ja", "w") as archive:
            for name in ("orbit.html", "orbit.css", "orbit.js", "orbit.svg", "orbit-radial.css", "orbit-chrome.css", "orbit-interactions.css", "orbit-commands.svg"):
                archive.writestr(f"chrome/browser/content/browser/orbit/{name}", f"native {name} fixture")
            for name in ("about-logo.svg", "about-wordmark.svg", "firefox-wordmark.svg", "aboutDialog.css"):
                archive.writestr(f"chrome/browser/content/branding/{name}", "Orbit branding fixture")
        for name in update.SETUP_PATHS:
            (self.root / "scripts/windows" / name).write_text(f"updater fixture: {name}\n", encoding="utf-8")

    def build(self):
        return update.build_update(self.package, self.output, "b" * 40, root=self.root)

    def test_update_contains_only_two_archives_and_correct_hash_manifest(self):
        manifest = self.build()
        stored = json.loads((self.output / update.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(manifest, stored)
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["platform"], "windows-x64")
        self.assertEqual(manifest["commit"], "b" * 40)
        self.assertEqual(manifest["revision"], "a" * 40)
        self.assertEqual(manifest["artifact_revision"], "a" * 40)
        self.assertEqual([record["path"] for record in manifest["engine_files"]], ["extra.dll", "extra.exe", "orbit.exe", "xul.dll"])
        self.assertEqual([record["path"] for record in manifest["files"]], list(update.PAYLOAD_PATHS))
        for record in manifest["engine_files"] + manifest["files"]:
            raw = (self.package / record["path"]).read_bytes()
            self.assertEqual(record["size"], len(raw))
            self.assertEqual(record["sha256"], hashlib.sha256(raw).hexdigest())
        with zipfile.ZipFile(self.output / update.UPDATE_NAME) as archive:
            self.assertEqual(archive.namelist(), ["omni.ja", "browser/omni.ja"])
            self.assertNotIn("application.ini", archive.namelist())
            self.assertNotIn("platform.ini", archive.namelist())
            for name in archive.namelist():
                self.assertEqual(archive.read(name), (self.package / name).read_bytes())
        raw_zip = (self.output / update.UPDATE_NAME).read_bytes()
        self.assertEqual(manifest["package"], {"name": update.UPDATE_NAME, "sha256": hashlib.sha256(raw_zip).hexdigest(), "size": len(raw_zip)})

    def test_bootstrap_is_separate_and_contains_only_updater_scripts(self):
        self.build()
        with zipfile.ZipFile(self.output / update.SETUP_NAME) as archive:
            self.assertEqual(archive.namelist(), ["Update-Orbit.cmd", "Update-Orbit.ps1"])
            for name in archive.namelist():
                self.assertEqual(archive.read(name), (self.root / "scripts/windows" / name).read_bytes())

    def test_invalid_revision_or_commit_is_rejected(self):
        (self.root / "firefox-source.json").write_text(json.dumps({"revision": "main", "artifact_revision": "a" * 40}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "exact 40-character"):
            self.build()
        (self.root / "firefox-source.json").write_text(json.dumps(self.pin), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "exact 40-character"):
            update.build_update(self.package, self.output, "HEAD", root=self.root)
        self.assertFalse(self.output.exists())

    def test_mismatching_engine_pin_is_rejected(self):
        (self.package / "firefox-source.json").write_text(json.dumps({"revision": "c" * 40, "artifact_revision": "c" * 40}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_missing_payload_or_native_engine_file_is_rejected(self):
        for name in ("browser/omni.ja", "orbit.exe", "xul.dll"):
            path = self.package / name
            raw = path.read_bytes()
            path.unlink()
            with self.assertRaises((ValueError, FileNotFoundError)):
                self.build()
            path.write_bytes(raw)
        self.assertFalse(self.output.exists())

    def test_update_without_native_radial_resources_is_rejected_before_publication(self):
        jar = self.package / "browser/omni.ja"
        with zipfile.ZipFile(jar) as archive:
            contents = {name: archive.read(name) for name in archive.namelist() if not name.endswith("orbit-radial.css")}
        with zipfile.ZipFile(jar, "w") as archive:
            for name, data in contents.items():
                archive.writestr(name, data)
        with self.assertRaisesRegex(ValueError, "orbit-radial.css"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_build_timestamp_metadata_does_not_change_engine_fingerprint(self):
        original = self.build()["engine_files"]
        (self.package / "platform.ini").write_text("[Build]\nBuildID=20991231235959\n", encoding="utf-8")
        (self.package / "application.ini").write_text("[App]\nName=Orbit\nBuildID=20991231235959\n", encoding="utf-8")
        rebuilt = self.build()["engine_files"]
        self.assertEqual(original, rebuilt)
        self.assertNotIn("application.ini", [record["path"] for record in rebuilt])
        self.assertNotIn("platform.ini", [record["path"] for record in rebuilt])

    def test_rebuilt_uninstall_helper_is_preserved_and_excluded_from_engine_fingerprint(self):
        original = self.build()["engine_files"]
        helper = self.package / "uninstall/helper.exe"
        replacement = b"different NSIS uninstall helper from another frontend build"
        helper.write_bytes(replacement)
        rebuilt = self.build()["engine_files"]
        self.assertEqual(original, rebuilt)
        self.assertNotIn("uninstall/helper.exe", [record["path"] for record in rebuilt])
        self.assertIn("extra.exe", [record["path"] for record in rebuilt])
        with zipfile.ZipFile(self.output / update.UPDATE_NAME) as archive:
            self.assertEqual(archive.namelist(), list(update.PAYLOAD_PATHS))
            self.assertNotIn("uninstall/helper.exe", archive.namelist())
        self.assertEqual(helper.read_bytes(), replacement)

    def test_rebuilt_optional_maintenance_installer_is_preserved_and_not_updated(self):
        original = self.build()["engine_files"]
        installer = self.package / "maintenanceservice_installer.exe"
        replacement = b"new NSIS maintenance installer from a separate frontend build"
        installer.write_bytes(replacement)
        rebuilt = self.build()
        self.assertEqual(rebuilt["engine_files"], original)
        self.assertNotIn("maintenanceservice_installer.exe", [record["path"] for record in rebuilt["engine_files"]])
        with zipfile.ZipFile(self.output / update.UPDATE_NAME) as archive:
            self.assertEqual(archive.namelist(), list(update.PAYLOAD_PATHS))
        self.assertEqual(installer.read_bytes(), replacement)
        installer.unlink()
        self.assertEqual(self.build()["engine_files"], original)

    def test_maintenance_service_and_other_installers_keep_strict_fingerprints(self):
        service = self.package / "maintenanceservice.exe"
        service.write_bytes(b"pinned runtime maintenance service")
        nested = self.package / "other/maintenanceservice_installer.exe"
        nested.parent.mkdir()
        nested.write_bytes(b"an unrelated installer must not be excluded by its basename")
        generic = self.package / "other_installer.exe"
        generic.write_bytes(b"another installer must not receive a wildcard exclusion")
        before = {record["path"]: record for record in self.build()["engine_files"]}
        for path in (service, nested, generic, self.package / "orbit.exe", self.package / "xul.dll"):
            relative = path.relative_to(self.package).as_posix()
            self.assertIn(relative, before)
            path.write_bytes(path.read_bytes() + b" changed")
            after = {record["path"]: record for record in self.build()["engine_files"]}
            self.assertNotEqual(before[relative]["sha256"], after[relative]["sha256"], relative)

    def test_personal_profile_is_rejected_before_engine_file_enumeration(self):
        profile = self.package / "profile"
        profile.mkdir()
        (profile / "private-name.dll").write_bytes(b"personal profile fixture")
        with self.assertRaisesRegex(ValueError, "personal profile"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_symlinked_payload_is_rejected(self):
        target = self.base / "outside.jar"
        payload = self.package / "omni.ja"
        payload.rename(target)
        try:
            payload.symlink_to(target)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"This environment cannot create symlinks: {error}")
        with self.assertRaisesRegex(ValueError, "Symlinks and reparse points"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_output_inside_package_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "outside the native package"):
            update.build_update(self.package, self.package / "updates", "b" * 40, root=self.root)

    def test_missing_updater_script_does_not_publish_partial_manifest(self):
        (self.root / "scripts/windows/Update-Orbit.ps1").unlink()
        with self.assertRaises(FileNotFoundError):
            self.build()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
