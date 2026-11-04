import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { provider } from "./detail/__tests__/detailFixture";
import { TasksBoardView } from "./TasksBoardView";

afterEach(cleanup);
// Catches: discovered Projects never reach the picker, or a selection keeps loading the first board.
it("discovers_boards_and_loads_the_selected_project", async () => {
	const boards = [
		{ id: "P1", name: "Sprint", fieldId: "state", columns: [] },
		{ id: "P2", name: "Backlog", fieldId: "state", columns: [] },
	];
	const board = vi.fn(async (id: string) => ({ board: boards.find((b) => b.id === id)!, lanes: [], nextCursor: null }));
	const source = { ...provider(), boards: [], listBoards: async () => boards, board };
	render(() => <TasksBoardView provider={source} onOpen={() => {}} />);
	const picker = await screen.findByRole("combobox");
	expect(picker).toHaveTextContent("SprintBacklog");
	await waitFor(() => expect(board).toHaveBeenCalledWith("P1", expect.anything(), expect.anything()));
	fireEvent.change(picker, { target: { value: "P2" } });
	await waitFor(() => expect(board).toHaveBeenCalledWith("P2", expect.anything(), expect.anything()));
});
// Catches: a scope error is hidden behind misleading no-boards empty state.
it("shows_missing_project_scope_without_claiming_no_boards", async () => {
	const source = {
		...provider(),
		boards: [],
		listBoards: async () => {
			throw new Error("GitHub Projects requires read:project");
		},
	};
	render(() => <TasksBoardView provider={source} onOpen={() => {}} />);
	expect(await screen.findByRole("alert")).toHaveTextContent("read:project");
	expect(screen.queryByText("This provider has no boards.")).not.toBeInTheDocument();
});
