// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../components/AIChatPanel/Transcript";
import { CommandInput } from "../components/CommandInput";
import { MobileJumpBottom } from "../components/MobileJumpBottom";
import { OutputView } from "../components/OutputView";
import { TerminalKeybar } from "../components/TerminalKeybar";
import styles from "../screens/SessionDetailScreen.module.css";

const { rpc, subscribePty } = vi.hoisted(() => ({
	rpc: vi.fn(),
	subscribePty: vi.fn(async () => () => {}),
}));
vi.mock("../../transport", () => ({ rpc, subscribePty, isTauri: () => false }));

let frames: FrameRequestCallback[];
beforeEach(() => {
	frames = [];
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({ lines: ["Latest output"], total_lines: 1, offset: 0 }),
		})),
	);
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

async function setup(mode: "CLI" | "Chat") {
	const [atBottom, setAtBottom] = createSignal(true);
	let jump: (() => void) | undefined;
	const register = (fn: (() => void) | undefined) => {
		jump = fn;
	};
	const view = render(() => (
		<>
			<div class={styles.outputArea} data-output-area>
				{mode === "CLI" ? (
					<OutputView sessionId="owned" onAtBottomChange={setAtBottom} onRegisterScrollToBottom={register} />
				) : (
					<Transcript
						mobile
						entries={() => [{ id: "answer", kind: "agent", text: "Latest answer" }]}
						busy={() => false}
						emptyMessage=""
						onAtBottomChange={setAtBottom}
						onRegisterScrollToBottom={register}
					/>
				)}
				<MobileJumpBottom visible={!atBottom()} onScrollToBottom={() => jump?.()} />
			</div>
			<TerminalKeybar sessionId="owned" />
			<CommandInput sessionId="owned" sessionExists={false} />
		</>
	));
	const viewport = (
		mode === "CLI" ? view.container.firstElementChild?.firstElementChild : view.getByLabelText("Chat transcript")
	) as HTMLDivElement;
	let top = 0;
	Object.defineProperties(viewport, {
		clientHeight: { value: 400 },
		scrollHeight: { value: 2000 },
		scrollTop: {
			get: () => top,
			set: (value: number) => {
				top = Math.max(0, Math.min(1600, value));
			},
		},
	});
	if (mode === "CLI") await waitFor(() => expect(subscribePty).toHaveBeenCalled());
	await Promise.resolve();
	const paint = () => {
		for (const callback of frames.splice(0)) callback(0);
	};
	paint();
	const scroll = (value: number) => {
		viewport.scrollTop = value;
		fireEvent.scroll(viewport);
	};
	scroll(1600);
	return { ...view, viewport, paint, scroll };
}

describe.each(["CLI", "Chat"] as const)("mobile %s jump to bottom", (mode) => {
	it("floats outside composer and hides at bottom, catching misplaced or stale jump controls", async () => {
		const view = await setup(mode);
		expect(view.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();
		view.scroll(1200);
		const button = view.getByRole("button", { name: "Scroll to bottom" });
		expect(button.parentElement).not.toBe(view.getByRole("button", { name: "Send" }).parentElement);
		view.scroll(1599.5);
		expect(view.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();
	});

	it("jumps through the view action and hides without sending a PTY key or changing standard keys", async () => {
		const view = await setup(mode);
		const keys = () =>
			view
				.getAllByRole("button")
				.filter((button) => button.getAttribute("aria-label") !== "Scroll to bottom")
				.map((button) => button.textContent);
		const before = keys();
		view.scroll(800);
		fireEvent.click(view.getByRole("button", { name: "Scroll to bottom" }));
		view.paint();
		expect(view.viewport.scrollTop).toBe(1600);
		expect(view.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();
		expect(keys()).toEqual(before);
		expect(rpc).not.toHaveBeenCalled();
	});
});
