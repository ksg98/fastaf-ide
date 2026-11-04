"""Release workflow contracts. Pass a git ref to check the pre-fix workflows."""

from pathlib import Path
import re
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[3]
REF = sys.argv.pop(1) if len(sys.argv) > 1 else None


def workflow(name):
    path = f".github/workflows/{name}.yml"
    if REF:
        return subprocess.check_output(["git", "show", f"{REF}:{path}"], cwd=ROOT, text=True)
    return (ROOT / path).read_text()


def job(source, name):
    return re.search(rf"^  {name}:\n(.*?)(?=^  [\w-]+:|\Z)", source, re.M | re.S).group(1)


class RemoteDaemonReleaseContracts(unittest.TestCase):
    def test_windows_tag_check_uses_bash_environment_expansion(self):
        # Catches: pwsh expands $GITHUB_REF_NAME to an empty argument on Windows.
        source = workflow("remote-daemon")
        step = source.split("      - name: Check tag matches version\n", 1)[1]
        step = step.split("\n      - ", 1)[0]
        self.assertIn("        shell: bash\n", step)
        self.assertIn('run: bash scripts/check-release-tag.sh "$GITHUB_REF_NAME"', step)

    def test_upload_waits_for_draft_creation_before_tag_lookup(self):
        # Catches: fast Linux builds upload before tauri-action creates the draft.
        source = workflow("release")
        caller = job(source, "remote-daemon")
        self.assertRegex(caller, r"(?m)^    needs: (?:build|\[build\])$")
        self.assertIn("uses: ./.github/workflows/remote-daemon.yml", caller)
        self.assertRegex(job(source, "build"), r"uses: tauri-apps/tauri-action@[0-9a-f]{40} # v0\.")
        self.assertIn("releaseDraft: true", job(source, "build"))
        self.assertIn("needs: [build, remote-daemon]", job(source, "finalize-release"))

    def test_nightly_upload_still_waits_for_release_cleanup(self):
        # Catches: shared daemon workflow changes break nightly release ordering.
        source = workflow("nightly")
        caller = job(source, "remote-daemon")
        self.assertRegex(caller, r"(?m)^    needs: (?:cleanup|\[cleanup\])$")
        self.assertIn("nightly: true", caller)
        self.assertIn("gh release create nightly", job(source, "cleanup"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
