import { onCleanup, onMount, Show } from "solid-js";
import { answerMcpConfirm, pendingConfirm, subscribeMcpConfirm } from "../../stores/mcpConfirm";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * Renders the confirmation an MCP agent is blocked on, wherever the human is.
 *
 * Mounted by both shells — desktop and mobile — so a request raised while the
 * user is away from the machine is still answerable. It deliberately does not
 * go through `useConfirmDialog`'s queue: this dialog can be resolved from
 * another client, which the local queue has no way to express.
 *
 * Cancel is the safe answer for the overlay click and Escape, matching what the
 * backend does when nobody answers at all.
 */
export function McpConfirmHost() {
	onMount(() => {
		const unsubscribe = subscribeMcpConfirm();
		onCleanup(() => {
			unsubscribe.then((fn) => fn()).catch(() => {});
		});
	});

	return (
		<Show when={pendingConfirm()}>
			{(request) => (
				<ConfirmDialog
					visible={true}
					title={request().title}
					message={request().message}
					confirmLabel="Confirm"
					cancelLabel="Cancel"
					kind="warning"
					// The agent is asking before something destructive, so an
					// accidental Enter must not be the one that approves it.
					defaultButton="cancel"
					onConfirm={() => void answerMcpConfirm(request().requestId, true)}
					onClose={() => void answerMcpConfirm(request().requestId, false)}
				/>
			)}
		</Show>
	);
}

export default McpConfirmHost;
