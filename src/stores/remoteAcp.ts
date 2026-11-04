import { createStore, produce } from "solid-js/store";
import { listen } from "../invoke";
import { rpc } from "../transport";
import { getRemoteBaseUrl } from "../transportRuntime";
import type { AcpElicitationAction, AcpNotice, AcpPendingInteraction, AcpRequestPermissionOutcome } from "../types/acp";
import { type RemoteEventPayload, remoteEventOrigin } from "../utils/remoteEventOrigin";
import { appLogger } from "./appLogger";
import { toastsStore } from "./toasts";
import { uiStore } from "./ui";

interface RemoteInteractions {
	daemonId: string;
	name: string;
	connectionId: string;
	interactions: AcpPendingInteraction[];
}

function createRemoteAcpStore() {
	const [state, setState] = createStore<{ entries: Record<string, RemoteInteractions> }>({ entries: {} });
	const revisions = new Map<string, number>();
	function remove(key: string, requestId?: string | null) {
		setState(
			"entries",
			produce((entries) => {
				const entry = entries[key];
				if (!entry) return;
				if (requestId) entry.interactions = entry.interactions.filter((item) => item.requestId !== requestId);
				if (!requestId || entry.interactions.length === 0) delete entries[key];
			}),
		);
	}
	listen<AcpNotice & RemoteEventPayload>("acp-notice", (event) => {
		const notice = event.payload;
		const origin = remoteEventOrigin(notice);
		if (!origin || !getRemoteBaseUrl(origin.connection) || typeof notice.connectionId !== "string") return;
		if (
			notice.kind !== "settled" &&
			notice.kind !== "interaction_pending" &&
			notice.kind !== "interaction_settled" &&
			notice.kind !== "ready"
		)
			return;
		const key = JSON.stringify([origin.connection, notice.connectionId]);
		const revision = (revisions.get(key) ?? 0) + 1;
		revisions.set(key, revision);
		if (notice.kind === "settled") {
			remove(key);
			return;
		}
		if (notice.kind === "interaction_settled") remove(key, notice.requestId);
		rpc<AcpPendingInteraction[]>("acp_pending_interactions", { connectionId: notice.connectionId }, origin.connection)
			.then((interactions) => {
				if (!getRemoteBaseUrl(origin.connection) || revisions.get(key) !== revision) return;
				const wasPending = state.entries[key]?.interactions.length;
				if (interactions.length === 0) {
					remove(key);
					return;
				}
				setState("entries", key, {
					daemonId: origin.connection,
					name: origin.name,
					connectionId: notice.connectionId,
					interactions,
				});
				if (!wasPending)
					toastsStore.add(`[${origin.name}] AI Chat response needed`, notice.connectionId, "warn", false, {
						label: "Open AI Chat",
						onClick: () => uiStore.setAiChatPanelVisible(true),
					});
			})
			.catch((error) => appLogger.debug("ai-chat", "Remote interaction refresh failed", error));
	}).catch((error) => appLogger.debug("ai-chat", "Remote notice listener failed", error));
	listen<RemoteEventPayload & { id: string; status: string }>("remote-connection-status", (event) => {
		const notice = event.payload;
		if (notice.__tuic_origin !== undefined || notice.status === "connected") return;
		for (const key of revisions.keys()) {
			if ((JSON.parse(key) as string[])[0] !== notice.id) continue;
			revisions.set(key, (revisions.get(key) ?? 0) + 1);
			remove(key);
		}
	}).catch((error) => appLogger.debug("ai-chat", "Remote disconnect listener failed", error));

	async function answer(
		key: string,
		requestId: string,
		kind: "permission" | "elicitation",
		response: AcpRequestPermissionOutcome | AcpElicitationAction,
	) {
		const entry = state.entries[key];
		if (
			!entry ||
			!getRemoteBaseUrl(entry.daemonId) ||
			!entry.interactions.some((item) => item.requestId === requestId && item.kind === kind)
		)
			return;
		const revision = revisions.get(key) ?? 0;
		try {
			await rpc(
				kind === "permission" ? "acp_respond_permission" : "acp_respond_elicitation",
				{
					connectionId: entry.connectionId,
					requestId,
					...(kind === "permission" ? { outcome: response } : { action: response }),
				},
				entry.daemonId,
			);
			// Invalidate the answer-start refresh without discarding newer notices.
			if (revisions.get(key) === revision) revisions.set(key, revision + 1);
			remove(key, requestId);
		} catch (error) {
			appLogger.debug("ai-chat", "Remote interaction response failed", error);
		}
	}
	return {
		state,
		answerPermission: (key: string, requestId: string, outcome: AcpRequestPermissionOutcome) =>
			answer(key, requestId, "permission", outcome),
		answerElicitation: (key: string, requestId: string, action: AcpElicitationAction) =>
			answer(key, requestId, "elicitation", action),
	};
}
export const remoteAcpStore = createRemoteAcpStore();
