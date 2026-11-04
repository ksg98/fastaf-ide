import { describe, expect, it, vi } from "vitest";
import { type BrowserVoiceDeps, connectBrowserVoice } from "../../utils/browserVoice";

describe("connectBrowserVoice critic", () => {
	it("catches: resume failing after the mic is granted leaves the microphone tracks running", async () => {
		const track = { stop: vi.fn() };
		const stream = { getTracks: () => [track] } as unknown as MediaStream;
		const socket = { close: vi.fn() } as unknown as WebSocket;
		const context = {
			state: "suspended",
			resume: vi.fn().mockRejectedValue(new Error("closed")),
			close: vi.fn().mockResolvedValue(undefined),
		} as unknown as AudioContext;
		const deps: BrowserVoiceDeps = {
			openSocket: () => socket,
			getUserMedia: async () => stream,
			createContext: () => context,
			audioSession: () => undefined,
		};
		await expect(connectBrowserVoice("browser-x", deps)).rejects.toThrow("closed");
		expect(track.stop).toHaveBeenCalled();
	});
});
