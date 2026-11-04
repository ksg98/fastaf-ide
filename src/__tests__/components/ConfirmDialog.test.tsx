import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../components/ConfirmDialog/ConfirmDialog";
import { useConfirmDialog } from "../../hooks/useConfirmDialog";

describe("ConfirmDialog", () => {
	const baseProps = {
		visible: true,
		title: "Confirm",
		message: "Proceed?",
	};

	// Catches: dirty/unmerged work is shown as safe or Delete can settle an unsafe dialog.
	it("renders failed dirty and unmerged checks and prevents Delete while Archive preserves work", async () => {
		const dialog = useConfirmDialog();
		const pending = dialog.confirmRemoveWorktree(
			"feat/work",
			{
				dirtyFiles: 3,
				commitStatus: "unmerged",
				removalSafety: "requires_force",
				archiveChecklist: {
					checks: [
						{ passed: false, label: "3 files changed and not committed" },
						{ passed: false, label: "2 commits not in main" },
						{ passed: true, label: "No terminal or agent open here" },
					],
					can_delete: false,
					archive_explanation: "keeps everything, branch and changes included.",
					delete_explanation: "you would lose 3 changes and 2 commits.",
				},
			},
			true,
		);
		render(() => (
			<ConfirmDialog
				visible={!!dialog.dialogState()}
				{...dialog.dialogState()!}
				onClose={dialog.handleClose}
				onConfirm={dialog.handleConfirm}
				onDiscard={dialog.handleDiscard}
			/>
		));
		expect(screen.getAllByRole("img", { name: "Fail" })).toHaveLength(2);
		expect(screen.getAllByRole("img", { name: "Pass" })).toHaveLength(1);
		expect(screen.getByText("2 commits not in main")).toBeTruthy();
		expect(screen.getByText(/you would lose 3 changes and 2 commits/)).toBeTruthy();
		expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		dialog.handleDiscard();
		expect(dialog.dialogState()?.title).toBe("Archive workspace?");
		fireEvent.click(screen.getByRole("button", { name: "Archive" }));
		expect(await pending).toBe("archive");
	});

	it("renders nothing when not visible", () => {
		const { baseElement } = render(() => (
			<ConfirmDialog {...baseProps} visible={false} onConfirm={() => {}} onClose={() => {}} />
		));
		expect(baseElement.querySelector("button")).toBeNull();
	});

	it("wires the confirm and cancel buttons", () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		render(() => (
			<ConfirmDialog {...baseProps} confirmLabel="Yes" cancelLabel="No" onConfirm={onConfirm} onClose={onClose} />
		));
		fireEvent.click(screen.getByText("Yes"));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByText("No"));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("Enter triggers confirm by default", () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		render(() => <ConfirmDialog {...baseProps} onConfirm={onConfirm} onClose={onClose} />);
		fireEvent.keyDown(document, { key: "Enter" });
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("Enter takes the safe path when defaultButton is 'cancel'", () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		render(() => <ConfirmDialog {...baseProps} defaultButton="cancel" onConfirm={onConfirm} onClose={onClose} />);
		fireEvent.keyDown(document, { key: "Enter" });
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("Escape always cancels", () => {
		const onClose = vi.fn();
		render(() => <ConfirmDialog {...baseProps} onConfirm={() => {}} onClose={onClose} />);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("renders the discard button and wires onDiscard when discardLabel is set", () => {
		const onDiscard = vi.fn();
		render(() => (
			<ConfirmDialog
				{...baseProps}
				confirmLabel="Save"
				cancelLabel="Cancel"
				discardLabel="Don't Save"
				onConfirm={() => {}}
				onClose={() => {}}
				onDiscard={onDiscard}
			/>
		));
		fireEvent.click(screen.getByText("Don't Save"));
		expect(onDiscard).toHaveBeenCalledTimes(1);
	});

	// Catches: the destructive third action inheriting neutral styling or becoming the Enter default.
	it("renders a danger Delete action while Enter still archives", () => {
		const onConfirm = vi.fn();
		const onDiscard = vi.fn();
		render(() => (
			<ConfirmDialog
				{...baseProps}
				confirmLabel="Archive"
				discardLabel="Delete"
				discardDanger
				onConfirm={onConfirm}
				onClose={() => {}}
				onDiscard={onDiscard}
			/>
		));
		expect(screen.getByRole("button", { name: "Delete" }).className).toContain("danger");
		fireEvent.keyDown(document, { key: "Enter" });
		expect(onConfirm).toHaveBeenCalledOnce();
		expect(onDiscard).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(onDiscard).toHaveBeenCalledOnce();
	});

	it("omits the discard button when discardLabel is not set", () => {
		render(() => <ConfirmDialog {...baseProps} confirmLabel="Save" onConfirm={() => {}} onClose={() => {}} />);
		expect(screen.queryByText("Don't Save")).toBeNull();
	});

	it("shows a removal countdown and confirms only when it expires", () => {
		vi.useFakeTimers();
		try {
			const onConfirm = vi.fn();
			const onClose = vi.fn();
			render(() => (
				<ConfirmDialog
					{...baseProps}
					confirmLabel="Remove"
					autoConfirmMs={10_000}
					onConfirm={onConfirm}
					onClose={onClose}
				/>
			));
			expect(screen.getByText("Remove (10)")).toBeTruthy();
			vi.advanceTimersByTime(9_000);
			expect(screen.getByText("Remove (1)")).toBeTruthy();
			expect(onConfirm).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1_000);
			expect(onConfirm).toHaveBeenCalledTimes(1);
			expect(onClose).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("Keep cancels a pending auto-confirm", () => {
		vi.useFakeTimers();
		try {
			const onConfirm = vi.fn();
			const onClose = vi.fn();
			render(() => (
				<ConfirmDialog
					{...baseProps}
					autoConfirmMs={10_000}
					cancelLabel="Keep"
					onConfirm={onConfirm}
					onClose={onClose}
				/>
			));
			expect(screen.getByText("OK (10)")).toBeTruthy();
			fireEvent.click(screen.getByText("Keep"));
			vi.advanceTimersByTime(10_000);
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(onConfirm).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
