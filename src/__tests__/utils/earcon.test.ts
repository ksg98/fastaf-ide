import { afterEach, describe, expect, it, vi } from "vitest";
import { EARCONS, type Earcon } from "../../utils/earcon";

/** The segmenter's `min_speech_ms` (`continuous.rs`): an earcon must stay well under it. */
const MIN_SPEECH_S = 0.2;

const sounding = (kind: Earcon) => EARCONS[kind].reduce((sum, note) => sum + note.duration, 0);

describe("earcon schedule", () => {
	it("delivered is two rising notes", () => {
		const [first, second] = EARCONS.delivered;
		expect(EARCONS.delivered).toHaveLength(2);
		expect(second.frequency).toBeGreaterThan(first.frequency);
	});

	it("dropped is two falling notes, quieter than delivered", () => {
		const [first, second] = EARCONS.dropped;
		expect(EARCONS.dropped).toHaveLength(2);
		expect(second.frequency).toBeLessThan(first.frequency);
		expect(first.peak).toBeLessThan(EARCONS.delivered[0].peak);
	});

	it.each(["delivered", "dropped"] as const)("%s cannot pass the VAD speech bar", (kind) => {
		for (const note of EARCONS[kind]) {
			expect(note.duration).toBeLessThan(0.12);
			expect(note.peak).toBeLessThanOrEqual(0.06);
		}
		// The segmenter sums speech across a gap, so the sum is what must stay short.
		expect(sounding(kind)).toBeLessThan(MIN_SPEECH_S * 0.75);
	});

	it.each(["delivered", "dropped"] as const)("%s notes are separated by a gap", (kind) => {
		const [first, second] = EARCONS[kind];
		expect(second.start).toBeGreaterThan(first.start + first.duration);
	});
});

describe("playEarcon", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("schedules one oscillator per note at its offset", async () => {
		const started: { frequency: number; at: number }[] = [];
		const param = () => ({ setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
		class FakeContext {
			state = "running";
			currentTime = 10;
			destination = {};
			createGain() {
				return { gain: param(), connect: (n: unknown) => n, disconnect: vi.fn() };
			}
			createOscillator() {
				let frequency = 0;
				return {
					type: "",
					frequency: { setValueAtTime: (hz: number) => (frequency = hz) },
					connect: (n: unknown) => n,
					disconnect: vi.fn(),
					start: (at: number) => started.push({ frequency, at }),
					stop: vi.fn(),
				};
			}
		}
		vi.stubGlobal("AudioContext", FakeContext);
		const { playEarcon } = await import("../../utils/earcon");

		playEarcon("delivered");

		expect(started).toEqual(EARCONS.delivered.map((n) => ({ frequency: n.frequency, at: 10 + n.start })));
	});
});
