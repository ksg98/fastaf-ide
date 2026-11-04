import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandWidget } from "../components/CommandWidget";

vi.mock("../../transport", () => ({
	rpc: vi.fn().mockResolvedValue(undefined),
}));

import { rpc } from "../../transport";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("CommandWidget", () => {
	it("renders nothing when agent has no commands", () => {
		const { container } = render(() => <CommandWidget sessionId="s1" agentType={null} onDismiss={() => {}} />);
		const buttons = container.querySelectorAll("button");
		expect(buttons.length).toBe(0);
	});

	it("renders command buttons for claude agent", () => {
		const { container } = render(() => <CommandWidget sessionId="s1" agentType="claude" onDismiss={() => {}} />);
		const buttons = container.querySelectorAll("button");
		// claude has 4 commands + 3 models + 1 permission toggle = 8
		expect(buttons.length).toBeGreaterThanOrEqual(4);
		const texts = Array.from(buttons).map((b) => b.textContent);
		expect(texts).toContain("/compact");
		expect(texts).toContain("/clear");
		expect(texts).toContain("/cost");
		expect(texts).toContain("/help");
	});

	it("offers Codex's supported status command instead of unsupported help", () => {
		const { container } = render(() => <CommandWidget sessionId="s1" agentType="codex" onDismiss={() => {}} />);
		const labels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent);
		expect(labels).toContain("/status");
		expect(labels).not.toContain("/help");
	});

	it("sends the supported Codex status command from the widget", async () => {
		const { container } = render(() => <CommandWidget sessionId="s1" agentType="codex" onDismiss={() => {}} />);
		fireEvent.click(
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "/status")!,
		);
		await waitFor(() => expect(rpc).toHaveBeenCalledWith("write_pty", { sessionId: "s1", data: "\r" }));
		expect(
			vi.mocked(rpc).mock.calls.filter(([command, args]) => command === "write_pty" && args?.data === "/status"),
		).toHaveLength(1);
	});

	it("renders model buttons for claude-code agent", () => {
		const { container } = render(() => <CommandWidget sessionId="s1" agentType="claude" onDismiss={() => {}} />);
		const buttons = container.querySelectorAll("button");
		const texts = Array.from(buttons).map((b) => b.textContent);
		expect(texts).toContain("opus");
		expect(texts).toContain("sonnet");
		expect(texts).toContain("haiku");
	});

	it("sends slash command via write_pty on click", async () => {
		const onDismiss = vi.fn();
		const { container } = render(() => <CommandWidget sessionId="s1" agentType="claude" onDismiss={onDismiss} />);
		const buttons = container.querySelectorAll("button");
		const compactBtn = Array.from(buttons).find((b) => b.textContent === "/compact")!;
		fireEvent.click(compactBtn);
		await waitFor(() => {
			expect(rpc).toHaveBeenCalledWith("write_pty", {
				sessionId: "s1",
				data: "\x15",
			});
			expect(rpc).toHaveBeenCalledWith("write_pty", {
				sessionId: "s1",
				data: "/compact",
			});
			expect(rpc).toHaveBeenCalledWith("write_pty", {
				sessionId: "s1",
				data: "\r",
			});
		});
		expect(onDismiss).toHaveBeenCalled();
	});

	it("sends model switch command via write_pty", async () => {
		const onDismiss = vi.fn();
		const { container } = render(() => <CommandWidget sessionId="s1" agentType="claude" onDismiss={onDismiss} />);
		const buttons = container.querySelectorAll("button");
		const opusBtn = Array.from(buttons).find((b) => b.textContent === "opus")!;
		fireEvent.click(opusBtn);
		await waitFor(() => {
			expect(rpc).toHaveBeenCalledWith("write_pty", {
				sessionId: "s1",
				data: "\x15",
			});
			expect(rpc).toHaveBeenCalledWith("write_pty", {
				sessionId: "s1",
				data: "/model opus",
			});
			expect(rpc).toHaveBeenCalledWith("write_pty", {
				sessionId: "s1",
				data: "\r",
			});
		});
		expect(onDismiss).toHaveBeenCalled();
	});

	it("sends permission toggle sequence", async () => {
		const onDismiss = vi.fn();
		const { container } = render(() => <CommandWidget sessionId="s1" agentType="claude" onDismiss={onDismiss} />);
		const buttons = container.querySelectorAll("button");
		const permBtn = Array.from(buttons).find((b) => b.textContent?.includes("Permission"))!;
		fireEvent.click(permBtn);
		await waitFor(() => {
			expect(rpc).toHaveBeenCalledWith("write_pty", {
				sessionId: "s1",
				data: "\x1b[Z",
			});
			// Sheet dismisses only after the write resolves (see AC: sheets not
			// dismissed before the write succeeds).
			expect(onDismiss).toHaveBeenCalled();
		});
	});

	// Catches: removed harness commands remaining available on mobile terminals.
	it("does not render agent commands or models for a removed harness", () => {
		const { container } = render(() => <CommandWidget sessionId="s1" agentType="aider" onDismiss={() => {}} />);
		const buttons = container.querySelectorAll("button");
		const texts = Array.from(buttons).map((b) => b.textContent);
		expect(texts).not.toContain("/clear");
		expect(texts).not.toContain("/help");
		expect(texts).not.toContain("/tokens");
		expect(texts).not.toContain("opus");
	});

	it("calls onDismiss when backdrop is clicked", async () => {
		const onDismiss = vi.fn();
		const { container } = render(() => <CommandWidget sessionId="s1" agentType="claude" onDismiss={onDismiss} />);
		const backdrop = container.firstElementChild as HTMLElement;
		await fireEvent.click(backdrop);
		expect(onDismiss).toHaveBeenCalled();
	});
});
