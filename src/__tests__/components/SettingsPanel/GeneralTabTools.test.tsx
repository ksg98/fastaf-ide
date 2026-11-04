import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../mocks/tauri";

// Story 865: the Developer Tools page folded back into General. fastaf CLI,
// Code Intelligence (MDKB), Default IDE and Custom Launchers render on
// GeneralTab again, with the same desktop/browser gating they had. The ego
// executable moved here from AI Chat too (Boss decision 2026-09-24).

const { mockInvoke, mockIsTauri } = vi.hoisted(() => ({ mockInvoke: vi.fn(), mockIsTauri: vi.fn(() => true) }));

vi.mock("../../../invoke", () => ({
	invoke: mockInvoke,
	listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("../../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../transport")>()),
	isTauri: mockIsTauri,
}));

import { GeneralTab } from "../../../components/SettingsPanel/tabs/GeneralTab";
import { settingsStore } from "../../../stores/settings";

function headingTexts(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll("h3")).map((h) => h.childNodes[0]?.textContent?.trim() ?? "");
}

const hasLabel = (container: HTMLElement, text: string) =>
	Array.from(container.querySelectorAll("label")).some((el) => el.textContent === text);

describe("GeneralTab developer tools sections", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsTauri.mockReturnValue(true);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_cli_status") {
				return Promise.resolve({
					installed: true,
					path: "/usr/local/bin/tuic",
					version_match: true,
					auto_updatable: true,
					prompt_dismissed: false,
				});
			}
			if (cmd === "mdkb_status") {
				return Promise.resolve({ available: true, connected: true, binaryPath: "/usr/local/bin/mdkb", version: "1.0" });
			}
			return Promise.resolve(undefined);
		});
	});

	afterEach(() => cleanup());

	// Catches: desktop-only children leave a misleading empty Local tools card in browser mode.
	it("hides the desktop-only Local tools card in browser mode", () => {
		mockIsTauri.mockReturnValue(false);
		const view = render(() => <GeneralTab />);
		expect(view.queryByRole("region", { name: "Local tools" })).toBeNull();
	});

	// Catches: the tray selector changes no preference or Never still offers Background.
	it("applies the tray preference and removes Background when Never is selected", () => {
		settingsStore.setTrayIcon("background_only");
		const view = render(() => <GeneralTab />);
		const label = Array.from(view.container.querySelectorAll("label")).find(
			(item) => item.textContent === "Tray and menu-bar icon",
		);
		const select = label?.htmlFor ? view.container.querySelector(`#${label.htmlFor}`) : null;
		expect(select).toBeTruthy();
		try {
			fireEvent.change(select!, { target: { value: "never" } });
			expect(settingsStore.state.trayIcon).toBe("never");
			expect(view.container.querySelector('option[value="background"]')).toBeNull();
		} finally {
			settingsStore.setTrayIcon("background_only");
		}
	});

	// Catches: the close preference being visible but not wired to persistence, or exposed in browser mode.
	it("offers a working close-policy select only on desktop", () => {
		const save = vi.spyOn(settingsStore, "setCloseBehavior").mockImplementation(() => {});
		const view = render(() => <GeneralTab />);
		const select = Array.from(view.container.querySelectorAll("select")).find((element) =>
			Array.from(element.options).some((option) => option.value === "background"),
		);
		expect(select).toBeDefined();
		fireEvent.change(select!, { target: { value: "background" } });
		expect(save).toHaveBeenCalledWith("background");
		view.unmount();
		mockIsTauri.mockReturnValue(false);
		const browser = render(() => <GeneralTab />);
		expect(hasLabel(browser.container, "When closing the main window")).toBe(false);
		save.mockRestore();
	});

	// Catches: the Local tools regrouping drops a tool row or its installed-state controls.
	it("groups fastaf CLI, Code Intelligence and Custom Launchers in order with their controls", async () => {
		const view = render(() => <GeneralTab />);

		await view.findByText("Installed at /usr/local/bin/tuic");
		const localTools = view.getByRole("region", { name: "Local tools" });
		expect(Array.from(localTools.querySelectorAll("label")).map((label) => label.textContent)).toEqual([
			"fastaf CLI",
			"Code Intelligence",
			"Custom Launchers",
		]);
		expect(within(localTools).getByText("Installed at /usr/local/bin/mdkb v1.0")).toBeTruthy();
		expect(within(localTools).getAllByRole("button", { name: "Uninstall" })).toHaveLength(2);
		expect(within(localTools).getByRole("button", { name: "Add launcher" })).toBeTruthy();
		expect(within(view.getByRole("region", { name: "IDE" })).getByLabelText("Default IDE")).toBeTruthy();
	});

	// FastAF's AI Chat runs on its built-in engine: General has no ego section,
	// with experimental features off or on.
	// Updates opens the page (its status card sits under the page header, never above it).
	it("goes straight from Local tools to General, with no ego section", async () => {
		const view = render(() => <GeneralTab />);

		await view.findByText("Installed at /usr/local/bin/tuic");
		const headings = headingTexts(view.container);
		expect(headings.slice(0, 3)).toEqual(["Updates", "Local tools", "General"]);
		expect(headings).not.toContain("ego");
		expect(view.queryByText("ego executable")).toBeNull();
	});

	it("keeps the IDE picker in a browser, and no ego path field", async () => {
		mockIsTauri.mockReturnValue(false);
		const { container } = render(() => <GeneralTab />);

		const headings = headingTexts(container);
		expect(headings).toContain("IDE");
		expect(hasLabel(container, "Default IDE")).toBe(true);
		expect(headings).not.toContain("ego");
		expect(container.querySelector("input[placeholder='/usr/local/bin/ego']")).toBeNull();
		expect(hasLabel(container, "fastaf CLI")).toBe(false);
		expect(hasLabel(container, "Code Intelligence")).toBe(false);
		expect(hasLabel(container, "Custom Launchers")).toBe(false);
		expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Add launcher")).toBe(false);
		expect(mockInvoke).not.toHaveBeenCalledWith("get_cli_status");
		expect(mockInvoke).not.toHaveBeenCalledWith("mdkb_status");
	});
});
