import { createSignal, onMount, Show } from "solid-js";
import type { WorkItemPluginSetup } from "../../../plugins/workItemSetup";
import { appLogger } from "../../../stores/appLogger";
import { pluginStore } from "../../../stores/pluginStore";
import { registryStore } from "../../../stores/registryStore";
import { Button } from "../../ui/Button";
import s from "./TasksSetup.module.css";

/**
 * Install button for one work-item plugin. A copy bundled with the build wins,
 * else the plugin registry's entry. FastAF currently bundles no provider and has
 * no registry (the upstream plugins are unlicensed), so TasksSetup and the
 * Plugins tab render this only for a provider that can be installed.
 */
export function InstallWorkItemPlugin(props: { setup: WorkItemPluginSetup; note?: string; compact?: boolean }) {
	const [installing, setInstalling] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [bundled, setBundled] = createSignal<string[] | null>(null);
	onMount(() => {
		void pluginStore
			.listBundled()
			.then(setBundled)
			.catch((cause) => {
				appLogger.warn("plugin", "Failed to list bundled plugins", cause);
				setBundled([]);
			});
		void registryStore.fetch();
	});
	const isBundled = () => bundled()?.includes(props.setup.pluginId) ?? false;
	const entry = () => registryStore.state.entries.find((candidate) => candidate.id === props.setup.pluginId);
	const available = () => isBundled() || Boolean(entry());
	const checking = () => bundled() === null || registryStore.state.loading;
	async function install() {
		if (!available() || installing()) return;
		setInstalling(true);
		setError(null);
		try {
			const found = entry();
			if (isBundled()) await pluginStore.installBundled(props.setup.pluginId);
			else if (found) await pluginStore.installFromUrl(found.downloadUrl);
		} catch (cause) {
			appLogger.error("plugin", `Failed to install plugin "${props.setup.pluginId}"`, cause);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setInstalling(false);
		}
	}
	return (
		<div class={s.install}>
			<Show when={!props.compact && props.note}>
				<span>{props.note}</span>
			</Show>
			<Button type="button" disabled={!available() || installing()} onClick={() => void install()}>
				{installing() ? "Installing…" : `Install ${props.setup.name}`}
			</Button>
			<Show when={!available() && !checking()}>
				<span class={s.muted}>Not available in this build.</span>
			</Show>
			<Show when={error()}>
				{(message) => (
					<span class={s.error} role="alert">
						Installation failed: {message()}
					</span>
				)}
			</Show>
		</div>
	);
}
