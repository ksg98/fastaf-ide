"""Independent runner boundary checks; never execute the desktop application."""

import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest


class RunnerBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"])
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "build"
        self.source.mkdir()
        shell = self.root / "host-shell"
        shutil.copy("/bin/sh", shell)
        if sys.platform == "darwin":
            subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-",
                            "--timestamp=none", str(shell)], check=True,
                           capture_output=True)
        for name in ("tuicommander", "fastaf-cli", "tuic-remote", "tuic-bridge"):
            shutil.copy(shell, self.source / name)
        self.destination = self.root / "stable"
        self.env = dict(os.environ, TUIC_DEV_BIN_DIR=str(self.destination))
        self.runner = Path(__file__).with_name("dev-exe-copy.py").resolve()

    def command(self, code):
        return [sys.executable, "-B", str(self.runner),
                str(self.source / "tuicommander"), "-c", code]

    # Catches: supervisor consumes stop signals and leaves the app running.
    # Existing tests cover normal exits only; this drives the real process boundary.
    def test_stop_signals_reach_app_and_preserve_its_shutdown_exit(self):
        for stop_signal, trap_name in ((signal.SIGTERM, "TERM"),
                                       (signal.SIGINT, "INT"),
                                       (signal.SIGHUP, "HUP")):
            with self.subTest(signal=trap_name):
                # dash can defer a trap while blocked in read; wait is interruptible.
                code = (f'sleep 30 & sleeper=$!; '
                        f"trap 'kill \"$sleeper\"; echo stopped; exit 23' {trap_name}; "
                        'echo ready; wait "$sleeper"')
                process = subprocess.Popen(self.command(code), env=self.env,
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, text=True,
                                           # rb launches asynchronously; restore the foreground
                                           # SIGINT disposition before recording shell behavior.
                                           preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL))
                try:
                    self.assertEqual(process.stdout.readline(), "ready\n")
                    process.send_signal(stop_signal)
                    process.wait(timeout=10)
                    stdout, stderr = process.communicate()
                    self.assertEqual(process.returncode, 23, stderr)
                    self.assertEqual(stdout, "stopped\n")
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate()
                    for stream in (process.stdin, process.stdout, process.stderr):
                        stream.close()

    # Catches: a signal-killed app is reported as successful by its runner.
    def test_signal_death_is_reported_as_shell_failure_status(self):
        result = subprocess.run(self.command('kill -TERM $$'), env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 143, result.stderr)

    # Catches: a failed binary copy falls back to launching a stale installed app.
    # Unlike missing-source coverage, every source is valid and destination copy fails.
    def test_copy_failure_never_launches_previous_installed_app(self):
        self.destination.mkdir()
        installed = self.destination / "tuicommander"
        shutil.copy(self.source / "tuicommander", installed)
        (self.destination / ".tuicommander.new").mkdir()
        result = subprocess.run(self.command('echo STALE-LAUNCHED'), env=self.env,
                                capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(installed.read_bytes(),
                         (self.source / "tuicommander").read_bytes())


if __name__ == "__main__":
    unittest.main()
