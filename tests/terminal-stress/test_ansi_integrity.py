"""The integrity checker must reject data loss, not merely count markers."""
import struct
import unittest

from ansi_integrity import (
    CELL_BYTES,
    OPS,
    TCX_MAGIC,
    XtermOracle,
    assert_exact_rows,
    assert_rows,
    cases,
    decode_styled_rows,
    reference,
    unicode_operations,
)
from run import expected_record, verify, verify_reflow


def styled_payload(rows, extras=()):
    cols = len(rows[0])
    payload = bytearray(struct.pack("<IIHH", 0, 0, cols, len(rows)))
    for absolute, row in enumerate(rows, start=40):
        payload.extend(struct.pack("<IH", absolute, cols))
        for char in row:
            payload.extend(struct.pack("<I7B", ord(char), 0, 0, 0, 0, 0, 0, 0))
    if extras:
        payload.extend(TCX_MAGIC)
        payload.extend(struct.pack("<I", len(extras)))
        for row, column, marks in extras:
            payload.extend(struct.pack("<HHB", row, column, len(marks)))
            payload.extend(struct.pack(f"<{len(marks)}I", *(ord(mark) for mark in marks)))
    return bytes(payload), cols


class IntegrityOracleTests(unittest.TestCase):
    def test_rejects_missing_duplicate_reordered_and_corrupt_middle_rows(self):
        expected = ["header", "row-one", "row-two", "footer"]
        for actual in (
            expected[:1] + expected[2:],
            expected[:2] + expected[1:],
            [expected[i] for i in (0, 2, 1, 3)],
            ["header", "row-on", "row-two", "footer"],
        ):
            with self.subTest(actual=actual), self.assertRaises(AssertionError):
                assert_rows(actual, expected)

    def test_all_ordered_pairs_and_reproducible_random_cases(self):
        generated = list(cases(819, 10))
        names = {name for name, _ in generated}
        for first in OPS:
            for second in OPS:
                self.assertIn(f"pair-{first}-{second}", names)
        self.assertEqual(generated, list(cases(819, 10)))
        self.assertNotEqual(generated[-10:], list(cases(820, 10))[-10:])

    def test_reference_retains_cleared_screen_but_clears_visible_content(self):
        rows = reference(b"one\r\ntwo\x1b[2J", 4, 12)
        self.assertEqual(rows, ["one", "two", "", "", "", ""])

    def test_reference_models_erase_and_cursor_overwrite(self):
        self.assertEqual(reference(b"abcdef\rXY\x1b[K", 2, 12), ["XY", ""])

    def test_exact_unicode_comparison_does_not_accept_nfc_substitution(self):
        with self.assertRaises(AssertionError):
            assert_exact_rows(["caf\u00e9"], ["cafe\u0301"])

    def test_unicode_case_exercises_delayed_multiple_and_overwritten_marks(self):
        payload = unicode_operations()
        self.assertIn("cafe\u0301".encode(), payload)
        self.assertIn("A\u0301\u0308\u20dd".encode(), payload)
        self.assertIn("a\u0301\bZ".encode(), payload)

    def test_styled_decoder_accepts_legacy_core_and_applies_tcx1_by_wire_ordinal(self):
        legacy, cols = styled_payload(("cafe ", "A    "))
        self.assertEqual(decode_styled_rows(legacy, 2, cols), ["cafe", "A"])

        extended, cols = styled_payload(
            ("cafe ", "A    "),
            ((0, 3, ("\u0301",)), (1, 0, ("\u0301", "\u0308", "\u20dd"))),
        )
        self.assertEqual(
            decode_styled_rows(extended, 2, cols),
            ["cafe\u0301", "A\u0301\u0308\u20dd"],
        )

    def test_styled_decoder_rejects_malformed_or_ambiguous_tcx1(self):
        rows = ("A ",)
        valid, cols = styled_payload(rows, ((0, 0, ("\u0301",)),))
        trailer = 12 + 6 + cols * CELL_BYTES
        corruptions = {
            "magic": valid[:trailer] + b"BAD!" + valid[trailer + 4:],
            "truncated scalar": valid[:-1],
            "zero marks": valid[:trailer + 12] + b"\x00" + valid[trailer + 13:],
            "too many marks": valid[:trailer + 12] + b"\x0a" + valid[trailer + 13:],
        }

        invalid_row, _ = styled_payload(rows, ((1, 0, ("\u0301",)),))
        corruptions["row ordinal"] = invalid_row
        invalid_column, _ = styled_payload(rows, ((0, cols, ("\u0301",)),))
        corruptions["column"] = invalid_column
        duplicate, _ = styled_payload(
            rows, ((0, 0, ("\u0301",)), (0, 0, ("\u0308",)))
        )
        corruptions["duplicate cell"] = duplicate
        invalid_scalar = bytearray(valid)
        struct.pack_into("<I", invalid_scalar, trailer + 13, 0xd800)
        corruptions["surrogate scalar"] = bytes(invalid_scalar)
        corruptions["trailing bytes"] = valid + b"x"

        for name, payload in corruptions.items():
            with self.subTest(name=name), self.assertRaises(AssertionError):
                decode_styled_rows(payload, 1, cols)

    def test_xterm_adapter_retains_ed2_and_restores_alternate_screen(self):
        oracle = XtermOracle()
        try:
            self.assertEqual(oracle.render(b"one\r\ntwo\x1b[2J", 4, 12),
                             ["one", "two", "", "", "", ""])
            self.assertEqual(oracle.render(b"primary\x1b[?1049hhidden\x1b[?1049l", 2, 12),
                             ["primary", ""])
            self.assertEqual(oracle.render("cafe\u0301".encode(), 2, 12), ["cafe\u0301", ""])
        finally:
            oracle.close()

    def test_atomic_checker_rejects_reordering(self):
        with self.assertRaises(AssertionError):
            verify([expected_record(1), expected_record(0)], 2, "atomic")

    def test_reflow_checker_requires_the_committed_partial(self):
        with self.assertRaises(AssertionError):
            verify_reflow([expected_record(0)], 1)
        verify_reflow([expected_record(0)[:8], expected_record(0)], 1)


if __name__ == "__main__":
    unittest.main()
