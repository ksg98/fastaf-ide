import { render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../mocks/tauri";

vi.mock("../../../stores/settings", () => ({
	settingsStore: {
		state: { ide: "vscode", font: "JetBrains Mono", defaultFontSize: 12 },
		isAiChatEnabled: () => false,
	},
	IDE_NAMES: { vscode: "VS Code" },
	FONT_FAMILIES: { "JetBrains Mono": "JetBrains Mono" },
}));

vi.mock("../../../stores/ui", () => ({
	uiStore: {
		state: { settingsNavWidth: 180 },
		setSettingsNavWidth: vi.fn(),
		persistUIPrefs: vi.fn(),
	},
}));

vi.mock("../../../stores/repositories", () => ({
	repositoriesStore: {
		state: { repositories: {}, repoOrder: [] },
		getAllReposOrdered: () => [],
		getConnectionId: () => undefined,
		setDisplayName: vi.fn(),
	},
}));

import { SettingsPanel } from "../../../components/SettingsPanel/SettingsPanel";
import { SETTINGS_SECTION_UPSTREAM_MCP } from "../../../components/SettingsPanel/sections";

/** Run the frame the scroll effect schedules. */
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

describe("SettingsPanel — deep link to a section", () => {
	let scrolled: Element[];

	beforeEach(() => {
		vi.clearAllMocks();
		scrolled = [];
		// jsdom has no layout, so scrollIntoView does not exist.
		Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
			scrolled.push(this);
		};
	});

	it("scrolls the upstream MCP block into view when asked for it", async () => {
		const { container } = render(() => (
			<SettingsPanel
				visible={true}
				onClose={() => {}}
				initialTab="services"
				initialSection={SETTINGS_SECTION_UPSTREAM_MCP}
			/>
		));

		const block = container.querySelector(`#${SETTINGS_SECTION_UPSTREAM_MCP}`);
		expect(block, "upstream MCP block should carry the anchor id").toBeTruthy();

		await nextFrame();
		expect(scrolled).toEqual([block]);
	});

	it("leaves the tab at the top when no section is requested", async () => {
		render(() => <SettingsPanel visible={true} onClose={() => {}} initialTab="services" />);
		await nextFrame();
		expect(scrolled).toEqual([]);
	});

	it("does not scroll while the panel is closed", async () => {
		render(() => (
			<SettingsPanel
				visible={false}
				onClose={() => {}}
				initialTab="services"
				initialSection={SETTINGS_SECTION_UPSTREAM_MCP}
			/>
		));
		await nextFrame();
		expect(scrolled).toEqual([]);
	});

	it("renames the Services nav entry so MCP is findable", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const labels = Array.from(container.querySelectorAll(".navItem")).map((n) => n.textContent);
		expect(labels).toContain("Services & MCP");
	});
});
