import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Suspense } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mockInvoke } from "../../../../__tests__/mocks/tauri";
import { agentConfigsStore } from "../../../../stores/agentConfigs";
import { settingsExpertStore } from "../../../../stores/settingsExpert";
import { SettingsShell } from "../../SettingsShell";
import { AgentsTab } from "../AgentsTab";

vi.mock("../../../../hooks/useAgentDetection", () => ({
	useAgentDetection: () => ({
		detectAll() {},
		detectVersion() {},
		isAvailable: () => false,
		getDetection: () => undefined,
	}),
}));
vi.mock("../../../../stores/appLogger", () => ({
	appLogger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
afterEach(() => settingsExpertStore._resetForTests());

it("catches a settings switch detaching the scroll container while its preview refreshes", async () => {
	const defaults = {
		app: {},
		agents: {},
		launch_instructions: { default_text: "Preview", required_markers: [], effective_text: {} },
	};
	let finishPreview: ((value: typeof defaults) => void) | undefined;
	let deferPreview = false;
	mockInvoke.mockImplementation(async (command) => {
		if (command === "get_config_defaults") {
			if (deferPreview)
				return new Promise<typeof defaults>((resolve) => {
					finishPreview = resolve;
				});
			return defaults;
		}
		if (command === "load_agents_config") return { agents: {}, launch_modules: {}, launch_additions_migrated: true };
		if (command === "list_installed_mcp_integrations") return [];
		return undefined;
	});
	await agentConfigsStore.hydrate();
	await settingsExpertStore.open();
	const view = render(() => (
		<Suspense fallback={<p>Loading settings</p>}>
			<SettingsShell visible title="Settings" onClose={() => {}} tabs={[]} activeTab="agents" onTabChange={() => {}}>
				<AgentsTab />
			</SettingsShell>
		</Suspense>
	));
	const toggle = await view.findByRole("checkbox", { name: "Waiting and long work" });
	const content = view.container.querySelector<HTMLElement>("[data-settings-content]")!;
	content.scrollTop = 200;
	deferPreview = true;
	fireEvent.click(toggle);
	await waitFor(() => expect(finishPreview).toBeDefined());
	try {
		expect(content.isConnected).toBe(true);
		expect(content.scrollTop).toBe(200);
		expect(toggle.isConnected).toBe(true);
	} finally {
		finishPreview?.(defaults);
	}
	await waitFor(() => expect(view.queryByText("Loading settings")).toBeNull());
});
