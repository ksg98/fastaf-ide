import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { HelpPanel } from "../../components/HelpPanel/HelpPanel";
import { mdTabsStore } from "../../stores/mdTabs";
import { mockInvoke } from "../mocks/tauri";

const resolveResource = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/path", () => ({ resolveResource }));

describe("HelpPanel", () => {
	const defaultProps = {
		visible: true,
		onClose: vi.fn(),
	};

	it("renders nothing when not visible", () => {
		const { container } = render(() => <HelpPanel visible={false} onClose={() => {}} />);
		const overlay = container.querySelector(".overlay");
		expect(overlay).toBeNull();
	});

	it("renders help panel when visible", () => {
		const { container } = render(() => <HelpPanel {...defaultProps} />);
		const overlay = container.querySelector(".overlay");
		expect(overlay).not.toBeNull();
		const heading = container.querySelector("h2");
		expect(heading).not.toBeNull();
		expect(heading!.textContent).toBe("Help");
	});

	it("shows project links", () => {
		const { container } = render(() => <HelpPanel {...defaultProps} />);
		const buttons = container.querySelectorAll("button");
		const buttonTexts = Array.from(buttons).map((b) => b.textContent?.trim());
		expect(buttonTexts).toContain("GitHub Project");
		expect(buttonTexts).toContain("Documentation");
		expect(buttonTexts).toContain("Report an Issue");
		// FastAF has no website or Discord of its own; upstream's must not be linked.
		expect(buttonTexts).not.toContain("Website");
		expect(buttonTexts).not.toContain("Discord Community");
	});

	it("points project links at the FastAF repository", () => {
		mockInvoke.mockClear().mockResolvedValue(undefined);
		const { getByRole } = render(() => <HelpPanel {...defaultProps} />);
		fireEvent.click(getByRole("button", { name: "GitHub Project" }));
		expect(mockInvoke).toHaveBeenCalledWith("open_default_app", {
			target: "https://github.com/ksg98/fastaf-ide",
			kind: "url",
		});
	});

	it("shows keyboard shortcuts button", () => {
		const { container } = render(() => <HelpPanel {...defaultProps} />);
		const buttons = container.querySelectorAll("button");
		const buttonTexts = Array.from(buttons).map((b) => b.textContent?.trim());
		expect(buttonTexts).toContain("Keyboard Shortcuts");
	});

	it("shows inline shortcuts when keyboard shortcuts button is clicked", () => {
		const { container } = render(() => <HelpPanel {...defaultProps} />);
		const buttons = Array.from(container.querySelectorAll("button"));
		const shortcutsBtn = buttons.find((b) => b.textContent?.trim() === "Keyboard Shortcuts");
		expect(shortcutsBtn).not.toBeNull();
		fireEvent.click(shortcutsBtn!);
		// After clicking, heading should change to "Keyboard Shortcuts"
		const heading = container.querySelector("h2");
		expect(heading!.textContent).toBe("Keyboard Shortcuts");
		// And shortcut sections should render (kbd elements from KeyboardShortcutsTab)
		const kbds = container.querySelectorAll("kbd");
		expect(kbds.length).toBeGreaterThan(0);
	});

	it("calls onClose when close button is clicked", () => {
		const handleClose = vi.fn();
		const { container } = render(() => <HelpPanel visible={true} onClose={handleClose} />);
		const closeBtn = container.querySelector('button[aria-label="Close"]');
		expect(closeBtn).not.toBeNull();
		fireEvent.click(closeBtn!);
		expect(handleClose).toHaveBeenCalledOnce();
	});

	it("displays the app version", () => {
		const { container } = render(() => <HelpPanel {...defaultProps} />);
		expect(container.textContent).toContain("Version");
	});

	it("copies the version to the clipboard when the Copy button is clicked", () => {
		mockInvoke.mockClear().mockResolvedValue(undefined);

		const { container } = render(() => <HelpPanel {...defaultProps} />);
		const copyBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Copy");
		expect(copyBtn).not.toBeUndefined();

		fireEvent.click(copyBtn!);

		// writeClipboard routes through the native clipboard command in Tauri.
		expect(mockInvoke).toHaveBeenCalledWith("write_clipboard_text", expect.objectContaining({ text: __APP_VERSION__ }));
	});

	it("displays license and credits", () => {
		const { container } = render(() => <HelpPanel {...defaultProps} />);
		// LICENSE is Apache-2.0; the footer once claimed MIT and named upstream's
		// author as FastAF's copyright holder.
		expect(container.textContent).toContain("Apache-2.0");
		expect(container.textContent).not.toContain("MIT License");
		expect(container.textContent).toContain("Based on TUICommander by Stefano Straus");
		expect(container.textContent).toContain("Tauri 2");
		expect(container.textContent).toContain("SolidJS");
	});

	it("opens the bundled license notices in a Markdown tab", async () => {
		const onClose = vi.fn();
		const add = vi.spyOn(mdTabsStore, "add").mockReturnValue("tab");
		resolveResource
			.mockReset()
			.mockResolvedValue("/Applications/FastAF.app/Contents/Resources/licenses/THIRD_PARTY_NOTICES.md");
		const { getByRole } = render(() => <HelpPanel visible onClose={onClose} />);
		fireEvent.click(getByRole("button", { name: "Licenses" }));
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(resolveResource).toHaveBeenCalledWith("licenses/THIRD_PARTY_NOTICES.md");
		expect(add).toHaveBeenCalledWith("", "/Applications/FastAF.app/Contents/Resources/licenses/THIRD_PARTY_NOTICES.md");
		add.mockRestore();
	});

	it("opens the published notices when the bundled copy cannot be found", async () => {
		mockInvoke.mockClear().mockResolvedValue(undefined);
		const add = vi.spyOn(mdTabsStore, "add").mockReturnValue("tab");
		resolveResource.mockReset().mockRejectedValue(new Error("no resource dir"));
		const { getByRole } = render(() => <HelpPanel {...defaultProps} />);
		fireEvent.click(getByRole("button", { name: "Licenses" }));
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("open_default_app", {
				target: "https://github.com/ksg98/fastaf-ide/blob/main/THIRD_PARTY_NOTICES.md",
				kind: "url",
			}),
		);
		expect(add).not.toHaveBeenCalled();
		add.mockRestore();
	});

	it("shows UI Legend button in quick actions", () => {
		const { container } = render(() => <HelpPanel {...defaultProps} />);
		const buttons = container.querySelectorAll("button");
		const buttonTexts = Array.from(buttons).map((b) => b.textContent?.trim());
		expect(buttonTexts).toContain("UI Legend");
	});

	it("shows inline legend when UI Legend button is clicked", () => {
		const { container } = render(() => <HelpPanel {...defaultProps} />);
		const buttons = Array.from(container.querySelectorAll("button"));
		const legendBtn = buttons.find((b) => b.textContent?.trim() === "UI Legend");
		expect(legendBtn).not.toBeNull();
		fireEvent.click(legendBtn!);
		// After clicking, heading should change to "UI Legend"
		const heading = container.querySelector("h2");
		expect(heading!.textContent).toBe("UI Legend");
		// Legend content should include terminal status dots section
		expect(container.textContent).toContain("Terminal Status Dots");
		expect(container.textContent).toContain("PR Status Badges");
	});
});

it("catches shared Back and Escape closing Help instead of returning from a sub-view", () => {
	const onClose = vi.fn();
	const view = render(() => <HelpPanel visible onClose={onClose} />);
	fireEvent.click(view.getByRole("button", { name: "UI Legend" }));
	fireEvent.click(view.getByRole("button", { name: "Back" }));
	expect(view.getByRole("heading", { name: "Help", level: 2 })).toBeInTheDocument();
	expect(onClose).not.toHaveBeenCalled();
	fireEvent.click(view.getByRole("button", { name: "UI Legend" }));
	fireEvent.keyDown(document, { key: "Escape" });
	expect(view.getByRole("heading", { name: "Help", level: 2 })).toBeInTheDocument();
	expect(onClose).not.toHaveBeenCalled();
	fireEvent.keyDown(document, { key: "Escape" });
	expect(onClose).toHaveBeenCalledOnce();
});
