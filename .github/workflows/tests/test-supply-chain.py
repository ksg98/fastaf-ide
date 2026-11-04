"""Supply-chain contracts for the workflows that hold the signing secrets.

Pass a git ref to check the pre-fix workflows.
"""

from pathlib import Path
import re
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[3]
REF = sys.argv.pop(1) if len(sys.argv) > 1 else None

WORKFLOWS = sorted(
    [p.relative_to(ROOT).as_posix() for p in (ROOT / ".github/workflows").glob("*.yml")]
    + [p.relative_to(ROOT).as_posix() for p in (ROOT / ".github/actions").glob("*/action.yml")]
)
USES = re.compile(r"^\s*(?:- )?uses:\s*(\S+)(.*)$", re.M)
PINNED = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")


def read(path):
    if REF:
        return subprocess.check_output(["git", "show", f"{REF}:{path}"], cwd=ROOT, text=True)
    return (ROOT / path).read_text()


def step(source, name):
    body = source.split(f"      - name: {name}\n", 1)[1]
    return body.split("\n      - ", 1)[0]


class ActionPinning(unittest.TestCase):
    def test_every_third_party_action_is_pinned_to_a_commit(self):
        # Catches: a moved tag (@latest, @v0, @stable) running new code in a job
        # that holds the Developer ID, notarization and updater signing keys.
        unpinned = []
        for path in WORKFLOWS:
            for ref, rest in USES.findall(read(path)):
                if ref.startswith("./"):
                    continue
                if not PINNED.match(ref) or not re.match(r"\s+# \S", rest):
                    unpinned.append(f"{path}: {ref}{rest}")
        self.assertEqual(unpinned, [], "pin to a full SHA with a '# vX.Y.Z' comment")

    def test_dependabot_keeps_the_pins_current(self):
        config = read(".github/dependabot.yml")
        self.assertRegex(config, r'package-ecosystem:\s*"?github-actions"?')
        self.assertRegex(config, r'interval:\s*"?weekly"?')


class MacosSigning(unittest.TestCase):
    def test_release_fails_instead_of_shipping_unsigned(self):
        # Catches: an expired secret shipping an ad-hoc build that the updater
        # installs over the notarized app, resetting the user's permissions.
        release = read(".github/workflows/release.yml")
        self.assertIn("          require: 'true'\n", step(release, "Configure macOS signing"))
        verify = step(release, "Verify macOS signature and notarization")
        self.assertIn("codesign --verify --deep --strict", verify)
        self.assertIn("Authority=Developer ID Application:", verify)
        self.assertIn("xcrun stapler validate", verify)

    def test_nightly_stays_best_effort(self):
        nightly = read(".github/workflows/nightly.yml")
        self.assertIn("          require: 'false'\n", step(nightly, "Configure macOS signing"))

    def test_action_fails_every_fallthrough_when_required(self):
        action = read(".github/actions/macos-signing/action.yml")
        # Every best-effort exit goes through the helper, or the notarization
        # step's own required check, never a bare `exit 0` before them.
        cert_step = action.split("- name: Import Developer ID certificate", 1)[1].split(
            "- name: Configure notarization", 1
        )[0]
        helper, after = cert_step.split("        }\n", 1)
        self.assertIn('if [ "$REQUIRE" = "true" ]', helper)
        self.assertIn("exit 1", helper)
        self.assertIn("GITHUB_STEP_SUMMARY", helper)
        self.assertNotIn("exit 0", after)
        notarize = action.split("- name: Configure notarization", 1)[1]
        self.assertIn('if [ "$REQUIRE" = "true" ]', notarize)
        self.assertIn("GITHUB_STEP_SUMMARY", notarize)


if __name__ == "__main__":
    unittest.main(verbosity=2)
