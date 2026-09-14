import { describe, expect, it } from "vitest";

import { decodeBinaryFrame } from "../canvasTerminalUtils";

/**
 * The backend flags the alternate screen in `keyboard_flags` bit5 (frame_flags is
 * full — see serialize_dirty_rows). The frontend needs it because `historyBase`
 * restarts at 0 on every alt enter/exit, so the absolute-row cache has to be
 * dropped on the flip or a primary row aliases onto an alt row at the same key.
 */
function header(opts: { keyboardFlags: number }): ArrayBuffer {
	const buf = new ArrayBuffer(26);
	const view = new DataView(buf);
	let offset = 0;
	view.setUint16(offset, 0, true); // row_count
	offset += 2;
	view.setUint16(offset, 0, true); // cursor_row
	offset += 2;
	view.setUint16(offset, 0, true); // cursor_col
	offset += 2;
	view.setUint8(offset, 1); // cursor_visible
	offset += 1;
	view.setUint32(offset, 0, true); // display_offset
	offset += 4;
	view.setUint32(offset, 0, true); // history_size
	offset += 4;
	view.setUint8(offset, 0); // has_selection
	offset += 1;
	view.setUint8(offset, opts.keyboardFlags);
	offset += 1;
	view.setUint8(offset, 0); // frame_flags
	offset += 1;
	view.setUint16(offset, 24, true); // num_lines
	offset += 2;
	view.setUint16(offset, 80, true); // num_cols
	offset += 2;
	view.setUint32(offset, 0, true); // history_base
	return buf;
}

describe("decodeBinaryFrame — alternate screen flag", () => {
	it("reports altScreen=false on the primary screen", () => {
		expect(decodeBinaryFrame(header({ keyboardFlags: 0 }))?.altScreen).toBe(false);
	});

	it("reports altScreen=true when keyboard_flags bit5 is set", () => {
		expect(decodeBinaryFrame(header({ keyboardFlags: 0x20 }))?.altScreen).toBe(true);
	});

	it("keeps the real keyboard bits independent of the alt bit", () => {
		// All five kitty-keyboard bits set, alt screen off.
		const kitty = decodeBinaryFrame(header({ keyboardFlags: 0x1f }));
		expect(kitty?.altScreen).toBe(false);
		expect(kitty?.keyboardFlags).toBe(0x1f);

		// Same kitty bits, now inside the alternate screen.
		const both = decodeBinaryFrame(header({ keyboardFlags: 0x3f }));
		expect(both?.altScreen).toBe(true);
		expect(both?.keyboardFlags).toBe(0x1f);
	});
});
