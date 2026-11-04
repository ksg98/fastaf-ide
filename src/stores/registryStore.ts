import { createStore } from "solid-js/store";
import { invoke } from "../invoke";
import { compareSemver } from "../utils/semver";

/** A plugin entry from the remote registry */
export interface RegistryEntry {
	id: string;
	name: string;
	description: string;
	author: string;
	repo: string;
	latestVersion: string;
	minAppVersion: string;
	capabilities: string[];
	downloadUrl: string;
	/** SHA-256 of the published payload tree, excluding mutable plugin data. */
	contentSha256?: string;
}

interface RegistryStoreState {
	entries: RegistryEntry[];
	loading: boolean;
	error: string | null;
	lastFetched: number | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * FastAF ships no plugin registry: `DEFAULT_REGISTRY_URL` in `src-tauri/src/registry.rs`
 * is `None`, so `fetch_plugin_registry` always answers an empty list. The UI hides
 * Browse and the update check while this is false. Flip both together.
 */
export const PLUGIN_REGISTRY_ENABLED = false;

const [state, setState] = createStore<RegistryStoreState>({
	entries: [],
	loading: false,
	error: null,
	lastFetched: null,
});

async function fetch(): Promise<void> {
	// Skip if recently fetched (within TTL)
	if (state.lastFetched && Date.now() - state.lastFetched < CACHE_TTL_MS) return;
	if (state.loading) return;

	setState({ loading: true, error: null });
	try {
		const entries = await invoke<RegistryEntry[]>("fetch_plugin_registry");
		setState({ entries, loading: false, lastFetched: Date.now() });
	} catch (err) {
		setState({ loading: false, error: String(err) });
	}
}

/** Force a fresh fetch, ignoring TTL cache */
async function refresh(): Promise<void> {
	setState({ lastFetched: null });
	await fetch();
}

/** Check if a plugin has an update available (semver-aware) */
function hasUpdate(
	installedId: string,
	installedVersion: string,
	installedContentSha256?: string,
): RegistryEntry | null {
	const entry = state.entries.find((e) => e.id === installedId);
	if (!entry) return null;
	const versionOrder = compareSemver(entry.latestVersion, installedVersion);
	if (versionOrder > 0) return entry;
	if (versionOrder < 0) return null;
	return entry.contentSha256 && installedContentSha256 && entry.contentSha256 !== installedContentSha256 ? entry : null;
}

export const registryStore = {
	state,
	fetch,
	refresh,
	hasUpdate,
};
