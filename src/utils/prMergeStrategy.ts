import { type MergeStrategy, repoDefaultsStore } from "../stores/repoDefaults";
import { repoSettingsStore } from "../stores/repoSettings";

/** The repo's preferred merge strategy, falling back to the global default. */
export function preferredMergeStrategy(repoPath: string): MergeStrategy {
	return repoSettingsStore.getEffective?.(repoPath)?.prMergeStrategy ?? repoDefaultsStore.state.prMergeStrategy;
}
