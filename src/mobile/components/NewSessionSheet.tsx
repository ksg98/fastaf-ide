import { For, Show } from "solid-js";
import { appLogger } from "../../stores/appLogger";
import { toastsStore } from "../../stores/toasts";
import { rpc } from "../../transport";
import styles from "./NewSessionSheet.module.css";

interface NewSessionSheetProps {
	repos: string[];
	onDismiss: () => void;
}

function repoName(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] || path;
}

export function NewSessionSheet(props: NewSessionSheetProps) {
	async function createSession(cwd: string) {
		try {
			await rpc("create_pty", { config: { cwd } });
			// Dismiss only after the session is created; on failure keep the sheet
			// open so the user can retry.
			props.onDismiss();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			appLogger.warn("network", `Failed to create session: ${msg}`);
			toastsStore.add("Session failed", `Could not create session: ${msg}`, "error", true);
		}
	}

	const handleBackdropClick = (e: MouseEvent) => {
		if (e.target === e.currentTarget) {
			props.onDismiss();
		}
	};

	return (
		<div class={styles.backdrop} onClick={handleBackdropClick}>
			<div class={styles.sheet}>
				<div class={styles.title}>New Session</div>
				<Show when={props.repos.length > 0} fallback={<div class={styles.empty}>No repositories configured</div>}>
					<For each={props.repos}>
						{(repo) => (
							<button class={styles.repoItem} onClick={() => createSession(repo)}>
								<span class={styles.repoName}>{repoName(repo)}</span>
								<span class={styles.repoPath}>{repo}</span>
							</button>
						)}
					</For>
				</Show>
			</div>
		</div>
	);
}
