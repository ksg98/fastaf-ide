import { terminalsStore } from "../../stores/terminals";

/**
 * Decide whether an agent's `intent:` title should overwrite the tab name.
 *
 * A user-renamed tab (`nameIsCustom`) must never be clobbered by an agent
 * intent title, mirroring the OSC 0/2 title guard. Both the global setting
 * and the per-agent override must allow it.
 */
export function shouldApplyIntentTitle(opts: {
	title: string | null | undefined;
	globalEnabled: boolean;
	perAgentEnabled: boolean;
	nameIsCustom: boolean;
}): boolean {
	return Boolean(opts.title) && opts.globalEnabled && opts.perAgentEnabled && !opts.nameIsCustom;
}

/**
 * Decide whether an OSC 0/2 terminal title should overwrite the tab name.
 *
 * A user rename and an explicit spawn name both outrank it: Claude Code sends
 * its own session title this way, which used to replace the name an
 * orchestrator gave the agent. An active intent title outranks it too, while
 * intent titles are enabled.
 */
export function shouldApplyOscTitle(opts: {
	nameIsCustom: boolean;
	nameFromSpawn: boolean;
	agentIntent: string | null;
	intentTabTitle: boolean;
}): boolean {
	return !opts.nameIsCustom && !opts.nameFromSpawn && !(opts.agentIntent && opts.intentTabTitle);
}

/** Apply one parsed intent event through the same store path used by Terminal. */
export function handleIntentEvent(opts: {
	terminalId: string;
	text: string;
	title: string | null | undefined;
	globalEnabled: boolean;
	perAgentEnabled: boolean;
}): void {
	terminalsStore.setAgentIntent(opts.terminalId, opts.text);
	const terminal = terminalsStore.get(opts.terminalId);
	if (
		shouldApplyIntentTitle({
			title: opts.title,
			globalEnabled: opts.globalEnabled,
			perAgentEnabled: opts.perAgentEnabled,
			nameIsCustom: terminal?.nameIsCustom ?? false,
		})
	) {
		terminalsStore.update(opts.terminalId, { name: opts.title! });
	}
}
