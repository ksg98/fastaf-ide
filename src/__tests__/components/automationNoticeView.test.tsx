import { render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { AutomationsDialog } from "../../components/AutomationsDialog/AutomationsDialog";
import { invoke } from "../../invoke";
import { automationsUi } from "../../stores/automations";
import { fakeAdapter, runFixture } from "../automationsFixtures";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));

// Catches retained runs disappearing when their deleted definition has no editor draft.
it("shows deleted definition run output without exposing Save", async () => {
	const run = runFixture("retained-run", "deleted");
	run.stdout.text = "Retained result";
	vi.mocked(invoke).mockResolvedValue(run);
	automationsUi.openRun(run.id);
	try {
		render(() => <AutomationsDialog adapter={fakeAdapter({ list: async () => [] })} onClose={() => {}} />);
		expect(await screen.findByText("Retained result")).toBeTruthy();
		expect(screen.getByText("retained-run")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	} finally {
		automationsUi.open();
		automationsUi.close();
	}
});

// Catches: the retained run view cannot render the review trigger or its pinned output.
it("shows a retained PR review run without a live agent session", async () => {
	const run = runFixture("pr-review-run", "review");
	run.trigger = { kind: "pull_request_review", repository: "cli/cli", pr_number: 14846, head_sha: "a".repeat(40) };
	run.stdout.text = "Pinned PR review result";
	vi.mocked(invoke).mockResolvedValue(run);
	automationsUi.openRun(run.id);
	try {
		render(() => <AutomationsDialog adapter={fakeAdapter({ list: async () => [] })} onClose={() => {}} />);
		expect(await screen.findByText("Pinned PR review result")).toBeTruthy();
		expect(screen.getByText("Pull request review")).toBeTruthy();
		expect(screen.queryByText("pull_request_review")).toBeNull();
	} finally {
		automationsUi.open();
		automationsUi.close();
	}
});
