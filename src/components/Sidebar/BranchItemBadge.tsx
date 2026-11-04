import { type Component, createSignal, Show } from "solid-js";
import { workItemProviderRegistry } from "../../plugins/workItemProviderRegistry";
import { workItemLinksStore } from "../../stores/workItemLinks";
import type { WorkItemState } from "../../types/work-items.gen";
import { onClickKeyDown } from "../../utils/a11y";
import { handleOpenUrl } from "../../utils/openUrl";
import s from "./BranchItemBadge.module.css";

/** Key and state of the work item linked to a worktree branch (story 1685-4b12, H5). */
export const BranchItemBadge: Component<{ repoPath: string; branch: string }> = (props) => {
	const link = () => workItemLinksStore.get(props.repoPath, props.branch);
	const [liveState, setLiveState] = createSignal<WorkItemState | null>(null);
	let loading = false;

	const state = () => liveState() ?? link()?.state ?? null;

	const refreshLiveState = () => {
		const current = link();
		if (!current || loading) return;
		const { providerId, accountId } = current.reference;
		const provider = workItemProviderRegistry.get(providerId, accountId);
		if (!provider) return;
		loading = true;
		provider
			.detail(current.reference)
			.then((detail) => setLiveState(detail.item.state))
			.catch(() => {
				// The stored state stays on screen; a provider outage is not a sidebar error.
			})
			.finally(() => {
				loading = false;
			});
	};

	// The row opens the branch and the chevron toggles its agents; this badge must
	// do neither (AGENTS.md "Sidebar clicks"), so the event stops here.
	const open = (e: Event) => {
		e.stopPropagation();
		const current = link();
		// DEFERRED (2026-10-11) — open the Tasks detail view instead of the browser
		// once B2 (story 1687-27a3) ships an "open item" entry point.
		if (current) handleOpenUrl(current.url);
	};

	return (
		<Show when={link()}>
			{(current) => (
				<span
					class={`${s.badge} ${s[state()?.tone ?? "neutral"]}`}
					role="link"
					tabIndex={0}
					data-testid="branch-item-badge"
					data-tooltip={[current().key, current().title, state()?.name].filter(Boolean).join(" · ")}
					data-tooltip-pos="bottom"
					onMouseEnter={refreshLiveState}
					onClick={open}
					onKeyDown={onClickKeyDown(open)}
				>
					{current().key}
				</span>
			)}
		</Show>
	);
};
