import { lazy, Show, Suspense } from "solid-js";
import { automationsUi } from "../../stores/automations";
import { repositoriesStore } from "../../stores/repositories";
import { getRepoConnection } from "../../transportRuntime";

const Dialog = lazy(() => import("./AutomationsDialog").then((module) => ({ default: module.AutomationsDialog })));
function OwnedDialog() {
	const connectionId = getRepoConnection(repositoriesStore.state.activeRepoPath);
	// Profile notices are produced by this machine's startup validation, never
	// by the repository that happens to be focused when the user clicks Fix.
	return (
		<Show when={{ connectionId: automationsUi.requestedDefinition() ? undefined : connectionId }} keyed>
			{(owner) => <Dialog connectionId={owner.connectionId} onClose={automationsUi.close} />}
		</Show>
	);
}
export function AutomationsHost() {
	return (
		<Show when={automationsUi.visible()}>
			<Suspense>
				<OwnedDialog />
			</Suspense>
		</Show>
	);
}
