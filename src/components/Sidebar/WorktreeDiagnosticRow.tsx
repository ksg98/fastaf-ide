import { type Component, createSignal, Show } from "solid-js";
import { useRepository, type WorktreeDiagnostic } from "../../hooks/useRepository";
import { t } from "../../i18n";
import { repositoriesStore } from "../../stores/repositories";
import { cx } from "../../utils";
import { IconAlert } from "../icons";
import s from "./Sidebar.module.css";

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** One compact row per unavailable worktree registration; detail lives in the tooltip. */
export const WorktreeDiagnosticRow: Component<{ repoPath: string; diagnostic: WorktreeDiagnostic }> = (props) => {
	const repo = useRepository();
	const [busy, setBusy] = createSignal(false);
	const [confirmPrune, setConfirmPrune] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const fixable = () => props.diagnostic.state === "missing";
	const label = () =>
		props.diagnostic.state === "duplicate_branch"
			? t("sidebar.diagnosticDuplicate", "duplicate branch")
			: props.diagnostic.checkout_present
				? t("sidebar.diagnosticBroken", "link broken")
				: t("sidebar.diagnosticGone", "folder missing");

	async function run(action: "repair" | "prune") {
		setBusy(true);
		setError(null);
		try {
			await repo.resolveWorktreeDiagnostic(props.repoPath, props.diagnostic.path, action);
			repositoriesStore.bumpGitRevision(props.repoPath);
		} catch (e) {
			setError(String(e).replace(/^Error:\s*/, ""));
		} finally {
			setBusy(false);
			setConfirmPrune(false);
		}
	}

	return (
		<div data-testid="worktree-diagnostic">
			<div class={s.worktreeDiagnostic}>
				{/* The detail belongs to the description, not to the whole row: a tooltip on
				    the row would open together with the button's own. */}
				<span
					class={s.diagnosticInfo}
					data-tooltip={`${props.diagnostic.path}\n${props.diagnostic.guidance}`}
					data-tooltip-pos="bottom"
					data-tooltip-align="left"
				>
					{/* The alert sits where a branch row has its state dot, so the names line up. */}
					<span class={s.diagnosticIcon}>
						<IconAlert size={14} />
					</span>
					<span class={s.diagnosticName}>{baseName(props.diagnostic.path)}</span>
					<span class={s.diagnosticState}>{label()}</span>
				</span>
				<Show when={fixable()}>
					<Show
						when={props.diagnostic.checkout_present}
						fallback={
							<button
								type="button"
								class={cx(s.mergedCleanup, s.diagnosticAction, confirmPrune() && s.diagnosticConfirm)}
								disabled={busy()}
								data-testid="worktree-diagnostic-prune"
								data-tooltip={t(
									"sidebar.diagnosticPruneHint",
									"Drop the registration of the deleted folder; no files are deleted",
								)}
								data-tooltip-pos="bottom"
								data-tooltip-align="right"
								onClick={() => (confirmPrune() ? run("prune") : setConfirmPrune(true))}
								onBlur={() => setConfirmPrune(false)}
							>
								{confirmPrune()
									? t("sidebar.diagnosticPruneConfirm", "Confirm?")
									: t("sidebar.diagnosticPrune", "Prune")}
							</button>
						}
					>
						<button
							type="button"
							class={cx(s.mergedCleanup, s.diagnosticAction)}
							disabled={busy()}
							data-testid="worktree-diagnostic-repair"
							data-tooltip={t("sidebar.diagnosticRepairHint", "Run git worktree repair on this checkout")}
							data-tooltip-pos="bottom"
							data-tooltip-align="right"
							onClick={() => run("repair")}
						>
							{t("sidebar.diagnosticRepair", "Repair")}
						</button>
					</Show>
				</Show>
			</div>
			<Show when={error()}>
				<div class={s.diagnosticError} data-testid="worktree-diagnostic-error" data-tooltip={error()}>
					{error()}
				</div>
			</Show>
		</div>
	);
};
