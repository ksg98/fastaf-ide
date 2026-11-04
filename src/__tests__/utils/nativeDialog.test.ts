import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDialog, saveDialog } from "../../utils/nativeDialog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// The shared setup (`mocks/tauri.ts`) stubs this module for every other suite,
// which would otherwise hand this one the stub instead of the code under test.
vi.unmock("../../utils/nativeDialog");

const invokeMock = vi.mocked(invoke);

/** The argument object the wrapper handed to the Rust command. */
function lastArgs(): Record<string, unknown> {
	const call = invokeMock.mock.calls.at(-1);
	if (!call) throw new Error("pick_path was never invoked");
	expect(call[0]).toBe("pick_path");
	return call[1] as Record<string, unknown>;
}

describe("nativeDialog", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		invokeMock.mockResolvedValue(null);
	});

	describe("kind mapping", () => {
		// The Rust side switches on `kind` to decide which rfd picker to build, so
		// a wrong mapping here opens the wrong panel — a file chooser where the
		// user asked for a folder, which no type error would catch.
		it("asks for a folder when directory is set", async () => {
			await openDialog({ directory: true });
			expect(lastArgs().kind).toBe("folder");
		});

		it("asks for one file by default", async () => {
			await openDialog({});
			expect(lastArgs().kind).toBe("file");
		});

		it("asks for many files only when multiple is set", async () => {
			await openDialog({ multiple: true });
			expect(lastArgs().kind).toBe("files");
		});

		it("prefers folder over multiple, matching the single-folder call sites", async () => {
			await openDialog({ directory: true, multiple: true });
			expect(lastArgs().kind).toBe("folder");
		});

		it("asks for a save panel from saveDialog", async () => {
			await saveDialog({ fileName: "untitled.txt" });
			expect(lastArgs().kind).toBe("save");
		});
	});

	describe("result shaping", () => {
		it("unwraps a single pick to a bare string", async () => {
			invokeMock.mockResolvedValue(["/repo/src"]);
			await expect(openDialog({ directory: true })).resolves.toBe("/repo/src");
		});

		it("keeps the array for a multiple pick", async () => {
			invokeMock.mockResolvedValue(["/a.txt", "/b.txt"]);
			await expect(openDialog({ multiple: true })).resolves.toEqual(["/a.txt", "/b.txt"]);
		});

		it("reports a cancelled dialog as null", async () => {
			invokeMock.mockResolvedValue(null);
			await expect(openDialog({})).resolves.toBeNull();
		});

		// Rust answers `Some([])` for nothing selected in some paths; a bare
		// `picked[0]` would hand `undefined` to a caller checking for null.
		it("treats an empty selection as cancelled, not as a pick", async () => {
			invokeMock.mockResolvedValue([]);
			await expect(openDialog({ multiple: true })).resolves.toBeNull();
			await expect(saveDialog({})).resolves.toBeNull();
		});
	});

	describe("options", () => {
		it("passes title, defaultPath, fileName and filters through", async () => {
			await openDialog({
				title: "Install Plugin from ZIP",
				defaultPath: "/",
				filters: [{ name: "Plugin Archive", extensions: ["zip"] }],
			});
			expect(lastArgs()).toMatchObject({
				title: "Install Plugin from ZIP",
				defaultPath: "/",
				filters: [{ name: "Plugin Archive", extensions: ["zip"] }],
			});
		});

		// serde maps a missing key and an explicit null to the same `None`, but
		// `undefined` is dropped by the IPC serializer on some paths — sending an
		// explicit null keeps the payload shape fixed.
		it("sends null rather than undefined for absent options", async () => {
			await openDialog({});
			expect(lastArgs()).toEqual({
				kind: "file",
				title: null,
				defaultPath: null,
				fileName: null,
				filters: null,
			});
		});
	});

	// The whole reason this module exists: the Rust command rejects instead of
	// letting AppKit panic, so the rejection has to reach the caller intact.
	it("propagates the unavailable-dialog error instead of swallowing it", async () => {
		invokeMock.mockRejectedValue(new Error("The system file dialog is unavailable"));
		await expect(openDialog({ directory: true })).rejects.toThrow("unavailable");
	});
});
