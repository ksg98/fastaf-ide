import { fireEvent, render } from "@solidjs/testing-library";
import { Suspense } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../mocks/tauri";

const anthropic = {
	id: "anthropic-main",
	type: "anthropic" as const,
	label: "Anthropic",
	base_url: null,
};

const custom = {
	id: "cli-codex",
	type: "custom" as const,
	label: "Cli-codex",
	base_url: "http://localhost:8317",
};

const sonnet = {
	id: "model-sonnet",
	provider_id: "anthropic-main",
	model_name: "claude-sonnet-4-5",
	tier: "standard" as const,
};

const mockStore = vi.hoisted(() => ({
	state: {
		registry: {
			schema_version: 1,
			providers: [] as (typeof anthropic | typeof custom)[],
			models: [] as (typeof sonnet)[],
			slots: {} as Record<string, string>,
			features: {},
		},
		keyStatus: {} as Record<string, boolean>,
		loaded: true,
	},
	addProvider: vi.fn(),
	setProviderBaseUrl: vi.fn(),
	removeProvider: vi.fn(),
	addModel: vi.fn(),
	removeModel: vi.fn(),
	setSlot: vi.fn(),
	clearSlot: vi.fn(),
	saveKey: vi.fn(),
	deleteKey: vi.fn(),
	resolveSlot: vi.fn(() => null),
	_reset: vi.fn(),
}));

vi.mock("../../stores/providerRegistry", () => ({
	providerRegistryStore: mockStore,
}));

import { ProvidersTab } from "../../components/SettingsPanel/tabs/ProvidersTab";

describe("ProvidersTab", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStore.state.registry.providers = [];
		mockStore.state.registry.models = [];
		mockStore.state.registry.slots = {};
		mockStore.state.keyStatus = {};
		mockInvoke.mockResolvedValue(undefined);
	});

	// -- Provider list --

	it("renders empty state when no providers", () => {
		const { getByText } = render(() => <ProvidersTab />);
		expect(getByText(/No providers configured/)).toBeTruthy();
	});

	it("renders provider cards for each provider", () => {
		mockStore.state.registry.providers = [anthropic];
		const { getByTestId } = render(() => <ProvidersTab />);
		expect(getByTestId("provider-card-anthropic-main")).toBeTruthy();
	});

	it("shows provider label and type", () => {
		mockStore.state.registry.providers = [anthropic];
		const { getByText } = render(() => <ProvidersTab />);
		expect(getByText("Anthropic")).toBeTruthy();
	});

	it("shows model count", () => {
		mockStore.state.registry.providers = [anthropic];
		mockStore.state.registry.models = [sonnet];
		const { getByText } = render(() => <ProvidersTab />);
		expect(getByText(/Models \(1\)/)).toBeTruthy();
	});

	it("shows key status indicator", () => {
		mockStore.state.registry.providers = [anthropic];
		mockStore.state.keyStatus = { "anthropic-main": true };
		const { getByTestId } = render(() => <ProvidersTab />);
		expect(getByTestId("key-status-anthropic-main").textContent).toContain("✓ key");
	});

	it("shows 'no key' when key missing", () => {
		mockStore.state.registry.providers = [anthropic];
		mockStore.state.keyStatus = { "anthropic-main": false };
		const { getByTestId } = render(() => <ProvidersTab />);
		expect(getByTestId("key-status-anthropic-main").textContent).toContain("no key");
	});

	// -- Remove provider --

	it("calls removeProvider when × clicked", () => {
		mockStore.state.registry.providers = [anthropic];
		const { getByTestId } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("remove-provider-anthropic-main"));
		expect(mockStore.removeProvider).toHaveBeenCalledWith("anthropic-main");
	});

	// -- Add provider form --

	it("shows add provider form when + Add clicked", () => {
		const { getByTestId, getByText } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("add-provider-btn"));
		expect(getByTestId("add-provider-form")).toBeTruthy();
		expect(getByText("Add Provider")).toBeTruthy();
	});

	it("cancels add provider form", () => {
		const { getByTestId, queryByTestId, getByText } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("add-provider-btn"));
		fireEvent.click(getByText("Cancel"));
		expect(queryByTestId("add-provider-form")).toBeNull();
	});

	// -- Model CRUD --

	it("renders model entries", () => {
		mockStore.state.registry.providers = [anthropic];
		mockStore.state.registry.models = [sonnet];
		const { getByTestId } = render(() => <ProvidersTab />);
		expect(getByTestId("model-entry-model-sonnet")).toBeTruthy();
	});

	it("calls removeModel when model × clicked", () => {
		mockStore.state.registry.providers = [anthropic];
		mockStore.state.registry.models = [sonnet];
		const { getByTestId } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("remove-model-model-sonnet"));
		expect(mockStore.removeModel).toHaveBeenCalledWith("model-sonnet");
	});

	it("shows add model form when + Add model clicked", () => {
		mockStore.state.registry.providers = [anthropic];
		const { getByTestId } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("add-model-btn-anthropic-main"));
		expect(getByTestId("add-model-form")).toBeTruthy();
	});

	// -- Model discovery (custom / OpenAI-compatible providers) --

	it("populates the model dropdown from provider discovery", async () => {
		mockStore.state.registry.providers = [custom];
		mockInvoke.mockResolvedValue([
			{ id: "gpt-5.4", supports_reasoning: false },
			{ id: "gpt-5.6-sol", supports_reasoning: false },
		]);
		const { getByTestId, findByTestId } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("add-model-btn-cli-codex"));

		const select = (await findByTestId("model-select")) as HTMLSelectElement;
		expect([...select.options].map((o) => o.value)).toEqual(["", "gpt-5.4", "gpt-5.6-sol"]);
		expect(mockInvoke).toHaveBeenCalledWith("fetch_provider_models", { providerId: "cli-codex" });
	});

	it("offers the effort levels the endpoint advertises for the chosen model", async () => {
		mockStore.state.registry.providers = [custom];
		mockInvoke.mockResolvedValue([
			{
				id: "gpt-5.6-terra",
				supports_reasoning: true,
				effort_options: ["low", "high", "xhigh"],
				default_effort: "high",
			},
			{ id: "gpt-image-2", supports_reasoning: false },
		]);
		const { getByTestId, findByTestId, queryByTestId } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("add-model-btn-cli-codex"));

		const modelSelect = (await findByTestId("model-select")) as HTMLSelectElement;
		// No model chosen yet — nothing to advertise levels for.
		expect(queryByTestId("effort-select")).toBeNull();

		fireEvent.change(modelSelect, { target: { value: "gpt-5.6-terra" } });
		const effort = (await findByTestId("effort-select")) as HTMLSelectElement;
		expect([...effort.options].map((o) => o.value)).toEqual(["", "low", "high", "xhigh"]);
		// The endpoint's declared default is adopted on selection.
		expect(effort.value).toBe("high");

		// A model without reasoning gets no effort control at all.
		fireEvent.change(modelSelect, { target: { value: "gpt-image-2" } });
		expect(queryByTestId("effort-select")).toBeNull();
	});

	it("stores the chosen effort and a tier-qualified id on the model", async () => {
		mockStore.state.registry.providers = [custom];
		mockInvoke.mockResolvedValue([{ id: "gpt-5.6-terra", supports_reasoning: true, effort_options: ["low", "xhigh"] }]);
		const { getByTestId, findByTestId } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("add-model-btn-cli-codex"));

		fireEvent.change((await findByTestId("model-select")) as HTMLSelectElement, {
			target: { value: "gpt-5.6-terra" },
		});
		fireEvent.change((await findByTestId("effort-select")) as HTMLSelectElement, {
			target: { value: "xhigh" },
		});
		fireEvent.click(getByTestId("submit-add-model"));

		expect(mockStore.addModel).toHaveBeenCalledWith(
			expect.objectContaining({ model_name: "gpt-5.6-terra", effort: "xhigh", tier: "standard" }),
		);
		// Tier is in the id so the same model at two tiers doesn't collide.
		expect(mockStore.addModel.mock.calls[0][0].id).toBe("model-cli-codex-gpt-5-6-terra-standard");
	});

	it("falls back to manual entry when discovery fails", async () => {
		mockStore.state.registry.providers = [custom];
		mockInvoke.mockRejectedValue("Model discovery failed: HTTP 404");
		const { getByTestId, findByTestId, queryByTestId } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("add-model-btn-cli-codex"));

		expect(await findByTestId("retry-discovery")).toBeTruthy();
		expect(queryByTestId("model-select")).toBeNull();
	});

	// -- Base URL editing --

	it("saves an edited base URL without recreating the provider", () => {
		mockStore.state.registry.providers = [custom];
		const { getByTestId } = render(() => <ProvidersTab />);
		const input = getByTestId("base-url-cli-codex") as HTMLInputElement;
		expect(input.value).toBe("http://localhost:8317");

		fireEvent.input(input, { target: { value: "http://localhost:8317/v1" } });
		fireEvent.click(getByTestId("save-base-url-cli-codex"));

		expect(mockStore.setProviderBaseUrl).toHaveBeenCalledWith("cli-codex", "http://localhost:8317/v1");
		expect(mockStore.removeProvider).not.toHaveBeenCalled();
	});

	it("does not offer base URL editing for fixed-endpoint providers", () => {
		mockStore.state.registry.providers = [anthropic];
		const { queryByTestId } = render(() => <ProvidersTab />);
		expect(queryByTestId("base-url-anthropic-main")).toBeNull();
	});

	it("does not attempt discovery for fixed-endpoint providers", () => {
		mockStore.state.registry.providers = [anthropic];
		const { getByTestId } = render(() => <ProvidersTab />);
		fireEvent.click(getByTestId("add-model-btn-anthropic-main"));
		expect(mockInvoke).not.toHaveBeenCalledWith("fetch_provider_models", expect.anything());
	});

	// -- Slot assignments --

	it("renders slot assignment section", () => {
		const { getByTestId } = render(() => <ProvidersTab />);
		expect(getByTestId("slot-assignments")).toBeTruthy();
	});

	it("renders all 3 slot rows", () => {
		const { getByTestId } = render(() => <ProvidersTab />);
		for (const slot of ["main", "triage", "headless"]) {
			expect(getByTestId(`slot-row-${slot}`)).toBeTruthy();
		}
		// headless slot-select is only shown when External API is active
		for (const slot of ["main", "triage"]) {
			expect(getByTestId(`slot-select-${slot}`)).toBeTruthy();
		}
	});

	it("calls setSlot when slot dropdown changes", () => {
		mockStore.state.registry.providers = [anthropic];
		mockStore.state.registry.models = [sonnet];
		const { getByTestId } = render(() => <ProvidersTab />);
		fireEvent.change(getByTestId("slot-select-main"), { target: { value: "model-sonnet" } });
		expect(mockStore.setSlot).toHaveBeenCalledWith("main", "model-sonnet");
	});

	it("calls clearSlot when empty option selected", () => {
		mockStore.state.registry.providers = [anthropic];
		mockStore.state.registry.models = [sonnet];
		mockStore.state.registry.slots = { main: "model-sonnet" };
		const { getByTestId } = render(() => <ProvidersTab />);
		fireEvent.change(getByTestId("slot-select-main"), { target: { value: "" } });
		expect(mockStore.clearSlot).toHaveBeenCalledWith("main");
	});

	it("shows test button when slot is configured", () => {
		mockStore.state.registry.providers = [anthropic];
		mockStore.state.registry.models = [sonnet];
		mockStore.state.registry.slots = { main: "model-sonnet" };
		const { getByTestId } = render(() => <ProvidersTab />);
		expect(getByTestId("test-slot-main")).toBeTruthy();
	});

	// -- Suspense isolation --

	it("does not collapse an ancestor Suspense while ollama models load", async () => {
		const ollama = { id: "ollama-local", type: "ollama", label: "Ollama", base_url: null };
		mockStore.state.registry.providers = [ollama] as unknown as (typeof anthropic)[];
		// Keep every invoke (incl. check_ollama_models) pending forever — the
		// tab must still render instead of suspending the whole settings dialog.
		let resolveInvoke!: (value: unknown) => void;
		mockInvoke.mockReturnValue(
			new Promise((resolve) => {
				resolveInvoke = resolve;
			}),
		);
		const { queryByTestId } = render(() => (
			<Suspense fallback={<div data-testid="suspense-fallback" />}>
				<ProvidersTab />
			</Suspense>
		));
		expect(queryByTestId("suspense-fallback")).toBeNull();
		expect(queryByTestId("provider-card-ollama-local")).toBeTruthy();
		resolveInvoke(undefined);
		await Promise.resolve();
	});
});
