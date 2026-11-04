/**
 * Hands-free earcons: a rising two-note chirp that says a spoken turn reached
 * the agent, and a softer falling one that says the activation-phrase gate
 * dropped it. The direction carries the meaning, so each is recognisable on its
 * own — two single blips that differ only in pitch had to be compared to tell
 * apart.
 *
 * Synthesised with Web Audio on both transports — no asset, no native call.
 *
 * The capture VAD hears whatever the speakers play, and this is not routed
 * through the echo canceller. It does not need to be, because the chirp is too
 * short to count as speech. The segmenter (`continuous.rs`) adds up speech
 * frames across an utterance and only closes one after 800 ms of silence, so
 * the 40 ms gap does not reset anything: what matters is the *sum* of sounding
 * time. That is 60 + 70 = 130 ms, well under `min_speech_ms` (200 ms), and the
 * exponential decay drops each note below the energy floor before its end, so
 * the real figure is lower still. A chirp therefore can neither become a turn
 * nor pass the sustained-speech bar that hushes a reply. Keep every note under
 * 120 ms and the summed note durations of an earcon under 150 ms for that
 * reason. The peaks (0.06 / 0.03) stay as modest as the old single blips.
 */

export type Earcon = "delivered" | "dropped";

export interface Note {
	frequency: number;
	/** Offset from the start of the earcon, in seconds. */
	start: number;
	duration: number;
	peak: number;
}

const FIRST_S = 0.06;
const GAP_S = 0.04;
const SECOND_S = 0.07;

function chirp(from: number, to: number, peak: number): Note[] {
	return [
		{ frequency: from, start: 0, duration: FIRST_S, peak },
		{ frequency: to, start: FIRST_S + GAP_S, duration: SECOND_S, peak },
	];
}

/** Exported for the schedule tests; `playEarcon` is the only consumer. */
export const EARCONS: Record<Earcon, readonly Note[]> = {
	delivered: chirp(660, 990, 0.06),
	dropped: chirp(500, 330, 0.03),
};

const ATTACK_S = 0.005;

let context: AudioContext | null = null;

/**
 * Create the context ahead of the first earcon. Call it from the user action
 * that arms the conversation: a context first built with no gesture on the
 * stack may start suspended, and the first earcon would then be lost.
 */
export function primeEarcons(): void {
	try {
		context ??= new AudioContext();
		if (context.state === "suspended") void context.resume();
	} catch {
		// No Web Audio here; the earcons are a courtesy, never a requirement.
	}
}

export function playEarcon(kind: Earcon): void {
	primeEarcons();
	const ctx = context;
	if (!ctx) return;
	const now = ctx.currentTime;
	for (const { frequency, start, duration, peak } of EARCONS[kind]) {
		const at = now + start;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.setValueAtTime(frequency, at);
		// A ramp in and out: a sine switched on or off at full level clicks.
		gain.gain.setValueAtTime(0.0001, at);
		gain.gain.exponentialRampToValueAtTime(peak, at + ATTACK_S);
		gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
		osc.connect(gain).connect(ctx.destination);
		osc.start(at);
		osc.stop(at + duration);
		osc.onended = () => {
			osc.disconnect();
			gain.disconnect();
		};
	}
}
