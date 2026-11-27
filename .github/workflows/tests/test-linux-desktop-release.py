"""Native Linux desktop workflow contracts, independent of a cross-build.

FastAF's desktop matrix is macOS ARM64, Windows x64 and Linux x64 on
ubuntu-24.04. Upstream also builds Linux ARM64 on ubuntu-22.04-arm; FastAF does
not (ONNX Runtime needs the 24.04 glibc), so these contracts cover the x64 leg
and assert that no ARM64 leg or updater target is expected.
"""
from pathlib import Path
import unittest
import importlib.util
import json
import tempfile
from contextlib import redirect_stdout
import io
import copy

ROOT = Path(__file__).resolve().parents[3]


class LinuxDesktopRelease(unittest.TestCase):
    def test_linux_x64_builds_on_2404_with_vulkan_and_no_arm64_leg(self):
        # Catches: a 22.04 runner (ort cannot link), a build without the vulkan
        # feature, a missing Vulkan SDK, or an untested ARM64 leg that
        # finalize-release would wait for.
        for name in ("release", "nightly"):
            with self.subTest(workflow=name):
                source = (ROOT / f".github/workflows/{name}.yml").read_text()
                self.assertIn("- platform: ubuntu-24.04\n            args: '--features vulkan'\n            label: Linux-x64", source)
                self.assertIn("args: '--bundles nsis --features vulkan'\n            label: Windows-x64", source)
                self.assertNotIn("label: Linux-ARM64", source)
                self.assertNotIn("ubuntu-22.04-arm\n", source)
                self.assertIn("if: startsWith(matrix.platform, 'ubuntu-')", source)
                dependencies = source.split("- name: Install Linux dependencies", 1)[1].split("\n      - name:", 1)[0]
                self.assertIn("libvulkan-dev rpm", dependencies)
                apt = next(line for line in dependencies.splitlines() if "apt-get install -y" in line).split()
                # libappindicator3-dev does not exist on Ubuntu 24.04.
                self.assertIn("libayatana-appindicator3-dev", apt)
                self.assertNotIn("libappindicator3-dev", apt)
                self.assertNotIn("glslc", apt)
                sdk = source.split("- name: Install Vulkan SDK", 1)[1].split("\n      - name:", 1)[0]
                self.assertIn("if: matrix.platform != 'macos-latest'\n", sdk)
                self.assertRegex(sdk, r"uses: jakoch/install-vulkan-sdk-action@[0-9a-f]{40} # v")
                self.assertIn("TUIC_REQUIRE_VULKAN_LOADER: ${{ matrix.label == 'Windows-x64' && '1' || '' }}", source)
                self.assertIn("run: python scripts/fetch-vulkan-loader.py", source)

    def test_native_payload_gate_covers_every_linux_leg(self):
        # Catches: a Linux build reaches publication without ELF/package checks.
        for name in ("release", "nightly"):
            with self.subTest(workflow=name):
                source = (ROOT / f".github/workflows/{name}.yml").read_text()
                gate = source.split("- name: Verify native Linux desktop packages and publish checksums", 1)[1].split("\n      - ", 1)[0]
                self.assertIn("if: startsWith(matrix.label, 'Linux-')", gate)
                self.assertIn("bash scripts/check-linux-desktop-packages.sh", gate)
                self.assertIn("SHA256SUMS-${{ matrix.label }}.txt", gate)
                self.assertIn("if: matrix.label == 'Linux-x64' || matrix.label == 'Windows-x64'", source)
                self.assertIn("label: macOS-ARM", source)
                self.assertIn("label: Windows-x64", source)
                self.assertIn("label: Linux-x64", source)

    def test_linux_dependencies_supply_rpm_extractor(self):
        # Catches: bsdtar works locally but is missing on a release/nightly runner.
        for name in ("release", "nightly"):
            with self.subTest(workflow=name):
                source = (ROOT / f".github/workflows/{name}.yml").read_text()
                dependencies = source.split("- name: Install Linux dependencies", 1)[1].split("\n      - name:", 1)[0]
                apt = next(line for line in dependencies.splitlines() if "apt-get install -y" in line).split()
                self.assertIn("libarchive-tools", apt)
                self.assertIn("rpm", apt)

    def test_rpm_extraction_uses_bsdtar_without_ignoring_failure(self):
        # Catches: rpm2cpio rejects a complete payload with absent optional size fields.
        source = (ROOT / "scripts/check-linux-desktop-packages.sh").read_text()
        self.assertIn('(cd "$work/rpm" && bsdtar -xf "${rpms[0]}")', source.splitlines())

    def test_extractor_change_retains_fail_closed_package_checks(self):
        # Catches: the extractor fix drops or suppresses metadata/ELF/signature/checksum gates.
        source = (ROOT / "scripts/check-linux-desktop-packages.sh").read_text()
        for check in (
            'set -euo pipefail',
            'test "$(dpkg-deb -f "${debs[0]}" Architecture)" = "$deb_arch"',
            'test "$(rpm -qp --queryformat \'%{ARCH}\' "${rpms[0]}")" = "$rpm_arch"',
            'dpkg-deb -f "${debs[0]}" Depends | grep -F libvulkan1 >/dev/null',
            'rpm -qp --requires "${rpms[0]}" | grep -F libvulkan.so.1 >/dev/null',
            '  test -x "$binary"\n  readelf -h "$binary" | grep -F "Machine:" | grep -F "$machine" >/dev/null',
            'for binary in FastAF fastaf-cli tuic-bridge; do\n  check_elf "$release/$binary"',
            'for payload in deb rpm squashfs-root; do\n  for binary in FastAF fastaf-cli tuic-bridge; do',
            '    test -n "$found"\n    check_elf "$found"',
            'test -s "${images[0]}.sig"',
            '(cd "$release/bundle/deb" && sha256sum -- *.deb; cd ../rpm && sha256sum -- *.rpm; cd ../appimage && sha256sum -- *.AppImage) > "$release/bundle/SHA256SUMS-${label}.txt"',
        ):
            with self.subTest(check=check):
                self.assertIn(check, source)
        self.assertNotRegex(source, r'\|\||\bset\s+\+')


class LinuxUpdaterSelection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("linux_updater", ROOT / "scripts/check-linux-updater.py")
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def setUp(self):
        # The recorded manifest holds exactly FastAF's supported set: macOS
        # ARM64, Windows x64 and Linux x64, each with its format-specific keys.
        self.data = json.loads((ROOT / "src-tauri/test-fixtures/updater/stable-manifest.json").read_text())

    def verify(self, data):
        root = ROOT / ".tmp/tuic-tests"
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as directory:
            path = Path(directory) / "latest.json"
            path.write_text(json.dumps(data))
            with redirect_stdout(io.StringIO()):
                self.module.verify(path)

    def test_complete_supported_platform_set_is_accepted(self):
        # Catches: completeness validation blocks a correctly shaped full feed,
        # or starts to require a Linux ARM64 target FastAF does not build.
        self.assertFalse([target for target in self.data["platforms"] if "aarch64" in target and target.startswith("linux-")])
        self.verify(self.data)

    def test_x64_target_cannot_point_to_arm64_package(self):
        # Catches: an x64 key carries a signed package for another architecture.
        for target, wrong in (
            ("linux-x86_64", "https://example.invalid/FastAF_1.0.0_aarch64.AppImage"),
            ("linux-x86_64-deb", "https://example.invalid/FastAF_1.0.0_arm64.deb"),
            ("linux-x86_64-rpm", "https://example.invalid/FastAF-1.0.0-1.aarch64.rpm"),
        ):
            with self.subTest(target=target):
                data = copy.deepcopy(self.data)
                data["platforms"][target]["url"] = wrong
                with self.assertRaises(ValueError):
                    self.verify(data)

    def test_dropped_entries_block_finalization(self):
        # Catches: parallel latest.json writers lose a platform's updater entries.
        for target in (
            "darwin-aarch64", "darwin-aarch64-app", "windows-x86_64", "windows-x86_64-nsis",
            "linux-x86_64", "linux-x86_64-appimage", "linux-x86_64-deb", "linux-x86_64-rpm",
        ):
            with self.subTest(target=target):
                data = copy.deepcopy(self.data)
                del data["platforms"][target]
                with self.assertRaises(KeyError):
                    self.verify(data)

    def test_each_platform_requires_native_url_and_nonblank_signature(self):
        # Catches: preserved platform keys hide unusable signatures or wrong installers.
        for target in self.data["platforms"]:
            for field, value in (("url", "https://example.invalid/wrong-architecture.zip"), ("signature", ""), ("signature", "   ")):
                with self.subTest(target=target, field=field, value=value):
                    data = copy.deepcopy(self.data)
                    data["platforms"][target][field] = value
                    with self.assertRaises(ValueError):
                        self.verify(data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
