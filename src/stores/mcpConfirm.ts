import { createSignal } from "solid-js";
import { rpc, subscribeEvents, type Unsubscribe } from "../transport";
import { appLogger } from "./appLogger";

/** A yes/no question an MCP agent is blocked on. */
export interface McpConfirmRequest {
	requestId: string;
	title: string;
	message: string;
	/** The TUIC session that asked, when the caller is bound to one. */
	originSessionId?: string;
}

interface McpConfirmPayload {
	request_id: string;
	title: string;
	message: string;
	origin_session_id?: string | null;
}

interface McpConfirmResolvedPayload {
	request_id: string;
}

const [queue, setQueue] = createSignal<McpConfirmRequest[]>([]);

/** The request currently on screen — the oldest one still unanswered. */
export const pendingConfirm = () => queue()[0] ?? null;

/** Test seam: reset the queue between cases. */
export function __resetMcpConfirmQueue() {
	setQueue([]);
}

function enqueue(payload: McpConfirmPayload) {
	const request: McpConfirmRequest = {
		requestId: payload.request_id,
		title: payload.title,
		message: payload.message,
		originSessionId: payload.origin_session_id ?? undefined,
	};
	// A reconnecting SSE client can be handed the same request twice; showing it
	// twice would leave a dead dialog behind after the first answer resolves it.
	setQueue((prev) => (prev.some((r) => r.requestId === request.requestId) ? prev : [...prev, request]));
}

function drop(requestId: string) {
	setQueue((prev) => prev.filter((r) => r.requestId !== requestId));
}

/**
 * Answer the request currently on screen.
 *
 * Drops it locally first: every client sees the same request, so the backend
 * broadcast that confirms the answer may arrive after the user has already
 * moved on, and a dialog that lingers until the round trip completes invites a
 * second click on a question that is already settled.
 */
export async function answerMcpConfirm(requestId: string, confirmed: boolean): Promise<void> {
	drop(requestId);
	try {
		await rpc("mcp_confirm_response", { requestId, confirmed });
	} catch (err) {
		appLogger.warn("network", `Failed to deliver confirm answer: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Listen for confirmations an MCP agent is blocked on.
 *
 * Every client subscribes — desktop, browser and mobile PWA alike — because the
 * answer gates a destructive operation and the human who has to give it may not
 * be at the machine. The first client to answer wins; `mcp-confirm-resolved`
 * tells the others to take the dialog down.
 */
export function subscribeMcpConfirm(): Promise<Unsubscribe> {
	return subscribeEvents({
		"mcp-confirm": (payload) => enqueue(payload as McpConfirmPayload),
		"mcp-confirm-resolved": (payload) => drop((payload as McpConfirmResolvedPayload).request_id),
	});
}
