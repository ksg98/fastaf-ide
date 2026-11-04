/**
 * api mode is one call to FastAF's built-in engine: the provider assigned to
 * the Headless slot answers through `execute_api_prompt`.
 *
 * Everything a case here can exercise is the shape around that call: what is
 * refused before anything runs, what reaches the command, and how its answer
 * or failure is reported. The provider call itself is tested in Rust.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, slot, terminals, repositories, markAsUsed, writeClipboard, warn, toast } = vi.hoisted(() => ({
	invoke: vi.fn(),
	slot: { configured: true },
	terminals: { active: null as { id: string; cwd?: string; agentType?: string } | null },
	repositories: { active: null as { path: string } | null },
	markAsUsed: vi.fn(),
	writeClipboard: vi.fn(async () => {}),
	warn: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("../../invoke", () => ({ invoke }));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: toast } }));

vi.mock("../../stores/providerRegistry", () => ({
	providerRegistryStore: {
		resolveSlot: () => (slot.configured ? { provider: { id: "p1" }, model: { id: "m1" } } : null),
	},
}));

vi.mock("../../stores/terminals", () => ({
	terminalsStore: { getActive: () => terminals.active, isBusy: () => false },
}));

vi.mock("../../stores/repositories", () => ({
	repositoriesStore: { getActive: () => repositories.active, get: () => undefined },
}));

vi.mock("../../stores/github", () => ({
	githubStore: { getBranchPrData: () => null },
}));

vi.mock("../../stores/promptLibrary", () => ({
	promptLibraryStore: {
		markAsUsed,
		processContent: async (prompt: { content: string }) => prompt.content,
	},
}));

vi.mock("../../stores/agentConfigs", () => ({
	agentConfigsStore: {
		getHeadlessAgent: () => null,
		getHeadlessTemplate: () => undefined,
		getRunConfigs: () => [],
	},
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../utils/clipboard", () => ({ writeClipboard }));

vi.mock("../../hooks/usePty", () => ({ usePty: () => ({ sendCommand: vi.fn() }) }));

import { useSmartPrompts } from "../../hooks/useSmartPrompts";
import type { SavedPrompt } from "../../stores/promptLibrary";
import { runWithFeedback } from "../../utils/promptContext";

/** A saved prompt with only the fields a case here cares about. */
function prompt(over: Partial<SavedPrompt> = {}): SavedPrompt {
	return {
		id: "p1",
		name: "Summarise",
		content: "summarise this",
		category: "custom",
		isFavorite: false,
		createdAt: 1,
		updatedAt: 1,
		executionMode: "api",
		...over,
	} as SavedPrompt;
}

beforeEach(() => {
	vi.clearAllMocks();
	slot.configured = true;
	terminals.active = { id: "t1", cwd: "/repo" };
	repositories.active = { path: "/repo" };
	// Every execute resolves its variables first; nothing here uses one.
	invoke.mockImplementation(async (command: string) => {
		if (command === "resolve_prompt_variables") return { vars: {}, needed: [] };
		return "the answer";
	});
});

describe("Smart Prompts api mode", () => {
	// Catches: a structured ACP rejection reaches the toast as [object Object].
	it.each([
		[
			{ code: "agent_error", message: "Internal error: write-scoped probe failed", retryable: false },
			"agent_error: Internal error: write-scoped probe failed",
		],
		[{ message: "The agent could not start" }, "The agent could not start"],
		["agent unavailable", "agent unavailable"],
		[new Error("turn timed out"), "Error: turn timed out"],
	])("structured_prompt_failure_reaches_toast: %s", async (failure, expected) => {
		invoke.mockImplementation(async (command: string) => {
			if (command === "resolve_prompt_variables") return { vars: {}, needed: [] };
			throw failure;
		});
		const saved = prompt({ name: "Merge in main" });
		await runWithFeedback(saved, () => useSmartPrompts().executeSmartPrompt(saved));
		expect(toast).toHaveBeenCalledWith("Merge in main", expected, "warn");
		expect(markAsUsed).not.toHaveBeenCalled();
		expect(writeClipboard).not.toHaveBeenCalled();
	});

	it("refuses before calling anything when no Headless provider is assigned", async () => {
		slot.configured = false;

		const check = useSmartPrompts().canExecute(prompt());

		expect(check.ok).toBe(false);
		// The mode is not what failed, so the reason names where the fix is.
		expect(check.reason).toMatch(/Headless provider not configured/);
		expect(check.reason).toMatch(/Settings → Providers/);
		await useSmartPrompts().executeSmartPrompt(prompt());
		expect(invoke).not.toHaveBeenCalledWith("execute_api_prompt", expect.anything());
	});

	it("sends the processed content and the prompt's system prompt to the engine", async () => {
		await useSmartPrompts().executeSmartPrompt(prompt({ systemPrompt: "be brief" }));

		expect(invoke).toHaveBeenCalledWith("execute_api_prompt", {
			systemPrompt: "be brief",
			content: "summarise this",
			timeoutMs: 120000,
		});
	});

	it("sends a null system prompt rather than an empty one", async () => {
		await useSmartPrompts().executeSmartPrompt(prompt());

		expect(invoke).toHaveBeenCalledWith("execute_api_prompt", {
			systemPrompt: null,
			content: "summarise this",
			timeoutMs: 120000,
		});
	});

	it("sends what the provider said to the prompt's output target", async () => {
		const result = await useSmartPrompts().executeSmartPrompt(prompt({ outputTarget: "clipboard" }));

		expect(result).toEqual({ ok: true, output: "the answer" });
		expect(writeClipboard).toHaveBeenCalledWith("the answer");
		expect(markAsUsed).toHaveBeenCalledWith("p1");
	});

	it("reports what the command failed with rather than swallowing it", async () => {
		invoke.mockImplementation(async (command: string) => {
			if (command === "resolve_prompt_variables") return { vars: {}, needed: [] };
			throw new Error("provider timed out after 120s");
		});

		const result = await useSmartPrompts().executeSmartPrompt(prompt());

		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/provider timed out after 120s/);
	});

	it("runs the api headless agent on the same one path", async () => {
		// "api" is a headless agent the same way it is a mode. Two paths to one
		// behaviour would be two places to fix it.
		const saved = prompt({ executionMode: "headless", preferredAgent: "api" });

		expect(useSmartPrompts().canExecute(saved).ok).toBe(true);
		await useSmartPrompts().executeSmartPrompt(saved);

		expect(invoke).toHaveBeenCalledWith("execute_api_prompt", {
			systemPrompt: null,
			content: "summarise this",
			timeoutMs: 120000,
		});
	});

	it("refuses the api headless agent for the same reason as the mode", () => {
		slot.configured = false;

		const check = useSmartPrompts().canExecute(prompt({ executionMode: "headless", preferredAgent: "api" }));

		expect(check.ok).toBe(false);
		expect(check.reason).toMatch(/Headless provider not configured/);
	});
});
