// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionsScreen } from "../screens/SessionsScreen";
import type { SessionInfo } from "../useSessions";
import { readRecentSessionIds, recordSessionOpened } from "../utils/recentSessions";

const session = (id: string, name: string): SessionInfo => ({
	session_id: id,
	cwd: `/work/${id}`,
	worktree_path: `/work/${id}`,
	worktree_branch: "main",
	display_name: name,
	state: { awaiting_input: false, rate_limited: false, last_activity_ms: 0, agent_type: "claude" },
});

const sessions = [session("api", "Build API"), session("login", "Fix login"), session("deploy", "Deploy")];

function renderScreen() {
	return render(() => (
		<SessionsScreen
			sessions={sessions}
			loading={false}
			refreshing={false}
			error={null}
			onRefresh={() => {}}
			onSelectSession={() => {}}
		/>
	));
}

const titles = (view: ReturnType<typeof renderScreen>) =>
	["Build API", "Fix login", "Deploy"]
		.map((name) => ({ name, node: view.getByText(name) }))
		.sort((a, b) => (a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
		.map((entry) => entry.name);

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("mobile session sort", () => {
	// catches: Recent sort ignores sessions opened on this device
	it("recent_sort_orders_by_last_opened", async () => {
		recordSessionOpened("deploy");
		recordSessionOpened("login");
		const view = renderScreen();
		expect(titles(view)).toEqual(["Build API", "Fix login", "Deploy"]);

		await fireEvent.click(view.getByRole("button", { name: "Sort sessions" }));
		await fireEvent.click(view.getByRole("menuitemradio", { name: "Recent" }));

		expect(titles(view)).toEqual(["Fix login", "Deploy", "Build API"]);
	});

	// catches: the sort choice resets to Default every time the Sessions tab is reopened
	it("keeps the chosen sort after the screen is remounted", async () => {
		recordSessionOpened("deploy");
		const first = renderScreen();
		await fireEvent.click(first.getByRole("button", { name: "Sort sessions" }));
		await fireEvent.click(first.getByRole("menuitemradio", { name: "Recent" }));
		cleanup();

		const second = renderScreen();
		expect(titles(second)[0]).toBe("Deploy");
	});

	// catches: the tracked list growing without bound or listing one session twice
	it("tracks at most ten distinct sessions, most recent first", () => {
		for (let i = 0; i < 12; i++) recordSessionOpened(`s${i}`);
		recordSessionOpened("s5");
		const ids = readRecentSessionIds();
		expect(ids).toHaveLength(10);
		expect(ids[0]).toBe("s5");
		expect(new Set(ids).size).toBe(10);
		expect(ids).not.toContain("s0");
	});

	// catches: a corrupt stored value crashing the Sessions screen
	it("ignores a corrupt stored list", () => {
		localStorage.setItem("tuic-mobile-recent-sessions", "{not json");
		expect(readRecentSessionIds()).toEqual([]);
	});
});
