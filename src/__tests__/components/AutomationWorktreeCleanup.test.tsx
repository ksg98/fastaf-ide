import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, expect, it, vi } from "vitest";
import { WorktreeCleanup } from "../../components/AutomationsDialog/WorktreeCleanup";
import { invoke } from "../../invoke";
import { rpc } from "../../transport";
import { runFixture } from "../automationsFixtures";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));
vi.mock("../../transport", () => ({ rpc: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const run = { ...runFixture("run-1", "deleted"), workspace_id: "automation/run-1", workspace: "/repo/worktree" };

// Catches: deleting immediately, ignoring backend safety, or targeting a different daemon.
it.each([undefined, "remote-owner"])(
	"requires a safe backend preview then explicit removal on %s",
	async (connectionId) => {
		const call = connectionId ? vi.mocked(rpc) : vi.mocked(invoke);
		call
			.mockResolvedValueOnce({ workspace: "/repo/worktree", can_remove: true, reason: null })
			.mockResolvedValueOnce({ removed: true });
		render(() => <WorktreeCleanup run={run} connectionId={connectionId} />);
		expect(screen.queryByRole("button", { name: "Remove safe worktree and branch" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Inspect worktree cleanup" }));
		fireEvent.click(await screen.findByRole("button", { name: "Remove safe worktree and branch" }));
		await screen.findByText("Worktree removed. Saved run history is retained.");
		const args = ["automation_action", { input: { action: "cleanup_worktree", id: "run-1" } }];
		if (connectionId) args.push(connectionId);
		expect(call).toHaveBeenLastCalledWith(...args);
		expect(connectionId ? invoke : rpc).not.toHaveBeenCalled();
	},
);

// Catches: offering a destructive action for refused safety or hiding an error on reinspection.
it("keeps unsafe worktrees and displays cleanup failures", async () => {
	vi.mocked(invoke)
		.mockResolvedValueOnce({ workspace: "/repo/worktree", can_remove: false, reason: "Live session" })
		.mockRejectedValueOnce(new Error("Workspace identity changed"));
	render(() => <WorktreeCleanup run={run} />);
	fireEvent.click(screen.getByRole("button", { name: "Inspect worktree cleanup" }));
	await screen.findByText("Live session");
	expect(screen.getByRole("button", { name: "Remove safe worktree and branch" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "Inspect worktree cleanup" }));
	await screen.findByText("Workspace identity changed");
	expect(screen.queryByRole("button", { name: "Remove safe worktree and branch" })).toBeNull();
});
