import { createSignal } from "solid-js";
import { reportPluginCallbackError } from "./pluginCallbackGuard";
import type { Disposable, FileIconProvider } from "./types";

/**
 * Registry for file icon providers.
 *
 * Plugins register a FileIconProvider that maps filenames/extensions to
 * inline SVG strings. Components query resolve() to get the icon for a
 * file entry. Last registered provider wins (with restore on dispose).
 *
 * The `version` signal increments on register/unregister so reactive
 * components re-render when the active provider changes.
 */
function createFileIconRegistry() {
	const [version, setVersion] = createSignal(0);
	// Registration stack — the top (last element) is the active provider.
	// Register pushes; dispose removes by identity, so out-of-order disposal
	// of any registration keeps the remaining chain intact (mirrors
	// markdownProviderRegistry's per-registration restore semantics).
	const providers: Array<{ pluginId?: string; provider: FileIconProvider }> = [];

	function register(provider: FileIconProvider, pluginId?: string): Disposable {
		const entry = { pluginId, provider };
		providers.push(entry);
		setVersion((v) => v + 1);

		return {
			dispose() {
				const index = providers.lastIndexOf(entry);
				if (index !== -1) {
					providers.splice(index, 1);
					setVersion((v) => v + 1);
				}
			},
		};
	}

	function resolve(name: string, isDir: boolean): string | null {
		const activeProvider = providers[providers.length - 1];
		if (!activeProvider) return null;
		try {
			return activeProvider.provider.resolveFileIcon(name, isDir);
		} catch (err) {
			reportPluginCallbackError(activeProvider.pluginId, "file icon resolve", err);
			return null;
		}
	}

	/** Reactive version number — read this in components to trigger re-render on provider change */
	function getVersion(): number {
		return version();
	}

	/** Remove all registrations (for testing). */
	function clear(): void {
		providers.length = 0;
		setVersion(0);
	}

	return { register, resolve, getVersion, clear };
}

export const fileIconRegistry = createFileIconRegistry();
