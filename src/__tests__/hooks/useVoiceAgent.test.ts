import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTalk, unbind } = vi.hoisted(() => {
	const unbind = vi.fn();
	return {
		unbind,
		mockTalk: {
			active: vi.fn(() => false),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			toggle: vi.fn(),
			bargeIn: vi.fn(),
			bind: vi.fn(() => unbind),
		},
	};
});

vi.mock("../../stores/talk", () => ({ talkStore: mockTalk }));

import { useVoiceAgent, type VoiceAgentOptions } from "../../hooks/useVoiceAgent";

const deps = {
	sessionId: () => "sess-1",
	autonomy: () => "assisted",
	turnOptions: () => ({ modelOverride: "gpt-x" }),
};

/** Mount the hook the way a chat panel does and return its API plus a disposer. */
function mount(options?: VoiceAgentOptions) {
	let api!: ReturnType<typeof useVoiceAgent>;
	const dispose = createRoot((dispose) => {
		api = useVoiceAgent(deps, options);
		return dispose;
	});
	return { api, dispose };
}

beforeEach(() => {
	vi.clearAllMocks();
	mockTalk.active.mockReturnValue(false);
});

// The conversation itself is covered in stores/talkController.test.ts. This is
// only the panel's side of it: lending its settings, and taking them back.
describe("useVoiceAgent", () => {
	it("lends the panel's settings to the window's conversation while it is open", () => {
		const { dispose } = mount();
		expect(mockTalk.bind).toHaveBeenCalledWith(deps);
		expect(unbind).not.toHaveBeenCalled();
		dispose();
		expect(unbind).toHaveBeenCalledOnce();
	});

	it("hands the panel the same controls the dock uses", () => {
		const { api, dispose } = mount();
		api.toggle();
		api.bargeIn();
		expect(mockTalk.toggle).toHaveBeenCalledOnce();
		expect(mockTalk.bargeIn).toHaveBeenCalledOnce();
		expect(api.active).toBe(mockTalk.active);
		dispose();
	});

	// Catches: closing AI Chat hanging up a conversation the dock is still showing.
	it("leaves a running conversation alone when a docked panel closes", () => {
		mockTalk.active.mockReturnValue(true);
		const { dispose } = mount();
		dispose();
		expect(mockTalk.stop).not.toHaveBeenCalled();
	});

	// Catches: a detached chat window closing with the microphone still held —
	// it is a process-wide singleton, so dictation and the next conversation
	// would both be refused.
	it("ends the conversation with a detached window, its only surface", () => {
		mockTalk.active.mockReturnValue(true);
		const { dispose } = mount({ stopOnCleanup: true });
		dispose();
		expect(mockTalk.stop).toHaveBeenCalledOnce();
	});

	it("does not stop a conversation that is not running", () => {
		const { dispose } = mount({ stopOnCleanup: true });
		dispose();
		expect(mockTalk.stop).not.toHaveBeenCalled();
	});
});
