import { afterEach, expect, it, vi } from "vitest";
import { urlResolverRegistry } from "../components/CommandPalette/urlPaste";
import { invoke } from "../invoke";
import { createInMemoryWorkItemProvider } from "./testing/inMemoryWorkItemProvider";
import type { Disposable } from "./types";
import { handleWorkItemProviderRequest } from "./workItemMcpBridge";
import { workItemProviderRegistry } from "./workItemProviderRegistry";

vi.mock("../invoke", () => ({ invoke: vi.fn(), listen: vi.fn() }));
const disposables: Disposable[] = [];
afterEach(() => {
	for (const disposable of disposables.splice(0)) disposable.dispose();
	vi.resetAllMocks();
});
const reference = { providerId: "demo", accountId: "local", id: "1" };

// Catches: the bridge returning placeholder data instead of the registered provider detail/comments.
it("returns registered provider detail and a subsequent comment page", async () => {
	const provider = createInMemoryWorkItemProvider();
	disposables.push(workItemProviderRegistry.register(provider));
	const detail = await provider.detail(reference);
	vi.mocked(invoke).mockResolvedValueOnce({ kind: "detail", reference }).mockResolvedValueOnce(null);
	await handleWorkItemProviderRequest({ request_id: "read", request: { kind: "detail", reference } });
	expect(vi.mocked(invoke).mock.calls[1]?.[1]).toEqual({
		input: { action: "complete", requestId: "read", value: detail },
	});
	const comments = await provider.comments(reference, null, 1);
	expect(comments.nextCursor).not.toBeNull();
	const cursor = comments.nextCursor ?? "missing";
	vi.mocked(invoke)
		.mockResolvedValueOnce({ kind: "comments", reference, cursor, limit: 1 })
		.mockResolvedValueOnce(null);
	await handleWorkItemProviderRequest({
		request_id: "page",
		request: { kind: "comments", reference, cursor, limit: 1 },
	});
	expect(vi.mocked(invoke).mock.calls[3]?.[1]).toEqual({
		input: { action: "complete", requestId: "page", value: await provider.comments(reference, cursor, 1) },
	});
});

// Catches: comment/transition dispatch being dropped or an unclaimed duplicate changing provider state.
it("applies claimed writes once through the real local provider", async () => {
	const provider = createInMemoryWorkItemProvider();
	disposables.push(workItemProviderRegistry.register(provider));
	const operation = { kind: "comment", value: "MCP comment" } as const;
	vi.mocked(invoke)
		.mockResolvedValueOnce({ kind: "act", reference, operation })
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(null);
	const event = { request_id: "write", request: { kind: "act", reference, operation } as const };
	await handleWorkItemProviderRequest(event);
	await handleWorkItemProviderRequest(event);
	const page = await provider.comments(reference, null, 100);
	expect(page.entries.filter((entry) => entry.kind === "normal" && entry.value.body === "MCP comment")).toHaveLength(1);
	const transition = { kind: "transition", value: "closed" } as const;
	vi.mocked(invoke)
		.mockResolvedValueOnce({ kind: "act", reference, operation: transition })
		.mockResolvedValueOnce(null);
	await handleWorkItemProviderRequest({
		request_id: "transition",
		request: { kind: "act", reference, operation: transition },
	});
	expect((await provider.detail(reference)).item.state.id).toBe("closed");
});

// Catches: raw provider errors carrying credentials over the bridge.
it("returns a failure sentinel when a provider throws secret text", async () => {
	const provider = createInMemoryWorkItemProvider();
	disposables.push(
		workItemProviderRegistry.register({
			...provider,
			detail: async () => {
				throw new Error("token=secret-sentinel");
			},
		}),
	);
	vi.mocked(invoke).mockResolvedValueOnce({ kind: "detail", reference }).mockResolvedValueOnce(null);
	await handleWorkItemProviderRequest({ request_id: "error", request: { kind: "detail", reference } });
	expect(vi.mocked(invoke).mock.calls[1]?.[1]).toEqual({
		input: { action: "complete", requestId: "error", value: null },
	});
	expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain("secret-sentinel");
});

// Catches: URL lookup accidentally starting work or omitting the resolver's account-scoped reference.
it("resolves URLs through the existing resolver without starting work", async () => {
	disposables.push(workItemProviderRegistry.register(createInMemoryWorkItemProvider()));
	disposables.push(
		urlResolverRegistry.register("demo", async () => ({
			link: { reference, key: "DEMO-1", title: "Demo", url: "https://example.test/1", state: null },
		})),
	);
	const request = { kind: "resolve_url", url: "https://example.test/1" } as const;
	vi.mocked(invoke).mockResolvedValueOnce(request).mockResolvedValueOnce(null);
	await handleWorkItemProviderRequest({ request_id: "url", request });
	expect(vi.mocked(invoke).mock.calls[1]?.[1]).toEqual({
		input: { action: "complete", requestId: "url", value: reference },
	});
});
