/**
 * `ego auth login PROVIDER`, run by a person in a terminal tab.
 *
 * The login is a browser round trip, a device code or an API key prompt, and
 * every one of them is ego talking to a person over a PTY. TUICommander only
 * opens the tab and types the command: it never sees a key, a code or a token,
 * and it never learns whether the login worked. The provider row says so, in
 * ego's words, once `ego doctor` is asked again.
 */

import { createEffect, createRoot } from "solid-js";
import { settingsStore } from "../stores/settings";
import { terminalsStore } from "../stores/terminals";
import { assignTabToActiveGroup } from "../utils/paneTabAssign";
import { escapeShellArg } from "../utils/shell";

/** The line typed into the tab. Both words that come from outside are quoted. */
export function egoLoginCommand(executable: string, provider: string): string {
	return `${escapeShellArg(executable)} auth login ${escapeShellArg(provider)}`;
}

/**
 * Open a focused terminal tab that runs the login, and call `onExit` once when
 * the command has finished (the shell is idle again) or the tab was closed.
 *
 * The shell stays open after ego exits so a refusal ("unknown provider") is
 * still on screen; the person closes the tab. Returns the terminal id.
 */
export function startEgoLogin(provider: string, onExit: () => void): string {
	const executable = settingsStore.state.egoExecutable.trim();
	if (!executable) throw new Error("The ego executable is not configured (Settings → General).");

	const id = terminalsStore.add({
		sessionId: null,
		fontSize: settingsStore.state.defaultFontSize,
		name: `ego login ${provider}`,
		cwd: null,
		awaitingInput: null,
	});
	terminalsStore.update(id, {
		nameIsCustom: true,
		pendingInitCommand: egoLoginCommand(executable, provider),
	});
	assignTabToActiveGroup(id, "terminal");
	terminalsStore.setActive(id);

	createRoot((dispose) => {
		// The shell's first idle is before the command; only busy → not busy is the end.
		let ran = false;
		createEffect(() => {
			const tab = terminalsStore.get(id);
			if (tab?.shellState === "busy") ran = true;
			if (tab && !(ran && tab.shellState !== "busy")) return;
			dispose();
			onExit();
		});
	});
	return id;
}
