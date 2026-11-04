import { createSignal } from "solid-js";
import type { Disposable } from "./types";
import type { WorkItemProvider } from "./workItemProvider";

/** Account-scoped providers; disposal of an old registration never removes its replacement. */
export function createWorkItemProviderRegistry() {
	const providers = new Map<string, WorkItemProvider>();
	const [revision, setRevision] = createSignal(0);
	const key = (providerId: string, accountId: string) => JSON.stringify([providerId, accountId]);
	return {
		register(provider: WorkItemProvider): Disposable {
			if (!provider.providerId.trim() || !provider.accountId.trim())
				throw new Error("Provider and account IDs are required");
			const id = key(provider.providerId, provider.accountId);
			if (providers.has(id)) throw new Error("Work-item provider/account is already registered");
			providers.set(id, provider);
			setRevision((value) => value + 1);
			let active = true;
			return {
				dispose() {
					if (!active) return;
					active = false;
					if (providers.get(id) !== provider) return;
					providers.delete(id);
					setRevision((value) => value + 1);
				},
			};
		},
		get(providerId: string, accountId: string): WorkItemProvider | undefined {
			revision();
			return providers.get(key(providerId, accountId));
		},
		list(providerId?: string): WorkItemProvider[] {
			revision();
			return [...providers.values()].filter(
				(provider) => providerId === undefined || provider.providerId === providerId,
			);
		},
	};
}

export const workItemProviderRegistry = createWorkItemProviderRegistry();
