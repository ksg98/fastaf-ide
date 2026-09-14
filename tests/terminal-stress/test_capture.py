from __future__ import annotations

import importlib.util
import tempfile
import unittest
import urllib.error
from pathlib import Path


CAPTURE_PATH = Path(__file__).with_name("capture.py")
SPEC = importlib.util.spec_from_file_location("terminal_stress_capture", CAPTURE_PATH)
assert SPEC and SPEC.loader
capture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture)


class FakeClient:
    def __init__(self, result: bytes | Exception) -> None:
        self.result = result
        self.paths: list[str] = []

    def get_bytes(self, path: str) -> bytes:
        self.paths.append(path)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class CaptureRawRingTests(unittest.TestCase):
    def test_preserves_invalid_utf8_and_payloads_larger_than_8192_bytes(self) -> None:
        payload = bytes(range(256)) * 40
        client = FakeClient(payload)
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            result = capture.capture_raw_ring(client, "session-id", out)
            self.assertEqual(result, payload)
            self.assertEqual((out / "raw.bin").read_bytes(), payload)
        self.assertEqual(client.paths, ["/sessions/session-id/raw-ring"])

    def test_reports_endpoint_failure_without_creating_an_artifact(self) -> None:
        client = FakeClient(urllib.error.URLError("connection refused"))
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "failed to fetch raw flight recorder"):
                capture.capture_raw_ring(client, "missing", out)
            self.assertFalse((out / "raw.bin").exists())

    def test_rejects_an_empty_ring_without_creating_an_artifact(self) -> None:
        client = FakeClient(b"")
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "raw flight recorder.*is empty"):
                capture.capture_raw_ring(client, "empty", out)
            self.assertFalse((out / "raw.bin").exists())


if __name__ == "__main__":
    unittest.main()
