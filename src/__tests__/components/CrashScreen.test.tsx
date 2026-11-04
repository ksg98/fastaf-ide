import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrashScreen } from "../../components/CrashScreen/CrashScreen";
import { appLogger } from "../../stores/appLogger";
import * as clipboard from "../../utils/clipboard";

// #763-d219 — desktop and mobile must both keep Reload, and both must copy the
// *exact* rendered message + full stack via src/utils/clipboard.ts, with a
// visible copied/failure state and an appLogger (never console) failure log.
//
// Spies on `writeClipboard` itself rather than mocking the Tauri/browser
// transport it picks between — CrashScreen's contract is "call writeClipboard
// with this exact string and react to its outcome", not which transport wins.

describe("CrashScreen", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeError(): Error {
		const error = new Error("boom: repository hydration failed");
		error.stack = "Error: boom: repository hydration failed\n    at hydrate (repositories.ts:900:10)";
		return error;
	}

	it("renders the title, message, and full stack", () => {
		render(() => <CrashScreen title="TUICommander crashed" error={makeError()} />);
		expect(screen.getByText("TUICommander crashed")).toBeTruthy();
		expect(screen.getByText("boom: repository hydration failed")).toBeTruthy();
		expect(screen.getByText(/at hydrate \(repositories\.ts:900:10\)/)).toBeTruthy();
	});

	it("keeps a working Reload button", () => {
		const reloadSpy = vi.fn();
		vi.stubGlobal("location", { ...window.location, reload: reloadSpy });

		render(() => <CrashScreen title="TUICommander crashed" error={makeError()} />);
		fireEvent.click(screen.getByText("Reload"));

		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it("copies the exact message + full stack, with nothing truncated, and shows a copied state", async () => {
		const writeSpy = vi.spyOn(clipboard, "writeClipboard").mockResolvedValueOnce(undefined);
		const error = makeError();

		render(() => <CrashScreen title="TUICommander crashed" error={error} />);
		fireEvent.click(screen.getByText("Copy error"));

		expect(await screen.findByText("Copied")).toBeTruthy();
		expect(writeSpy).toHaveBeenCalledWith(`${error.message}\n\n${error.stack}`);
	});

	it("falls back to just the message when there is no stack", async () => {
		const writeSpy = vi.spyOn(clipboard, "writeClipboard").mockResolvedValueOnce(undefined);
		const error = new Error("boom without a stack");
		error.stack = undefined;

		render(() => <CrashScreen title="TUICommander crashed" error={error} />);
		fireEvent.click(screen.getByText("Copy error"));

		expect(await screen.findByText("Copied")).toBeTruthy();
		expect(writeSpy).toHaveBeenCalledWith("boom without a stack");
	});

	it("shows a visible failure state and logs via appLogger (never console) when the copy fails", async () => {
		vi.spyOn(clipboard, "writeClipboard").mockRejectedValueOnce(new Error("clipboard denied"));
		const loggerSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		render(() => <CrashScreen title="TUICommander crashed" error={makeError()} />);
		fireEvent.click(screen.getByText("Copy error"));

		expect(await screen.findByText("Copy failed")).toBeTruthy();
		expect(loggerSpy).toHaveBeenCalledWith("app", "Failed to copy crash diagnostic", expect.any(Error));
		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it("mobile crash screen renders the same shared component with its own title", () => {
		render(() => <CrashScreen title="TUICommander Mobile crashed" error={makeError()} />);
		expect(screen.getByText("TUICommander Mobile crashed")).toBeTruthy();
		expect(screen.getByText("Reload")).toBeTruthy();
		expect(screen.getByText("Copy error")).toBeTruthy();
	});
});
