import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpPanel } from "../../components/HelpPanel/HelpPanel";
import "../mocks/tauri";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn().mockResolvedValue(undefined),
}));

/** Toggle the Tauri-webview marker isTauri() reads */
function setTauriEnv(on: boolean) {
	const g = globalThis as Record<string, unknown>;
	if (on) {
		g.__TAURI_INTERNALS__ = {};
		delete g.__TAURI_SHIM__;
	} else {
		delete g.__TAURI_INTERNALS__;
	}
}

const SYSTEM_MENU_NOTE = /system menu bar/i;

describe("HelpPanel — system menu guidance", () => {
	afterEach(() => {
		setTauriEnv(false);
	});

	// Imported statically, and deliberately NOT behind vi.resetModules(): the
	// component reads isTauri() inside its JSX on every render, not once at module
	// scope, so re-importing the tree per test bought nothing and charged each
	// test a cold import of the whole HelpPanel dependency graph. On a loaded CI
	// runner that pushed the first test past the 5s budget and failed it on
	// module-load time rather than on behaviour.
	function renderPanel() {
		return render(() => <HelpPanel visible={true} onClose={() => {}} />);
	}

	it("tells the desktop user that shortcuts also live in the native system menu bar", async () => {
		setTauriEnv(true);
		const { container } = renderPanel();
		expect(container.textContent).toMatch(SYSTEM_MENU_NOTE);
	});

	it("keeps the note in the main view alongside the resource links", async () => {
		setTauriEnv(true);
		const { container } = renderPanel();

		// Resource links still reachable — the note must not replace or hide them
		const buttonTexts = Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim());
		expect(buttonTexts).toContain("Keyboard Shortcuts");
		expect(buttonTexts).toContain("Documentation");
		expect(buttonTexts).toContain("Report an Issue");
	});

	it("does not obscure the shortcut search in the shortcuts sub-view", async () => {
		setTauriEnv(true);
		const { container } = renderPanel();

		const shortcutsBtn = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Keyboard Shortcuts",
		);
		fireEvent.click(shortcutsBtn!);

		// Sub-view renders its own content; the main-view note is gone with it
		expect(container.querySelectorAll("kbd").length).toBeGreaterThan(0);
		expect(container.textContent).not.toMatch(SYSTEM_MENU_NOTE);
	});

	it("omits the note in browser mode, where there is no native menu bar", async () => {
		setTauriEnv(false);
		const { container } = renderPanel();
		expect(container.textContent).not.toMatch(SYSTEM_MENU_NOTE);
		// Main view still renders normally
		expect(container.textContent).toContain("Apache-2.0");
	});

	it("opens the published license notices in browser mode, which has no bundle", () => {
		setTauriEnv(false);
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const { getByRole } = renderPanel();
		fireEvent.click(getByRole("button", { name: "Licenses" }));
		expect(open).toHaveBeenCalledWith("https://github.com/ksg98/fastaf-ide/blob/main/THIRD_PARTY_NOTICES.md", "_blank");
		open.mockRestore();
	});
});
