import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlashMenuOverlay } from "../components/SlashMenuOverlay";
import type { SlashMenuItem } from "../useSessions";

vi.mock("../../transport", () => ({
	rpc: vi.fn(() => Promise.resolve()),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const ITEMS: SlashMenuItem[] = [
	{ command: "/help", description: "Get help with using Claude Code", highlighted: false },
	{ command: "/review", description: "Review your code", highlighted: true },
	{ command: "/clear", description: "Clear conversation history", highlighted: false },
];

const SESSION_ID = "test-session-123";

describe("SlashMenuOverlay", () => {
	it("renders a button for each available command", () => {
		const { container } = render(() => <SlashMenuOverlay items={ITEMS} sessionId={SESSION_ID} onSelect={() => {}} />);
		expect(container.querySelectorAll("button.item").length).toBe(3);
	});

	it("displays command and description text", () => {
		const { container } = render(() => <SlashMenuOverlay items={ITEMS} sessionId={SESSION_ID} onSelect={() => {}} />);
		const itemBtns = container.querySelectorAll("button.item");
		expect(itemBtns[0].textContent).toContain("/help");
		expect(itemBtns[0].textContent).toContain("Get help with using Claude Code");
		expect(itemBtns[1].textContent).toContain("/review");
	});

	it("calls onSelect with command on click", async () => {
		const onSelect = vi.fn();
		const { container } = render(() => <SlashMenuOverlay items={ITEMS} sessionId={SESSION_ID} onSelect={onSelect} />);
		const itemBtns = container.querySelectorAll("button.item");
		await fireEvent.click(itemBtns[1]); // click /review
		expect(onSelect).toHaveBeenCalledWith("/review");
	});

	it("highlights the item with highlighted=true", () => {
		const { container } = render(() => <SlashMenuOverlay items={ITEMS} sessionId={SESSION_ID} onSelect={() => {}} />);
		const buttons = container.querySelectorAll("button.item");
		expect(buttons[1].className).toContain("Highlighted");
		expect(buttons[0].className).not.toContain("Highlighted");
	});

	it("renders no command choices when no items are available", () => {
		const { container } = render(() => <SlashMenuOverlay items={[]} sessionId={SESSION_ID} onSelect={() => {}} />);
		expect(container.querySelectorAll("button.item").length).toBe(0);
	});

	it("sends arrow-up escape sequence on nav up click", async () => {
		const { rpc } = await import("../../transport");
		const { container } = render(() => <SlashMenuOverlay items={ITEMS} sessionId={SESSION_ID} onSelect={() => {}} />);
		await fireEvent.click(container.querySelector('[aria-label="Previous"]')!);
		expect(rpc).toHaveBeenCalledWith("write_pty", { sessionId: SESSION_ID, data: "\x1b[A" });
	});

	it("sends arrow-down escape sequence on nav down click", async () => {
		const { rpc } = await import("../../transport");
		const { container } = render(() => <SlashMenuOverlay items={ITEMS} sessionId={SESSION_ID} onSelect={() => {}} />);
		await fireEvent.click(container.querySelector('[aria-label="Next"]')!);
		expect(rpc).toHaveBeenCalledWith("write_pty", { sessionId: SESSION_ID, data: "\x1b[B" });
	});
});
