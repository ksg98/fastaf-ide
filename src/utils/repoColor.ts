import { repoSettingsStore } from "../stores/repoSettings";
import { repositoriesStore, resolveRepoPathFor } from "../stores/repositories";

/** Color inheritance: repo color > group color > undefined */
export function getRepoColor(repoPath: string): string | undefined {
	return repoSettingsStore.get(repoPath)?.color || repositoriesStore.getGroupForRepo(repoPath)?.color || undefined;
}

/** The repo color for text: a repo name drawn in it. The user picks the color
 *  against a dark UI, so a light theme shades it by `--repo-text-shade`
 *  (global.css) to keep it readable; on other themes it is the color as picked.
 *  Swatches and fills keep using getRepoColor. */
export function getRepoTextColor(repoPath: string): string | undefined {
	const color = getRepoColor(resolveRepoPathFor(repoPath) ?? repoPath);
	return color ? `color-mix(in oklab, ${color}, #000 var(--repo-text-shade, 0%))` : undefined;
}
