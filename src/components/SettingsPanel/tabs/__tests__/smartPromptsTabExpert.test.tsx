import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../../../../__tests__/mocks/tauri";

vi.mock("../../../../stores/ui", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({ settingsExpertMode: false });
	return {
		uiStore: {
			state,
			setSettingsExpertMode: (enabled: boolean) => setState("settingsExpertMode", enabled),
		},
	};
});

vi.mock("../../../../hooks/useAgentDetection", () => ({
	useAgentDetection: () => ({
		detectAll: vi.fn(),
		getAvailable: () => [{ type: "claude", available: true }],
		loading: () => false,
	}),
}));

import { agentConfigsStore } from "../../../../stores/agentConfigs";
import { settingsExpertStore } from "../../../../stores/settingsExpert";
import { uiStore } from "../../../../stores/ui";
import { SmartPromptsTab } from "../SmartPromptsTab";

// `AgentsConfig::default()` serializes no headless agent; it is not configured.
const DEFAULTS = { app: {}, notifications: {}, agent_settings: {}, agents: { headless_agent: null } };

let headlessAgent: string | undefined;
let agentsConfig: Record<string, unknown> = {};

async function setup(agent?: string, agents: Record<string, unknown> = {}) {
	headlessAgent = agent;
	agentsConfig = agents;
	await agentConfigsStore.hydrate();
	await settingsExpertStore.open();
}

const hasHeadlessAgent = (container: HTMLElement) =>
	[...container.querySelectorAll("label")].some((el) => el.textContent === "Headless Agent");

describe("SmartPromptsTab Headless Agent", () => {
	beforeEach(() => {
		uiStore.setSettingsExpertMode(false);
		mockInvoke.mockImplementation((cmd: string) => {
			if (cmd === "get_config_defaults") return Promise.resolve(DEFAULTS);
			if (cmd === "load_agents_config") return Promise.resolve({ agents: agentsConfig, headless_agent: headlessAgent });
			return Promise.resolve(undefined);
		});
	});

	afterEach(() => {
		settingsExpertStore._resetForTests();
		uiStore.setSettingsExpertMode(false);
	});

	// Headless Agent is a basic setting: the typical user picks one, so basic
	// mode shows it even while none is configured (the default).
	it("shows Headless Agent in basic mode while none is configured", async () => {
		await setup();
		const { container, getByText } = render(() => <SmartPromptsTab />);
		expect(getByText("Smart Prompts")).toBeDefined();
		expect(hasHeadlessAgent(container)).toBe(true);
	});

	describe("Headless Agent picker", () => {
		const RUN_CONFIGS = {
			claude: {
				run_configs: [{ name: "fast", command: "claude", args: ["-p"], env: {}, is_default: false }],
			},
		};
		const picker = (container: HTMLElement) =>
			[...container.querySelectorAll("select")].find((el) =>
				[...el.options].some((o) => o.textContent === "— Not configured —"),
			) as HTMLSelectElement;

		it("saves a run config choice as <agent>:<config>, the form executeHeadless parses", async () => {
			await setup(undefined, RUN_CONFIGS);
			const { container } = render(() => <SmartPromptsTab />);
			fireEvent.change(picker(container), { target: { value: "claude:fast" } });

			expect(agentConfigsStore.getHeadlessAgent()).toBe("claude:fast");
			const save = [...mockInvoke.mock.calls].reverse().find((call) => call[0] === "save_agents_config");
			expect(save?.[1]).toMatchObject({ config: { headless_agent: "claude:fast" } });
			expect(picker(container).value).toBe("claude:fast");
		});

		it("still saves a plain agent and clears on Not configured", async () => {
			await setup(undefined, RUN_CONFIGS);
			const { container } = render(() => <SmartPromptsTab />);
			fireEvent.change(picker(container), { target: { value: "claude" } });
			expect(agentConfigsStore.getHeadlessAgent()).toBe("claude");
			fireEvent.change(picker(container), { target: { value: "" } });
			expect(agentConfigsStore.getHeadlessAgent()).toBeNull();
		});

		it("rejects a value naming an unknown agent", async () => {
			await setup();
			const { container } = render(() => <SmartPromptsTab />);
			const select = picker(container);
			const bogus = document.createElement("option");
			bogus.value = "nope:fast";
			select.append(bogus);
			fireEvent.change(select, { target: { value: "nope:fast" } });
			expect(agentConfigsStore.getHeadlessAgent()).toBeNull();
		});
	});
});
