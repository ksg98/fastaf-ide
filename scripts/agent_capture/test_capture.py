"""Focused capture contract tests; no synthetic agent transcripts."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import run
from scenario import expand, judge_reply, passthrough_env, run_steps, validate, write_cwd_files

CANARY = {"canary": "ZEBRA-7:", "canary_rule": "Start every reply with ZEBRA-7:"}


class CaptureContractTests(unittest.TestCase):
    # Catches: malformed scripts launch a CLI before discovering unusable expectations.
    def test_invalid_scenario_is_rejected_before_launch(self):
        base = {"agent": "pi", "args": [], "steps": [
            {"action": "wait", "expect": {"agent": "working"}}]}
        self.assertEqual(validate(base), [{"agent": "working"}])
        dialog = {**base, "agent": "claude", "steps": [
            {"action": "wait", "text": "Allow external CLAUDE.md file imports?"},
            {"action": "approval", "key": "enter"}, *base["steps"]]}
        self.assertEqual(validate(dialog), [{"agent": "working"}])
        for steps in [[], [{"action": "prompt", "text": ""}],
                      [{"action": "wait", "expect": {}}],
                      [{"action": "wait", "expect": {"awaiting": "false"}}],
                      [{"action": "wait", "expect": {"agent": "working"}, "timeout_secs": float("nan")}],
                      [{"action": "shell", "text": "anything"}],
                      [{"action": "approval", "key": "unknown"}],
                      [{"action": "wait", "expect": {"agent": "working"}, "replay_expect": {"agent": "idle"}}]]:
            with self.subTest(steps=steps), self.assertRaises(ValueError):
                validate({**base, "steps": steps})

    # Catches: a missing binary is reported as verified or gets a fabricated capture.
    def test_missing_cli_remains_unverified(self):
        with patch("run.shutil.which", return_value=None):
            inventory = run.inventory()
        self.assertTrue(inventory)
        self.assertTrue(all(row == {"binary": None, "status": "unverified",
                                    "reason": "not installed"} for row in inventory.values()))

    # Catches: a login error looks like an idle successful turn and gets promoted.
    # Wording observed from the real Claude CLI; the recording itself embedded the
    # home path (CLAUDE.md import list), so it cannot be committed.
    def test_real_login_failure_cannot_be_promoted_as_success(self):
        data = (b"\x1b[1m\xe2\x8f\xb5\xe2\x8f\xb5 auto mode on (shift+tab to cycle)"
                b" Not logged in \xc2\xb7 Run /login\r\n")
        with self.assertRaisesRegex(RuntimeError, "requires login"):
            run.reject_login(data.decode())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src-tauri/src/fixtures/agent_prompts").mkdir(parents=True)
            capture = root / "login.tcap"
            capture.write_bytes(b"TUICCAP2\n" + b"\0" * 4 + bytes([0]) + b"\0" * 8
                                + len(data).to_bytes(4, "little") + data)
            metadata = {"agent": "claude", "status": "captured",
                        "expected_states": [{"awaiting": False}],
                        "sha256": hashlib.sha256(capture.read_bytes()).hexdigest()}
            with patch("run.ROOT", root), self.assertRaisesRegex(RuntimeError, "requires login"):
                run.promote(capture, metadata, "must-remain-unverified")
            self.assertEqual(list((root / "src-tauri/src/fixtures/agent_prompts").iterdir()), [])

    # Catches: provenance metadata leaks the recorder's home directory into a public repo.
    def test_promotion_replaces_recording_paths_with_placeholders(self):
        metadata = {"daemon_health": {"socket_path": "/Users/someone/Gits/.tmp/run/tuic.sock"},
                    "capture": "/Users/someone/Gits/.tmp/run/raw/id.tcap"}
        shown = run.portable(metadata)
        self.assertEqual(shown["daemon_health"]["socket_path"], "<output>/tuic.sock")
        self.assertEqual(shown["capture"], "<output>/raw/id.tcap")
        self.assertIn("/Users/", metadata["capture"])

    # Catches: a re-recorded fixture or scenario file commits the recorder's home path.
    def test_committed_capture_fixtures_hold_no_home_paths(self):
        prompts = run.ROOT / "src-tauri/src/fixtures/agent_prompts"
        scenarios = sorted(prompts.glob("*.scenario.json"))
        self.assertTrue(scenarios, "no promoted scenario fixtures found")
        files = sorted(Path(__file__).parent.glob("*.json"))
        files += sorted((Path(__file__).parent / "fixtures").glob("*"))
        for scenario in scenarios:
            stem = scenario.name[: -len(".scenario.json")]
            files += [scenario, *sorted(prompts.glob(stem + ".*"))]
        for path in files:
            data = path.read_bytes()
            for marker in (b"/Users/", b"/home/"):
                self.assertNotIn(marker, data, f"{path.name} embeds {marker.decode()}")

    # Catches: changed or failed recordings overwrite previously reviewed evidence.
    def test_promotion_preserves_real_bytes_and_refuses_overwrite_and_tampering(self):
        fixture = run.ROOT / "src-tauri/src/fixtures/agent_prompts/codex-narrow-ink-replay-20260925.tcap"
        real_bytes = fixture.read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src-tauri/src/fixtures/agent_prompts").mkdir(parents=True)
            capture = root / "real.tcap"
            capture.write_bytes(real_bytes)
            metadata = {"agent": "codex", "status": "captured",
                        "expected_states": [{"awaiting": True}],
                        "sha256": hashlib.sha256(real_bytes).hexdigest()}
            with patch("run.ROOT", root):
                dest = run.promote(capture, metadata, "recorded")
                self.assertEqual(dest.read_bytes(), real_bytes)
                self.assertIn(f"SHA-256: `{metadata['sha256']}`", dest.with_suffix(".md").read_text())
                self.assertEqual(json.loads(dest.with_suffix(".scenario.json").read_text()), metadata)
                with self.assertRaises(ValueError):
                    run.promote(capture, metadata, "recorded")
                with self.assertRaises(ValueError):
                    run.promote(capture, {**metadata, "status": "unverified"}, "failed")
                capture.write_bytes(real_bytes[:-1])
                truncated = {**metadata, "sha256": hashlib.sha256(capture.read_bytes()).hexdigest()}
                with self.assertRaises(ValueError):
                    run.promote(capture, truncated, "truncated")
                capture.write_bytes(real_bytes + b"changed")
                with self.assertRaises(ValueError):
                    run.promote(capture, metadata, "changed")
                self.assertFalse(dest.with_name("codex-changed.tcap").exists())


class InjectionMatrixTests(unittest.TestCase):
    """Steps that prove whether a launch-time rule survives compact, clear and resume."""

    base = {"agent": "claude", "args": ["--append-system-prompt", "{canary_rule}"], **CANARY}

    # Catches: a typo such as "compact" is sent as an ordinary prompt and the
    # moment is reported as "after compact" although nothing was compacted.
    def test_slash_step_requires_a_slash_command(self):
        self.assertEqual(validate({**self.base, "steps": [
            {"action": "slash", "text": "/compact"},
            {"action": "check", "label": "B1", "text": "What is 123+456?", "answer": "579"}]}), [])
        for step in [{"action": "slash", "text": "compact"}, {"action": "slash", "text": ""},
                     {"action": "slash", "text": "/clear", "quiet_secs": 0}]:
            with self.subTest(step=step), self.assertRaises(ValueError):
                validate({**self.base, "steps": [step]})

    # Catches: a typo in env_passthrough silently launches the agent without its key, so the
    # run fails as "login required" with no hint; and the driver must hand over only the named
    # variables, never its whole environment.
    def test_env_passthrough_names_only_the_listed_variables(self):
        steps = [{"action": "check", "label": "A1", "text": "What is 123+456?", "answer": "579"}]
        self.assertEqual(validate({**self.base, "env_passthrough": ["GEMINI_API_KEY"], "steps": steps}), [])
        for bad in ["GEMINI_API_KEY", ["gemini key"], [1]]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate({**self.base, "env_passthrough": bad, "steps": steps})
        environ = {"GEMINI_API_KEY": "k", "OTHER_SECRET": "s"}
        self.assertEqual(passthrough_env({"env_passthrough": ["GEMINI_API_KEY", "MISSING_KEY"]}, environ),
                         {"GEMINI_API_KEY": "k"})
        self.assertEqual(passthrough_env({}, environ), {})
        # Catches: renaming (qwen reads OPENAI_API_KEY, the key is OpenRouter's) copying the wrong source.
        self.assertEqual(passthrough_env({"env_passthrough": ["OPENAI_API_KEY=OTHER_SECRET"]}, environ),
                         {"OPENAI_API_KEY": "s"})

    # Catches: a file-based rule (AGENTS.md) that survives the "resume without injection" restart,
    # so the E moment would measure the file instead of the history; and a path that escapes cwd.
    def test_cwd_files_write_expand_and_delete_inside_the_working_directory(self):
        steps = [{"action": "check", "label": "A1", "text": "What is 123+456?", "answer": "579"}]
        self.assertEqual(validate({**self.base, "cwd_files": {"AGENTS.md": "{canary_rule}"}, "steps": steps}), [])
        for bad in [{"../x": "t"}, {"/etc/x": "t"}, {"a": None}, {}, "AGENTS.md"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate({**self.base, "cwd_files": bad, "steps": steps})
        with tempfile.TemporaryDirectory() as directory:
            write_cwd_files(directory, {".github/rules.md": "rule: {canary_rule}"}, {"canary_rule": "ZEBRA-7:"})
            self.assertEqual((Path(directory) / ".github/rules.md").read_text(), "rule: ZEBRA-7:\n")
            write_cwd_files(directory, {".github/rules.md": None, "missing.md": None}, {})
            self.assertFalse((Path(directory) / ".github/rules.md").exists())

    # Catches: an agent whose history echo drops the trailing "?" (Gemini: "> What is 10+7") never matches
    # the prompt, so every check stays "not observed" although the reply carries the canary.
    def test_judge_finds_an_echo_without_the_trailing_question_mark(self):
        lines = ["> What is 10+7", "", "✦ ZEBRA-7: 17"]
        self.assertEqual(judge_reply(lines, "What is 10+7?", "17", "ZEBRA-7:")["followed"], True)
        self.assertEqual(judge_reply(["> What is 10+7", "✦ 17"], "What is 10+7?", "17", "ZEBRA-7:")["followed"], False)
        self.assertIsNone(judge_reply(["> What is 10+7"], "What is 10+7?", "17", "ZEBRA-7:"))

    # Catches: a check whose answer occurs in its own prompt passes on the
    # echoed prompt; a check without a canary has nothing to judge.
    def test_check_step_rejects_unjudgeable_checks(self):
        good = {"action": "check", "label": "A1", "text": "What is 123+456?", "answer": "579"}
        self.assertEqual(validate({**self.base, "steps": [good]}), [])
        for scenario in [{**self.base, "steps": [{**good, "answer": "123"}]},
                         {**self.base, "steps": [{**good, "label": ""}]},
                         {**self.base, "steps": [good, good]},
                         {**self.base, "canary": "", "steps": [good]},
                         {**self.base, "canary_rule": "no marker here", "steps": [good]}]:
            with self.subTest(scenario=scenario), self.assertRaises(ValueError):
                validate(scenario)

    # Catches: a resume relaunch without explicit args, which would silently
    # start a fresh session and report it as "resumed".
    def test_restart_step_requires_explicit_args(self):
        restart = {"action": "restart", "args": ["--continue"]}
        check = {"action": "check", "label": "D1", "text": "What is 123+456?", "answer": "579"}
        self.assertEqual(validate({**self.base, "steps": [restart, check]}), [])
        for step in [{"action": "restart"}, {"action": "restart", "args": "--continue"},
                     {**restart, "exit_text": ""}, {**restart, "env": {"CFG": 1}}]:
            with self.subTest(step=step), self.assertRaises(ValueError):
                validate({**self.base, "steps": [step, check]})

    # Catches: the rule text is hard-coded per agent and drifts between agents,
    # so the matrix compares different rules.
    def test_expand_places_one_rule_text_in_args_and_env(self):
        values = {"canary_rule": "Rule ZEBRA-7:", "canary_file": "/x/rule.md"}
        self.assertEqual(expand(["-c", "developer_instructions={canary_rule}", "--x"], values),
                         ["-c", "developer_instructions=Rule ZEBRA-7:", "--x"])
        self.assertEqual(expand({"CFG": '{"instructions":["{canary_file}"]}'}, values),
                         {"CFG": '{"instructions":["/x/rule.md"]}'})
        with self.assertRaises(ValueError):
            expand(["{unknown}"], values)

    # Catches: the reply is judged on the wrong turn (an earlier reply that did
    # follow the rule), on the echoed prompt, or misses the canary behind the
    # agent's bullet glyph.
    def test_judge_reads_only_the_reply_to_the_latest_prompt(self):
        lines = ["> What is 123+456?", "⏺ ZEBRA-7: 579", "", "> What is 123+456?",
                 "  ⎿ thinking", "⏺ 579", "", "────", "❯ "]
        verdict = judge_reply(lines, "What is 123+456?", "579", "ZEBRA-7:")
        self.assertEqual(verdict["followed"], False)
        self.assertEqual(verdict["reply_line"], "⏺ 579")
        followed = judge_reply(lines[:3], "What is 123+456?", "579", "ZEBRA-7:")
        self.assertEqual(followed["followed"], True)
        self.assertEqual(followed["reply_line"], "⏺ ZEBRA-7: 579")
        self.assertIsNone(judge_reply(["> What is 123+456?", "⠋ Working"],
                                      "What is 123+456?", "579", "ZEBRA-7:"))
        self.assertIsNone(judge_reply(["⏺ 579"], "What is 123+456?", "579", "ZEBRA-7:"))
        # Grok renders its reasoning in "┃" rows before the reply (real 1.0.50 layout).
        grok = ["❯ What is 10+7?", "┃ The answer is 17. I will prefix the response.",
                "ZEBRA-7:  💬 10 + 7 is 17."]
        self.assertEqual(judge_reply(grok, "What is 10+7?", "17", "ZEBRA-7:", ["┃"])["followed"], True)
        self.assertEqual(judge_reply(grok, "What is 10+7?", "17", "ZEBRA-7:")["followed"], True)
        # A progress tool call quoting the result precedes the reply (real grok 1.0.50 layout).
        tool = ["❯ What is 333+222?", "◆ Tuicommander Progress", "  text: 333+222 is 555.",
                "ZEBRA-7:  💬 333 + 222 is 555."]
        self.assertEqual(judge_reply(tool, "What is 333+222?", "555", "ZEBRA-7:")["reply_line"],
                         "ZEBRA-7:  💬 333 + 222 is 555.")
        tool[-1] = "💬 333 + 222 is 555."
        self.assertEqual(judge_reply(tool, "What is 333+222?", "555", "ZEBRA-7:"),
                         {"followed": False, "reply_line": "💬 333 + 222 is 555."})

    # Catches: steps after a restart still address the dead session, or the
    # restart never relaunches with the scenario's resume args.
    def test_restart_relaunches_and_later_steps_use_the_new_session(self):
        calls, launched = [], []

        def api(method, path, body=None):
            calls.append((method, path, body))
            if path.endswith("/terminal/scroll-info"):
                return {"total_lines": 3}
            if "/terminal/lines" in path:
                return {"lines": ["> What is 123+456?", "• ZEBRA-7: 579", "› "]}
            return {"submitted": True}

        def relaunch(old, args, env, exit_text, cwd_files):
            launched.append((old, args, env, exit_text, cwd_files))
            return "new-session"

        results = []
        with patch("scenario.time.sleep"):
            run_steps(api, "old-session", [
                {"action": "restart", "args": ["resume", "--last"], "env": {},
                 "cwd_files": {"AGENTS.md": None}},
                {"action": "check", "label": "D1", "text": "What is 123+456?", "answer": "579",
                 "quiet_secs": 0.5}], canary="ZEBRA-7:", relaunch=relaunch, results=results)
        self.assertEqual(launched, [("old-session", ["resume", "--last"], {}, None, {"AGENTS.md": None})])
        self.assertIn(("POST", "/sessions/new-session/submit", {"input": "What is 123+456?"}), calls)
        self.assertFalse(any("old-session/submit" in path for _, path, _ in calls))
        self.assertEqual([(r["label"], r["followed"], r["reply_line"]) for r in results],
                         [("D1", True, "• ZEBRA-7: 579")])

    # Catches: a check submitted while the agent still finishes the previous
    # command (TUIC answers 409) aborts the whole matrix run.
    def test_check_retries_a_busy_409_submission(self):
        answers = [RuntimeError("POST /sessions/s/submit: HTTP 409"), {"submitted": True}]

        def api(method, path, body=None):
            if path.endswith("/submit"):
                answer = answers.pop(0)
                if isinstance(answer, Exception):
                    raise answer
                return answer
            if path.endswith("/terminal/scroll-info"):
                return {"total_lines": 2}
            return {"lines": ["> What is 123+456?", "ZEBRA-7: 579"]}

        results = []
        with patch("scenario.time.sleep"):
            run_steps(api, "s", [{"action": "check", "label": "A1", "text": "What is 123+456?",
                                  "answer": "579", "quiet_secs": 0.5}], canary="ZEBRA-7:", results=results)
        self.assertEqual(answers, [])
        self.assertEqual(results[0]["followed"], True)

    # Catches: an agent that queues input (ego) is judged while it is still
    # working, so the previous turn's reply is read as this turn's.
    def test_idle_gate_waits_until_tui_reports_the_agent_not_working(self):
        states = ["working", "working", "idle"]

        def api(method, path, body=None):
            if path == "/sessions":
                return [{"session_id": "s", "state": {"agent_state": states.pop(0) if len(states) > 1
                                                      else states[0]}}]
            if path.endswith("/terminal/scroll-info"):
                return {"total_lines": 2}
            if path.endswith("/submit"):
                return {"submitted": True}
            return {"lines": ["> What is 123+456?", "ZEBRA-7: 579"]}

        results = []
        with patch("scenario.time.sleep"):
            run_steps(api, "s", [{"action": "check", "label": "A1", "text": "What is 123+456?",
                                  "answer": "579", "quiet_secs": 0.5}], canary="ZEBRA-7:",
                      results=results, idle_gate=True)
        self.assertEqual(states, ["idle"])
        self.assertEqual(results[0]["followed"], True)

    # Catches: a dialog that only some launches show either blocks the run when
    # absent, or is not answered when present.
    def test_dismiss_answers_a_dialog_only_when_it_appears(self):
        for screen, expected in [(["Allow external CLAUDE.md file imports?"], ["\r"]), (["❯ "], [])]:
            writes = []

            def api(method, path, body=None):
                if path.endswith("/write"):
                    writes.append(body["data"])
                    return {}
                if path.endswith("/terminal/scroll-info"):
                    return {"total_lines": 1}
                return {"lines": screen}

            step = {"action": "dismiss", "text": "Allow external CLAUDE.md file imports?",
                    "key": "enter", "timeout_secs": 1}
            validate({**InjectionMatrixTests.base, "steps": [step, {"action": "check", "label": "A1",
                      "text": "What is 1+2?", "answer": "3"}]})
            with self.subTest(screen=screen), patch("scenario.time.sleep"), \
                    patch("scenario.time.monotonic", side_effect=[0, 0, 0, 2, 2, 2]):
                run_steps(api, "s", [step])
            self.assertEqual(writes, expected)


if __name__ == "__main__":
    unittest.main()
