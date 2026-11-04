import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Transcript } from "../../components/AIChatPanel/Transcript";
import type { AcpTranscriptEntry } from "../../stores/acpTranscript";

afterEach(cleanup);
describe.each([false, true])("transcript touch follow mobile=%s", (mobile) => {
	// Catches: a small upward touch inside the old 24px threshold is overwritten by queued streaming follow.
	it.each(["touchEnd", "touchCancel"] as const)(
		"keeps a gentle upward touch detached after %s and resumes only at bottom",
		async (endEvent) => {
			const [entries, setEntries] = createSignal<AcpTranscriptEntry[]>([
				{ id: "answer", kind: "agent", text: "Initial answer" },
			]);
			const view = render(() => <Transcript mobile={mobile} entries={entries} busy={() => false} emptyMessage="" />);
			const viewport = view.getByLabelText("Chat transcript");
			let top = 0,
				height = 2000;
			Object.defineProperties(viewport, {
				clientHeight: { value: 400 },
				scrollHeight: { get: () => height },
				scrollTop: {
					get: () => top,
					set: (value: number) => {
						top = Math.min(value, height - 400);
					},
				},
			});
			await Promise.resolve();
			fireEvent.scroll(viewport);
			setEntries([{ id: "answer", kind: "agent", text: "Initial answer with streaming content" }]);
			fireEvent.touchStart(viewport);
			top -= 12;
			fireEvent.scroll(viewport);
			await Promise.resolve();
			expect(top).toBe(1588);
			fireEvent[endEvent](viewport);
			height += 20;
			setEntries([{ id: "answer", kind: "agent", text: "Initial answer with more streaming content" }]);
			await Promise.resolve();
			expect(top).toBe(1588);
			top = height - 400;
			fireEvent.scroll(viewport);
			height += 20;
			setEntries([{ id: "answer", kind: "agent", text: "Initial answer with final streaming content" }]);
			await Promise.resolve();
			expect(top).toBe(1640);
		},
	);
	// Catches: an active stationary touch is moved by an already-queued follow update.
	it("does not move a stationary touch when content grows before its queued follow", async () => {
		const [entries, setEntries] = createSignal<AcpTranscriptEntry[]>([{ id: "a", kind: "agent", text: "Hello" }]);
		const view = render(() => <Transcript mobile={mobile} entries={entries} busy={() => false} emptyMessage="" />);
		const viewport = view.getByLabelText("Chat transcript");
		let top = 0;
		Object.defineProperties(viewport, {
			scrollHeight: { value: 2000 },
			scrollTop: {
				get: () => top,
				set: (value) => {
					top = value;
				},
			},
		});
		await Promise.resolve();
		top = 1500;
		setEntries([{ id: "a", kind: "agent", text: "Hello again" }]);
		fireEvent.touchStart(viewport);
		await Promise.resolve();
		expect(top).toBe(1500);
		fireEvent.touchCancel(viewport);
	});
});
