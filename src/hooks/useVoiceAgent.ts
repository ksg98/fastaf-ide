import { onCleanup } from "solid-js";
import { talkStore } from "../stores/talk";
import type { TalkBinding } from "../stores/talkController";

/** Everything the chat panel has to tell the conversation about its own state. */
export type VoiceAgentDeps = TalkBinding;

export interface VoiceAgentOptions {
	/**
	 * End the conversation when the panel goes away.
	 *
	 * True for a detached chat window, which is the only surface the
	 * conversation has there: the microphone is a process-wide singleton, so a
	 * session left behind would block dictation and the next conversation. The
	 * docked panel leaves it running — the dock under the terminal shows it.
	 */
	stopOnCleanup?: boolean;
}

/**
 * The chat panel's handle on talk mode.
 *
 * The conversation itself is window-wide (`talkStore`); a panel lends it the
 * session, autonomy and model it has selected for as long as it is open, and
 * gets the same start/stop controls the dock uses.
 */
export function useVoiceAgent(deps: VoiceAgentDeps, options: VoiceAgentOptions = {}) {
	const unbind = talkStore.bind(deps);
	onCleanup(() => {
		unbind();
		if (options.stopOnCleanup && talkStore.active()) void talkStore.stop();
	});
	return {
		active: talkStore.active,
		start: talkStore.start,
		stop: talkStore.stop,
		toggle: talkStore.toggle,
		bargeIn: talkStore.bargeIn,
	};
}
