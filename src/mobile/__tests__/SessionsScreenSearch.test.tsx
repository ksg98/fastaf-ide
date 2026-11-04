// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { SessionsScreen } from "../screens/SessionsScreen";
import type { SessionInfo } from "../useSessions";

afterEach(cleanup);

const sessions: SessionInfo[] = [
	{
		session_id: "api",
		cwd: "/work/acme/api",
		worktree_path: "/work/acme/api",
		worktree_branch: "main",
		display_name: "Build API",
		state: { awaiting_input: false, rate_limited: false, last_activity_ms: 0, agent_type: "codex" },
	},
	{
		session_id: "login",
		cwd: "/work/nebula/app",
		worktree_path: "/work/nebula/app",
		worktree_branch: "feature/login",
		display_name: "Fix login",
		state: { awaiting_input: false, rate_limited: false, last_activity_ms: 0, agent_type: "claude" },
	},
	{
		session_id: "deploy",
		cwd: "/work/acme/admin",
		worktree_path: "/work/acme/admin",
		worktree_branch: "release",
		display_name: "Deploy",
		state: { awaiting_input: false, rate_limited: false, last_activity_ms: 0, agent_type: "goose" },
	},
];

describe("mobile session search", () => {
	it("matches a worktree path and includes sessions added while the query remains open", async () => {
		const [live, setLive] = createSignal<SessionInfo[]>([sessions[1]]);
		const view = render(() => (
			<SessionsScreen
				sessions={live()}
				loading={false}
				refreshing={false}
				error={null}
				onRefresh={() => {}}
				onSelectSession={() => {}}
			/>
		));
		await fireEvent.click(view.getByRole("button", { name: "Search sessions" }));
		await fireEvent.input(view.getByRole("searchbox"), { target: { value: "nova" } });
		expect(view.getByText("No matching sessions")).toBeTruthy();
		setLive([sessions[1], { ...sessions[0], cwd: "/work/acme/api", worktree_path: "/work/checkout/nova-feature" }]);
		expect(view.getByText("Build API")).toBeTruthy();
		expect(view.queryByText("Fix login")).toBeNull();
	});

	it("filters all sessions by repository, name, branch, and agent without changing their order", async () => {
		const view = render(() => (
			<SessionsScreen
				sessions={sessions}
				loading={false}
				refreshing={false}
				error={null}
				onRefresh={() => {}}
				onSelectSession={() => {}}
			/>
		));
		await fireEvent.click(view.getByRole("button", { name: "Search sessions" }));
		const field = view.getByRole("searchbox", { name: "Filter sessions" });

		await fireEvent.input(field, { target: { value: "NEBULA" } });
		expect(view.getByText("Fix login")).toBeTruthy();
		expect(view.queryByText("Build API")).toBeNull();
		expect(view.queryByText("Deploy")).toBeNull();

		await fireEvent.input(field, { target: { value: "build" } });
		expect(view.getByText("Build API")).toBeTruthy();
		expect(view.queryByText("Fix login")).toBeNull();

		await fireEvent.input(field, { target: { value: "release" } });
		expect(view.getByText("Deploy")).toBeTruthy();
		expect(view.queryByText("Build API")).toBeNull();

		await fireEvent.input(field, { target: { value: "CLAUDE" } });
		expect(view.getByText("Fix login")).toBeTruthy();
		expect(view.queryByText("Deploy")).toBeNull();

		await fireEvent.input(field, { target: { value: "no such session" } });
		expect(view.getByText("No matching sessions")).toBeTruthy();
		expect(view.queryByText("No active sessions")).toBeNull();

		await fireEvent.click(view.getByRole("button", { name: "Close session search" }));
		expect(view.queryByRole("searchbox")).toBeNull();
		const first = view.getByText("Build API");
		const second = view.getByText("Fix login");
		const third = view.getByText("Deploy");
		expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(sessions.map((session) => session.session_id)).toEqual(["api", "login", "deploy"]);

		await fireEvent.click(view.getByRole("button", { name: "Search sessions" }));
		expect(view.getByRole("searchbox", { name: "Filter sessions" })).toHaveProperty("value", "");
	});
});
