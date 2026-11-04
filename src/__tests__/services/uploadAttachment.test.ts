import { afterEach, expect, it, vi } from "vitest";
import { uploadAttachment } from "../../services/uploadAttachment";

vi.mock("../../transport", () => ({ buildHttpUrl: (path: string) => `http://localhost${path}` }));
vi.mock("../../transportRuntime", () => ({
	getSessionConnection: () => undefined,
	getRemoteBaseUrl: () => undefined,
	withRemoteToken: (url: string) => url,
}));
afterEach(() => vi.unstubAllGlobals());

// Catches: uploads from two ACP conversations share storage or lose the backend access notice.
it("addresses the ACP conversation and preserves its read-root notice", async () => {
	const fetcher = vi.fn().mockResolvedValue(
		new Response(JSON.stringify({ path: "/tuic/attachments/acp-a/file", size: 4, notice: "Read root required" }), {
			status: 200,
		}),
	);
	vi.stubGlobal("fetch", fetcher);
	const receipt = await uploadAttachment(new File(["file"], "notes.txt"), {
		kind: "acp",
		id: "connection-a",
		session: "conversation-b",
	});
	const url = new URL(fetcher.mock.calls[0][0]);
	expect(url.searchParams.get("session")).toBe("conversation-b");
	expect(url.searchParams.get("id")).toBe("connection-a");
	expect(receipt.notice).toBe("Read root required");
});

// Catches: a legacy-agent grant rejection is swallowed and the composer silently stages a bad path.
it("surfaces the backend new-session notice on a legacy-agent rejection", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Start a new session" }), { status: 409 })),
	);
	await expect(uploadAttachment(new File(["file"], "notes.txt"), { kind: "pty", id: "old" })).rejects.toThrow(
		"Start a new session",
	);
});
