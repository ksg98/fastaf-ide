import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../invoke", () => ({ invoke: h.invoke }));

import { ChangesTab } from "../../components/GitPanel/ChangesTab";

// Adapted to FastAF's composer: the field is named "Commit message", the
// Commit pill stays focusable and reports a blocked commit through
// aria-disabled, and the file filter is the shared SearchField.
const commitPill = () => screen.getByRole("button", { name: /^Commit/ });

const status = {
	staged: [{ path: "staged.ts", status: "M", additions: 1, deletions: 0 }],
	unstaged: [{ path: "edited.ts", status: "M", additions: 1, deletions: 0 }],
	untracked: [],
};

it("catches shared commit editor losing generated drafts, keyboard commit or pending disable", async () => {
	let finish!: (value: string) => void;
	h.invoke.mockImplementation((command: string) =>
		command === "get_working_tree_status"
			? Promise.resolve(status)
			: command === "git_commit"
				? new Promise((resolve) => {
						finish = resolve;
					})
				: Promise.resolve([]),
	);
	render(() => <ChangesTab repoPath="/changes-editor" onOpenDiff={vi.fn()} />);
	await screen.findByText("staged.ts");
	const editor = screen.getByLabelText("Commit message");
	expect(commitPill()).toHaveAttribute("aria-disabled", "true");
	window.dispatchEvent(new CustomEvent("smart-prompt:commit-message", { detail: "  Generated\nmultiline draft  " }));
	expect(editor).toHaveValue("Generated\nmultiline draft");
	fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
	expect(h.invoke).toHaveBeenCalledWith("git_commit", {
		path: "/changes-editor",
		message: "Generated\nmultiline draft",
		amend: null,
	});
	expect(editor).toBeDisabled();
	// A commit in flight: the pill is busy and a second press does nothing.
	expect(commitPill()).toHaveAttribute("aria-busy", "true");
	fireEvent.click(commitPill());
	expect(h.invoke.mock.calls.filter(([command]) => command === "git_commit")).toHaveLength(1);
	finish("hash");
	await waitFor(() => expect(editor).toHaveValue(""));
	expect(editor).toBeEnabled();
});

it("catches shared filter clear or stage actions clearing selection through row bubbling", async () => {
	h.invoke.mockReset();
	h.invoke.mockImplementation(async (command: string) => (command === "get_working_tree_status" ? status : []));
	const onOpenDiff = vi.fn();
	render(() => <ChangesTab repoPath="/changes-filter" onOpenDiff={onOpenDiff} />);
	await screen.findByText("edited.ts");
	const filter = screen.getByPlaceholderText("Filter files");
	fireEvent.input(filter, { target: { value: "staged" } });
	expect(screen.queryByText("edited.ts")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
	expect(filter).toHaveValue("");
	expect(screen.getByText("edited.ts")).toBeInTheDocument();
	fireEvent.click(screen.getByTitle("Stage"));
	await waitFor(() =>
		expect(h.invoke).toHaveBeenCalledWith("git_stage_files", { path: "/changes-filter", files: ["edited.ts"] }),
	);
	expect(onOpenDiff).not.toHaveBeenCalled();
});
