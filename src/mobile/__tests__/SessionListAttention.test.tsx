// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionBanner } from "../components/QuestionBanner";
import { StatusBadge } from "../components/StatusBadge";
import { SessionsScreen } from "../screens/SessionsScreen";
import type { SessionInfo } from "../useSessions";

afterEach(cleanup);

const waiting = {
	session_id: "review",
	display_name: "Wiz-Pr",
	cwd: "/work/tuicommander",
	worktree_path: null,
	worktree_branch: null,
	state: { awaiting_input: true, agent_type: "claude", question_text: "Approve?" },
} as SessionInfo;

describe("mobile session attention", () => {
	it("keeps the exact casing of session names across list, detail, and banner", () => {
		for (const relativePath of [
			"../components/SessionCard.module.css",
			"../screens/SessionDetailScreen.module.css",
			"../components/QuestionBanner.module.css",
		]) {
			const css = readFileSync(resolve(__dirname, relativePath), "utf-8");
			expect(css, relativePath).not.toMatch(/text-transform:\s*capitalize/);
		}
	});
	it("names the waiting session and repository in its question banner", () => {
		const view = render(() => <QuestionBanner sessions={[waiting]} onNavigate={() => {}} />);
		const banner = view.getByRole("button", { name: /Wiz-Pr/ });
		expect(banner.textContent).toContain("tuicommander");
		expect(banner.textContent).toContain("Approve?");
	});

	// Catches: selecting Awaiting navigates away instead of keeping all waiting rows visible.
	it.each([1, 3])("filters to all %i waiting sessions without opening one", async (count) => {
		const onNavigate = vi.fn();
		const view = render(() => (
			<SessionsScreen
				sessions={[
					{ ...waiting, session_id: "idle", state: { ...waiting.state!, awaiting_input: false } },
					...Array.from({ length: count }, (_, index) => ({
						...waiting,
						session_id: index === 0 ? "review" : `review-${index}`,
					})),
				]}
				loading={false}
				refreshing={false}
				error={null}
				onRefresh={() => {}}
				onSelectSession={onNavigate}
			/>
		));
		await fireEvent.click(view.getByRole("button", { name: new RegExp(`^${count}\\s*Awaiting$`) }));
		expect(onNavigate).not.toHaveBeenCalled();
		expect(view.getAllByRole("button", { name: "Open session Wiz-Pr" })).toHaveLength(count);
		expect(view.getByRole("button", { name: new RegExp(`^${count}\\s*Awaiting$`) }).getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	it("calls the active state Working", () => {
		const view = render(() => <StatusBadge status="busy" />);
		expect(view.getByText("Working")).toBeTruthy();
	});
});
