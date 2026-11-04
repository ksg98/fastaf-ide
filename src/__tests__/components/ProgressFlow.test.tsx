import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ProgressFlow } from "../../components/ProgressDialog/ProgressFlow";
import type { ProgressFlow as Flow } from "../../stores/progress";

vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: vi.fn(), error: vi.fn() } }));

function flow(): Flow {
	return {
		project: "/repo",
		truncated: false,
		participants: [
			{
				id: "lead",
				kind: "terminal",
				title: "Lead",
				state: "busy",
				toolCalls: 0,
				ptyId: "lead",
				intent: "Split the work",
			},
			{ id: "w1", kind: "terminal", title: "Worker", state: "closed", parent: "lead", toolCalls: 0, ptyId: "w1" },
			{
				id: "lead/a1",
				kind: "subagent",
				title: "Scout",
				agentType: "Explore",
				state: "done",
				parent: "lead",
				toolCalls: 14,
				ptyId: "lead",
				agentId: "a1",
			},
		],
		events: [
			{ id: "entry:1", kind: "intent", from: "lead", summary: "Split the work", atMs: 1 },
			{
				id: "entry:2",
				kind: "delegated",
				from: "lead",
				to: "w1",
				summary: "Write the lexer",
				text: "Write the lexer in full",
				atMs: 2,
			},
			{ id: "entry:3", kind: "done", from: "w1", to: "lead", summary: "Lexer shipped", atMs: 3 },
			{
				id: "lead/a1:return",
				kind: "subagent_return",
				from: "lead/a1",
				to: "lead",
				summary: "Two issues…",
				detail: { ptyId: "lead", agentId: "a1", part: "report" },
				atMs: 4,
			},
		],
	};
}

describe("ProgressFlow", () => {
	it("gives every participant a column header with its state and tool count", () => {
		render(() => <ProgressFlow flow={flow()} fetchDetail={vi.fn()} />);
		expect(screen.getByText("Lead")).toBeTruthy();
		expect(screen.getByText("working")).toBeTruthy();
		expect(screen.getByText("closed")).toBeTruthy();
		expect(screen.getByText("14 tool calls")).toBeTruthy();
		expect(screen.getAllByText("Split the work")).toHaveLength(2);
	});

	it("draws a hand-off as an arrow between the two columns, in its direction", () => {
		const { container } = render(() => <ProgressFlow flow={flow()} fetchDetail={vi.fn()} />);
		const rows = Array.from(container.querySelectorAll("[data-kind]")).filter((el) => el.querySelector("[data-dir]"));
		const directions = rows.map((row) => [
			row.getAttribute("data-kind"),
			row.querySelector("[data-dir]")?.getAttribute("data-dir"),
			(row.querySelector("[data-dir]") as HTMLElement).style.gridColumn,
		]);
		expect(directions).toEqual([
			["delegated", "right", "1 / 3"],
			["done", "left", "1 / 3"],
			["subagent_return", "left", "1 / 4"],
		]);
	});

	it("expands a journal arrow inline, without a request", () => {
		const fetchDetail = vi.fn();
		render(() => <ProgressFlow flow={flow()} fetchDetail={fetchDetail} />);
		fireEvent.click(screen.getByText("Write the lexer"));
		expect(screen.getByText("Write the lexer in full")).toBeTruthy();
		expect(fetchDetail).not.toHaveBeenCalled();
	});

	it("fetches a subagent's full report only when it is expanded", async () => {
		const fetchDetail = vi.fn().mockResolvedValue("Two issues found: A and B.");
		render(() => <ProgressFlow flow={flow()} fetchDetail={fetchDetail} />);
		expect(fetchDetail).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("Two issues…"));
		expect(fetchDetail).toHaveBeenCalledWith({ ptyId: "lead", agentId: "a1", part: "report" });
		expect(await screen.findByText("Two issues found: A and B.")).toBeTruthy();
	});

	it("says the full text is unavailable instead of failing silently", async () => {
		const fetchDetail = vi.fn().mockRejectedValue(new Error("not_found"));
		render(() => <ProgressFlow flow={flow()} fetchDetail={fetchDetail} />);
		fireEvent.click(screen.getByText("Two issues…"));
		expect(await screen.findByText("Full text unavailable.")).toBeTruthy();
	});

	it("does not offer to expand an arrow that has nothing more to show", () => {
		render(() => <ProgressFlow flow={flow()} fetchDetail={vi.fn()} />);
		expect(screen.getByText("Lexer shipped").closest("button")).toBeNull();
	});

	// A live refresh re-sorts the events and can add one before an expanded
	// row. The expansion belongs to the event, not to its position: keyed by
	// index, the new row opened and the expanded one closed.
	it("keeps an expanded row with its event when an earlier event arrives", async () => {
		const fetchDetail = vi.fn().mockResolvedValue("Two issues found: A and B.");
		const [data, setData] = createSignal(flow());
		render(() => <ProgressFlow flow={data()} fetchDetail={fetchDetail} />);
		fireEvent.click(screen.getByText("Two issues…"));
		expect(await screen.findByText("Two issues found: A and B.")).toBeTruthy();

		const next = flow();
		next.events.unshift({
			id: "entry:0",
			kind: "delegated",
			from: "lead",
			to: "w1",
			summary: "Earlier hand-off",
			text: "Earlier hand-off in full",
			atMs: 0,
		});
		setData(next);

		expect(screen.getByText("Two issues found: A and B.")).toBeTruthy();
		expect(screen.getByText("Earlier hand-off")).toBeTruthy();
		expect(screen.queryByText("Earlier hand-off in full")).toBeNull();
		expect(fetchDetail).toHaveBeenCalledTimes(1);
	});
});
