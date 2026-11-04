// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionsScreen } from "../screens/SessionsScreen";
import type { SessionInfo, SessionState } from "../useSessions";
import { recordSessionOpened } from "../utils/recentSessions";

beforeEach(() => localStorage.clear());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function session(name: string, state: Partial<SessionState>): SessionInfo {
	return {
		session_id: name,
		display_name: name,
		cwd: "/work/project",
		worktree_path: null,
		worktree_branch: null,
		state: { awaiting_input: false, rate_limited: false, last_activity_ms: 0, agent_type: "claude", ...state },
	};
}

function screen(sessions: () => SessionInfo[]) {
	return render(() => (
		<SessionsScreen
			sessions={sessions()}
			loading={false}
			refreshing={false}
			error={null}
			onRefresh={() => {}}
			onSelectSession={() => {}}
		/>
	));
}

const names = (view: ReturnType<typeof screen>) =>
	view.queryAllByRole("button", { name: /^Open session / }).map((button) => button.getAttribute("aria-label"));

// Catches: counters act as exclusive radios, shrink their own counts, or exclude delegated Working rows.
it("toggles states as a union and restores every state when the last selection clears", async () => {
	const view = screen(() => [
		session("Build", { agent_state: "working" }),
		session("Delegate", { active_sub_tasks: 1 }),
		session("Rest", { agent_state: "idle" }),
		session("Ask", { awaiting_input: true }),
		session("Done", { agent_state: "completed" }),
		session("Error", { last_error: "Failed" }),
		session("Limited", { rate_limited: true }),
	]);
	const working = view.getByRole("button", { name: /^2\s*Working$/ });
	const idle = view.getByRole("button", { name: /^1\s*Idle$/ });
	const awaiting = view.getByRole("button", { name: /^1\s*Awaiting$/ });
	expect(names(view)).toHaveLength(7);
	await fireEvent.click(working);
	expect(working.getAttribute("aria-pressed")).toBe("true");
	expect(names(view)).toEqual(["Open session Build", "Open session Delegate"]);
	await fireEvent.click(idle);
	expect(names(view)).toEqual(["Open session Build", "Open session Delegate", "Open session Rest"]);
	await fireEvent.click(awaiting);
	expect(names(view)).toHaveLength(4);
	expect(view.getAllByTestId("metric-number").map((node) => node.textContent)).toEqual(["2", "1", "1"]);
	await fireEvent.click(working);
	await fireEvent.click(idle);
	expect(names(view)).toEqual(["Open session Ask"]);
	await fireEvent.click(awaiting);
	expect(awaiting.getAttribute("aria-pressed")).toBe("false");
	expect(names(view)).toHaveLength(7);
});

// Catches: zero-count counters are disabled or disappear when their filter has no rows.
it("keeps all counters mounted when a zero-count state is selected", async () => {
	const view = screen(() => [session("Rest", { agent_state: "idle" })]);
	const awaiting = view.getByRole("button", { name: /^0\s*Awaiting$/ });
	await fireEvent.click(awaiting);
	expect(awaiting.getAttribute("aria-pressed")).toBe("true");
	expect(names(view)).toEqual([]);
	expect(view.getByText("No matching sessions")).toBeTruthy();
	expect(view.queryByText("No active sessions")).toBeNull();
	expect(view.getAllByTestId("metric-card")).toHaveLength(3);
	await fireEvent.click(awaiting);
	expect(names(view)).toEqual(["Open session Rest"]);
});

// Catches: searching bypasses selected states, closing search clears state filters, or sorting loses the filter.
it("intersects search with state filters while retaining Recent order", async () => {
	recordSessionOpened("API two");
	const view = screen(() => [
		session("API one", { agent_state: "working" }),
		session("API idle", { agent_state: "idle" }),
		session("API two", { agent_state: "working" }),
		session("Other", { agent_state: "working" }),
	]);
	await fireEvent.click(view.getByRole("button", { name: /^3\s*Working$/ }));
	await fireEvent.click(view.getByRole("button", { name: "Search sessions" }));
	await fireEvent.input(view.getByRole("searchbox"), { target: { value: "API" } });
	await fireEvent.click(view.getByRole("button", { name: "Sort sessions" }));
	await fireEvent.click(view.getByRole("menuitemradio", { name: "Recent" }));
	expect(names(view)).toEqual(["Open session API two", "Open session API one"]);
	await fireEvent.input(view.getByRole("searchbox"), { target: { value: "idle" } });
	expect(view.getByText("No matching sessions")).toBeTruthy();
	await fireEvent.click(view.getByRole("button", { name: "Close session search" }));
	expect(names(view)).toEqual(["Open session API two", "Open session API one", "Open session Other"]);
	expect(view.getAllByTestId("metric-number").map((node) => node.textContent)).toEqual(["3", "1", "0"]);
});

// Catches: filtering reads raw snapshots instead of the row's Working hold or retains stale rows after a state update.
it("updates filtered rows with the same debounced status as their badges", async () => {
	vi.useFakeTimers();
	const [sessions, setSessions] = createSignal([session("Build", { agent_state: "working" })]);
	const view = screen(sessions);
	await fireEvent.click(view.getByRole("button", { name: /^1\s*Working$/ }));
	setSessions([session("Build", { agent_state: "idle" })]);
	vi.advanceTimersByTime(1999);
	expect(names(view)).toEqual(["Open session Build"]);
	vi.advanceTimersByTime(1);
	expect(names(view)).toEqual([]);
	expect(view.getByRole("button", { name: /^0\s*Working$/ }).getAttribute("aria-pressed")).toBe("true");
	setSessions([session("New", { agent_state: "working" })]);
	expect(names(view)).toEqual(["Open session New"]);
});
