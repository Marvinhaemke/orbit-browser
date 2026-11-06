"""Checks for the Windows installer build (scripts/package_installer.py, installer/orbit.nsi)."""

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("orbit_package_installer", ROOT / "scripts/package_installer.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
import package_windows  # noqa: E402

SCRIPT = (ROOT / "installer/orbit.nsi").read_text(encoding="utf-8")


def make_package(package: Path) -> None:
    """A minimal packaged browser that passes the native and launcher checks."""
    (package / "browser").mkdir(parents=True)
    for name in ("orbit.exe", "xul.dll"):
        (package / name).write_bytes(b"native engine fixture " + name.encode())
    (package / "application.ini").write_text("[App]\nVendor=Mozilla\nName=Orbit\n", encoding="utf-8")
    with zipfile.ZipFile(package / "omni.ja", "w") as archive:
        for name in ("Orbit", "OrbitRadial", "OrbitRadialView", "OrbitRadialChild", "OrbitRadialParent",
                     "OrbitTheme", "OrbitInteractions", "OrbitFocusTools"):
            archive.writestr(f"moz-src/browser/components/orbit/{name}.sys.mjs", "module fixture")
    with zipfile.ZipFile(package / "browser/omni.ja", "w") as archive:
        for name in ("orbit.html", "orbit.css", "orbit.js", "orbit.svg", "orbit-radial.css",
                     "orbit-chrome.css", "orbit-interactions.css", "orbit-commands.svg"):
            archive.writestr(f"chrome/browser/content/browser/orbit/{name}", "resource fixture")
        for name in ("about-logo.svg", "about-wordmark.svg", "firefox-wordmark.svg", "aboutDialog.css"):
            archive.writestr(f"chrome/browser/content/branding/{name}", "branding fixture")
    package_windows.write_launcher(package)
    (package / "START-HERE.txt").write_text("portable instructions", encoding="utf-8")
    (package / "firefox-source.json").write_text(json.dumps({"revision": "a" * 40}), encoding="utf-8")
    for name in ("Update-Orbit.cmd", "Update-Orbit.ps1"):
        shutil.copy2(ROOT / "scripts/windows" / name, package / name)


class InstallerVersionTests(unittest.TestCase):
    def test_explicit_version_is_used(self):
        self.assertEqual(installer.installer_version("1.2.3", {}), "1.2.3")

    def test_ci_run_number_gives_increasing_versions(self):
        self.assertEqual(installer.installer_version(None, {"GITHUB_RUN_NUMBER": "57"}), "0.1.57")
        self.assertEqual(installer.installer_version(None, {}), "0.1.0")
        self.assertEqual(installer.installer_version(None, {"GITHUB_RUN_NUMBER": "not-a-number"}), "0.1.0")

    def test_malformed_or_oversized_versions_are_rejected(self):
        for value in ("1.2", "1.2.3.4", "01.2.3", "1.2.x", "70000.0.0", "0.1.65536"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                installer.installer_version(value, {})
        self.assertEqual(installer.installer_version("0.1.65535", {}), "0.1.65535")


class InstallerScriptTests(unittest.TestCase):
    def test_installs_per_user_without_elevation(self):
        self.assertIn("RequestExecutionLevel user", SCRIPT)
        self.assertIn('InstallDir "$LOCALAPPDATA\\Programs\\Orbit"', SCRIPT)
        self.assertNotIn("HKLM", SCRIPT)

    def test_updater_ignores_the_installer_state_folder(self):
        state = re.search(r'!define ORBIT_STATE_DIR "([^"]+)"', SCRIPT).group(1)
        self.assertEqual(state, ".orbit-install")
        updater = (ROOT / "scripts/windows/Update-Orbit.ps1").read_text(encoding="utf-8")
        skip = re.search(r"if \(\$relative -match '([^']+)'\) \{ continue \}", updater).group(1)
        self.assertRegex(f"{state}/Uninstall Orbit.exe", skip)
        self.assertRegex("profile/prefs.js", skip)
        self.assertNotRegex("orbit.exe", skip)
        self.assertNotRegex("uninstall/helper.exe", skip)

    def test_program_file_cleanup_keeps_profile_and_installer_state(self):
        cleanup = SCRIPT.split("Function ${PREFIX}RemoveProgramFiles", 1)[1].split("FunctionEnd", 1)[0]
        self.assertIn('${AndIf} $2 != "profile"', cleanup)
        self.assertIn('${AndIf} $2 != "${ORBIT_STATE_DIR}"', cleanup)
        # Program files are only replaced in a folder that already holds Orbit.
        section = SCRIPT.split('Section "Orbit" SecOrbit', 1)[1].split("SectionEnd", 1)[0]
        self.assertLess(section.index("Call CheckInstallDirectory"), section.index("Call RemoveProgramFiles"))
        self.assertIn('${If} ${FileExists} "$INSTDIR\\application.ini"', section)
        self.assertLess(section.index("Call EnsureOrbitClosed"), section.index("File /r"))

    def test_uninstaller_keeps_profile_unless_asked(self):
        uninstall = SCRIPT.split('Section "Uninstall"', 1)[1].split("SectionEnd", 1)[0]
        self.assertIn("/SD IDNO IDNO keep_profile", uninstall)
        self.assertIn('RMDir "$OrbitRoot"', uninstall)
        self.assertNotIn('RMDir /r "$OrbitRoot"\n', uninstall)
        self.assertIn('${If} $0 != "${ORBIT_STATE_DIR}"', SCRIPT.split("Function un.onInit", 1)[1])

    def test_shortcuts_open_the_installed_profile(self):
        for line in [line for line in SCRIPT.splitlines() if "CreateShortcut" in line and "orbit.exe" in line]:
            self.assertIn('"$INSTDIR\\orbit.exe" \'-profile "$INSTDIR\\profile"\'', line)
        self.assertIn('Exec \'"$INSTDIR\\orbit.exe" -profile "$INSTDIR\\profile"\'', SCRIPT)

    def test_never_edits_a_gecko_profile_list(self):
        # orbit.exe is Mozilla's prebuilt binary, so Gecko's profile list for
        # starts without -profile is the person's Firefox list.
        self.assertNotIn("profiles.ini", SCRIPT)
        self.assertNotIn("installs.ini", SCRIPT)
        self.assertNotIn("$APPDATA", SCRIPT)


class InstallerBuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.package = self.base / "Orbit package"
        make_package(self.package)

    def test_incomplete_package_is_rejected_before_makensis_runs(self):
        (self.package / "Update-Orbit.ps1").unlink()
        with self.assertRaisesRegex(ValueError, "missing Update-Orbit.ps1"):
            installer.build_installer(self.package, self.base / "out", "0.1.0", str(self.base / "no-makensis"))
        self.assertFalse((self.base / "out" / installer.INSTALLER_NAME).exists())

    def test_non_installer_output_is_rejected(self):
        fake = self.base / "fake.exe"
        fake.write_bytes(b"MZ" + b"\0" * 70000)
        with self.assertRaisesRegex(ValueError, "complete NSIS installer"):
            installer.verify_installer(fake)

    @unittest.skipUnless(shutil.which("makensis") or any(Path(p).is_file() for p in installer.WINDOWS_MAKENSIS),
                         "NSIS is not installed")
    def test_builds_installer_and_checksum(self):
        output = self.base / "out"
        result = installer.build_installer(self.package, output, "0.1.9", installer.find_makensis())
        self.assertEqual(result, output.resolve() / "Orbit-Setup.exe")
        raw = result.read_bytes()
        installer.verify_installer(result)
        self.assertEqual((output / "Orbit-Setup.exe.sha256").read_text(encoding="utf-8"),
                         f"{hashlib.sha256(raw).hexdigest()}  Orbit-Setup.exe\n")
        # Version resource, UTF-16LE as Windows stores it.
        self.assertIn("0.1.9".encode("utf-16-le"), raw)


if __name__ == "__main__":
    unittest.main()
