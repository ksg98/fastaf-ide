#!/usr/bin/env python3
"""Exercise the staged hook boundary, never private classification helpers."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HOOK = Path(__file__).with_name("pre-commit").resolve()


class FixtureGateCritic(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="fixture-gate-critic-", dir=os.environ["TMPDIR"])
        self.repo = Path(self.tmp.name)
        self.path = self.repo / "src-tauri/src/state.rs"
        self.path.parent.mkdir(parents=True)
        self.git("init", "-q")
        self.git("config", "user.email", "critic@example.invalid")
        self.git("config", "user.name", "Fixture Gate Critic")
        self.addCleanup(self.tmp.cleanup)

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True, capture_output=True)

    def stage_change(self, before, after):
        self.path.write_text(before)
        self.git("add", ".")
        self.git("commit", "-qm", "baseline")
        self.path.write_text(after)
        self.git("add", ".")

    def hook(self):
        env = dict(os.environ)
        env.pop("TUIC_SKIP_FIXTURE_GATE", None)
        return subprocess.run(["bash", str(HOOK)], cwd=self.repo, env=env, capture_output=True, text=True)

    # Catches: a semicolon-ended cfg(test) module consumes the next production body.
    def test_external_test_module_cannot_hide_changed_production_detection(self):
        before = "#[cfg(test)]\nmod tests;\n\nfn awaiting_input() -> bool {\n    false\n}\n"
        self.stage_change(before, before.replace("    false", "    true"))
        result = self.hook()
        self.assertNotEqual(result.returncode, 0, "production change passed without a capture")
        self.assertIn("agent-state detection changed", result.stderr)

    # Catches: a trailing comment on a test scope falsely blocks a test-only commit.
    def test_test_only_nested_scope_with_closing_comment_is_ignored(self):
        before = "#[cfg(test)]\nmod tests {\n    #[test]\n    fn awaiting_input_regression() {\n        assert!(true);\n    } // regression scope\n}\n"
        self.stage_change(before, before.replace("assert!(true)", "assert!(!false)"))
        result = self.hook()
        self.assertEqual(result.returncode, 0, result.stderr)

    # Catches: cfg(test)-looking raw string contents exclude later production code.
    def test_raw_string_test_attributes_do_not_hide_production_detection(self):
        before = 'const TEMPLATE: &str = r###"\n#[cfg(test)]\nmod tests {\n}\n"###;\nfn awaiting_input() -> bool {\n    false\n}\n'
        self.stage_change(before, before.replace("    false", "    true"))
        result = self.hook()
        self.assertNotEqual(result.returncode, 0, "raw string hid production change")
        self.assertIn("agent-state detection changed", result.stderr)


if __name__ == "__main__":
    unittest.main()
