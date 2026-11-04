import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { SettingsSearchBox, SettingsSearchResults, scrollToSetting } from "../SettingsSearch";
import type { SettingsShellTab } from "../SettingsShell";
import { searchSettings } from "../settingsSearchIndex";

const TABS: SettingsShellTab[] = [
	{ key: "general", label: "General" },
	{ key: "appearance", label: "Appearance" },
	{ key: "remote-access", label: "Remote Access" },
	{ key: "__sep__", label: "─" },
	{ key: "repo:/tmp/x", label: "x" },
];

const availableTabs = new Set(["general", "appearance", "remote-access"]);

describe("SettingsSearchBox", () => {
	it("reports every keystroke", () => {
		const onInput = vi.fn();
		const { container } = render(() => <SettingsSearchBox value="" onInput={onInput} />);
		const input = container.querySelector("input") as HTMLInputElement;
		fireEvent.input(input, { target: { value: "relay" } });
		expect(onInput).toHaveBeenCalledWith("relay");
	});

	it("clears the query from the clear button", () => {
		const onInput = vi.fn();
		const { container } = render(() => <SettingsSearchBox value="relay" onInput={onInput} />);
		const clear = container.querySelector("button") as HTMLButtonElement;
		fireEvent.click(clear);
		expect(onInput).toHaveBeenCalledWith("");
	});

	it("offers no clear button when the query is empty", () => {
		const { container } = render(() => <SettingsSearchBox value="" onInput={() => {}} />);
		expect(container.querySelector("button")).toBeNull();
	});
});

describe("SettingsSearchResults", () => {
	const rowsFor = (query: string) => {
		const { container } = render(() => (
			<SettingsSearchResults
				results={searchSettings(query, availableTabs, "desktop")}
				tabs={TABS}
				onSelect={() => {}}
			/>
		));
		return [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
	};

	it("lists a setting from a tab that was never mounted", () => {
		const rows = rowsFor("relay server url");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("Relay Server URL");
		// The trail names the tab and the section, so the row is self-locating
		expect(rows[0]).toContain("Remote Access");
		expect(rows[0]).toContain("Cloud Relay");
	});

	it("lists matches from several tabs at once", () => {
		// "terminal" no longer spans tabs — Story 858 consolidated every
		// terminal-related setting onto its own "Terminal" tab. "tab" still does:
		// General's "Confirm before closing a tab" and Appearance's tab-management
		// settings ("Split Tab Mode", "Tab Ordering", ...).
		const rows = rowsFor("tab");
		expect(rows.some((r) => r.includes("General"))).toBe(true);
		expect(rows.some((r) => r.includes("Appearance"))).toBe(true);
	});

	it("hands the selected entry back", () => {
		const onSelect = vi.fn();
		const { container } = render(() => (
			<SettingsSearchResults
				results={searchSettings("relay server url", availableTabs, "desktop")}
				tabs={TABS}
				onSelect={onSelect}
			/>
		));
		fireEvent.click(container.querySelector("button") as HTMLButtonElement);
		expect(onSelect).toHaveBeenCalledWith(
			expect.objectContaining({ tab: "remote-access", section: "Cloud Relay", label: "Relay Server URL" }),
		);
	});

	it("says so when nothing matches", () => {
		const { container } = render(() => (
			<SettingsSearchResults
				results={searchSettings("zzzzz", availableTabs, "desktop")}
				tabs={TABS}
				onSelect={() => {}}
			/>
		));
		expect(container.querySelectorAll("button")).toHaveLength(0);
		expect(container.textContent).toContain("No settings match");
	});
});

describe("scrollToSetting", () => {
	const mount = (html: string) => {
		const root = document.createElement("div");
		root.innerHTML = html;
		document.body.appendChild(root);
		return root;
	};

	const spyOn = (el: Element) => {
		const spy = vi.fn();
		(el as HTMLElement).scrollIntoView = spy;
		return spy;
	};

	it("scrolls to the section when no setting is named", () => {
		const root = mount("<h3>Remote Access</h3><h3>Cloud Relay</h3><h3>TUIC Tools</h3>");
		const spies = [...root.querySelectorAll("h3")].map(spyOn);
		expect(scrollToSetting(root, "Cloud Relay")).toBe(true);
		expect(spies[1]).toHaveBeenCalled();
		expect(spies[0]).not.toHaveBeenCalled();
	});

	it("scrolls to the setting itself, not just its section", () => {
		const root = mount("<h3>Cloud Relay</h3><label>Relay Server URL</label><label>Bearer Token</label>");
		const heading = spyOn(root.querySelector("h3") as Element);
		const labels = [...root.querySelectorAll("label")].map(spyOn);
		expect(scrollToSetting(root, "Cloud Relay", "Bearer Token")).toBe(true);
		expect(labels[1]).toHaveBeenCalled();
		expect(labels[0]).not.toHaveBeenCalled();
		expect(heading).not.toHaveBeenCalled();
	});

	it("finds a toggle label, which is a span beside its checkbox", () => {
		const root = mount("<h3>Terminal</h3><div><input type='checkbox'/><span>Copy on select</span></div>");
		const span = spyOn(root.querySelector("span") as Element);
		expect(scrollToSetting(root, "Terminal", "Copy on select")).toBe(true);
		expect(span).toHaveBeenCalled();
	});

	it("never crosses into the next section to find a repeated label", () => {
		// "Terminal" is a heading in two tabs and a label in a third — a label
		// hunt that ran past its own section would land on a stranger.
		const root = mount("<h3>Theme</h3><label>Terminal Font</label><h3>Tabs</h3><label>Terminal Font</label>");
		const labels = [...root.querySelectorAll("label")].map(spyOn);
		const heading = spyOn(root.querySelectorAll("h3")[1]);
		expect(scrollToSetting(root, "Tabs", "Terminal Font")).toBe(true);
		expect(labels[1]).toHaveBeenCalled();
		expect(labels[0]).not.toHaveBeenCalled();
		expect(heading).not.toHaveBeenCalled();
	});

	it("falls back to the section when the setting is not rendered", () => {
		const root = mount("<h3>Updates</h3><label>Update Channel</label>");
		const heading = spyOn(root.querySelector("h3") as Element);
		expect(scrollToSetting(root, "Updates", "Auto-Standby Timeout")).toBe(true);
		expect(heading).toHaveBeenCalled();
	});

	it("ignores the info badge a heading may carry after its text", () => {
		const root = mount("<h3>TUIC CLI<span>?What the CLI does</span></h3>");
		const spy = spyOn(root.querySelector("h3") as Element);
		expect(scrollToSetting(root, "TUIC CLI")).toBe(true);
		expect(spy).toHaveBeenCalled();
	});

	it("reports failure instead of scrolling to the wrong place", () => {
		const root = mount("<h3>Remote Access</h3>");
		const spy = spyOn(root.querySelector("h3") as Element);
		// A section behind a collapsed form is simply absent — never guess a target
		expect(scrollToSetting(root, "Add Provider", "API Key")).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("SettingsSearchResults — expert entries", () => {
	it("marks an expert setting with an Expert badge and a basic one without", () => {
		const { container } = render(() => (
			<SettingsSearchResults
				results={[
					{ tab: "general", section: "Terminal", label: "Basic thing" },
					{ tab: "general", section: "Terminal", label: "Expert thing", expert: true, configKey: "app.x" },
				]}
				tabs={TABS}
				onSelect={() => {}}
			/>
		));
		const [basic, expert] = [...container.querySelectorAll("button")];
		expect(basic.querySelector("[data-expert-badge]")).toBeNull();
		expect(expert.querySelector("[data-expert-badge]")?.textContent).toBe("Expert");
	});
});
