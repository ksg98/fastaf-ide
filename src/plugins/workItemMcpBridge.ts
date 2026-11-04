/** Transport adapter only: Rust resolves targets, validates replies and authorizes writes. */
import { urlResolverRegistry } from "../components/CommandPalette/urlPaste";
import { invoke, listen } from "../invoke";
import { tasksNotifications } from "../services/tasksNotifications";
import { appLogger } from "../stores/appLogger";
import type { WorkItemAction, WorkItemDetail, WorkItemRef } from "../types/work-items.gen";
import { workItemProviderRegistry } from "./workItemProviderRegistry";

type ProviderRequest =
	| { kind: "resolve_url"; url: string }
	| { kind: "find_key"; key: string; providerId: string; accountId: string; cursor: string | null }
	| { kind: "detail"; reference: WorkItemRef }
	| { kind: "comments"; reference: WorkItemRef; cursor: string; limit: number }
	| { kind: "act"; reference: WorkItemRef; operation: WorkItemAction };

function available(request: ProviderRequest): boolean {
	if (request.kind === "resolve_url") return workItemProviderRegistry.list().length > 0;
	const reference = request.kind === "find_key" ? request : request.reference;
	return workItemProviderRegistry.get(reference.providerId, reference.accountId) !== undefined;
}

async function dispatch(request: ProviderRequest, signal: AbortSignal): Promise<unknown> {
	if (request.kind === "resolve_url")
		return (await urlResolverRegistry.resolve(request.url, signal))?.link.reference ?? null;
	const reference = request.kind === "find_key" ? request : request.reference;
	const provider = workItemProviderRegistry.get(reference.providerId, reference.accountId);
	if (!provider) return null;
	switch (request.kind) {
		case "find_key":
			return provider.list(
				{
					filters: [],
					savedFilterId: null,
					search: request.key,
					sort: null,
					groupBy: null,
					cursor: request.cursor,
					limit: 100,
				},
				signal,
			);
		case "detail":
			return provider.detail(request.reference, signal);
		case "comments":
			return provider.comments(request.reference, request.cursor, request.limit, signal);
		case "act":
			return provider.act(request.reference, request.operation, signal);
	}
}

export async function handleWorkItemProviderRequest(event: {
	request_id: string;
	request: ProviderRequest;
}): Promise<void> {
	if (!available(event.request)) return;
	const request = await invoke<ProviderRequest | null>("work_item_provider_bridge", {
		input: { action: "claim", requestId: event.request_id },
	});
	if (!request) return;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);
	let value: unknown = null;
	try {
		value = await dispatch(request, controller.signal);
		if (request.kind === "detail" && value) void tasksNotifications.observe(value as WorkItemDetail);
		if (request.kind === "act" && value && (value as { kind?: string }).kind === "item") {
			void tasksNotifications.observe((value as { value: WorkItemDetail }).value, request.operation.kind === "comment");
		}
	} catch {
		// Raw provider errors can contain URLs, headers or account data.
		appLogger.warn("plugin", "Work-item MCP provider request failed");
	} finally {
		clearTimeout(timeout);
	}
	await invoke("work_item_provider_bridge", { input: { action: "complete", requestId: event.request_id, value } });
}

export function listenForWorkItemMcpRequests(): void {
	listen<{ request_id: string; request: ProviderRequest }>("work-item-provider-request", (event) => {
		void handleWorkItemProviderRequest(event.payload).catch(() =>
			appLogger.warn("plugin", "Work-item MCP bridge disconnected"),
		);
	}).catch(() => appLogger.error("plugin", "Cannot register work-item MCP bridge"));
}
