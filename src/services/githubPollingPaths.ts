import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { rpc } from "../transport";
import { getRemoteBaseUrl, getRepoConnection } from "../transportRuntime";

/** Keep the local poller in the result even when every active repo is remote. */
export function groupGitHubPollingPaths(
	paths: string[],
	previousOwners: Iterable<string | undefined> = [],
): Map<string | undefined, string[]> {
	const grouped = new Map<string | undefined, string[]>([[undefined, []]]);
	for (const owner of previousOwners) grouped.set(owner, []);
	for (const path of paths) {
		const owner = getRepoConnection(path);
		const ownedPaths = grouped.get(owner) ?? [];
		ownedPaths.push(path);
		grouped.set(owner, ownedPaths);
	}
	return grouped;
}

/** Replace each owner's paths, including owners whose last active repo was removed. */
export function updateGitHubPollingPaths(paths: string[], previousOwners: Iterable<string | undefined> = []): void {
	for (const [owner, ownedPaths] of groupGitHubPollingPaths(paths, previousOwners)) {
		if (owner && !getRemoteBaseUrl(owner)) continue;
		const args = { paths: ownedPaths };
		const update = owner ? rpc("github_update_paths", args, owner) : invoke("github_update_paths", args);
		update.catch((error) => appLogger.debug("github", "Failed to update GitHub poller paths", error));
	}
}
