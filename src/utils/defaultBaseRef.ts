import type { BaseRefOption } from "../hooks/useRepository";

/** The saved value that means "the repository's own default branch". */
export const AUTOMATIC_BASE = "automatic";

/**
 * The "Start from" option a project's saved base branch names.
 *
 * The saved value is either the option the user made the default in the New
 * Worktree dialog ("origin/staging") or a bare name from Settings ("develop"),
 * which also stands for that branch on a remote when there is no local one.
 * Nothing saved, "automatic", or a branch that is gone all fall back to the
 * first option, which the backend lists as the repository's default branch.
 */
export function resolveDefaultBaseRef(options: BaseRefOption[], saved: string | null | undefined): string | undefined {
	const fallback = options[0]?.name;
	if (!saved || saved === AUTOMATIC_BASE) return fallback;
	if (options.some((option) => option.name === saved)) return saved;
	const onRemote = options.find(
		(option) => option.kind === "remote" && option.name.slice(option.name.indexOf("/") + 1) === saved,
	);
	return onRemote?.name ?? fallback;
}
