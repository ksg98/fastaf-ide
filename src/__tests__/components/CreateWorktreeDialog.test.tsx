import { fireEvent, render, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { CreateWorktreeDialog } from "../../components/CreateWorktreeDialog/CreateWorktreeDialog";

const defaultProps = {
	visible: true,
	suggestedName: "bold-nexus-042",
	existingBranches: ["main", "develop", "feature/auth", "fix/login-bug"],
	worktreeBranches: ["main"],
	worktreesDir: "/repos/myproject/.worktrees",
	onClose: () => {},
	onCreate: () => {},
	onGenerateName: vi.fn().mockResolvedValue("cool-ripley-007"),
};

describe("CreateWorktreeDialog", () => {
	it("renders nothing when not visible", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} visible={false} />);
		expect(container.querySelector(".popover")).toBeNull();
	});

	it("renders dialog with input and branch list when visible", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		expect(container.querySelector(".popover")).not.toBeNull();
		expect(container.querySelector("h4")!.textContent).toBe("New Worktree");

		const input = container.querySelector("input[type='text']") as HTMLInputElement;
		expect(input).not.toBeNull();
	});

	it("starts with empty input and shows all non-worktree branches", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		const input = container.querySelector("input[type='text']") as HTMLInputElement;
		expect(input.value).toBe("");

		// Branch list should show all branches
		const items = container.querySelectorAll("[class*='branchItem']");
		expect(items.length).toBe(4); // main, develop, feature/auth, fix/login-bug
	});

	it("shows worktree branches as disabled with suffix", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		// "main" has a worktree — should have disabled styling and "(has worktree)" text
		const items = container.querySelectorAll("[class*='branchItem']");
		const mainItem = Array.from(items).find((el) => el.textContent?.includes("main"));
		expect(mainItem).toBeDefined();
		expect(mainItem!.textContent).toContain("has worktree");
		expect(mainItem!.classList.toString()).toContain("disabled");
	});

	it("filters branch list as user types", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		const input = container.querySelector("input[type='text']") as HTMLInputElement;

		fireEvent.input(input, { target: { value: "feat" } });

		const items = container.querySelectorAll("[class*='branchItem']");
		// Only "feature/auth" should match
		expect(items.length).toBe(1);
		expect(items[0].textContent).toContain("feature/auth");
	});

	it("shows 'existing branch' status when input matches an existing branch", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		const input = container.querySelector("input[type='text']") as HTMLInputElement;

		fireEvent.input(input, { target: { value: "develop" } });

		const status = container.querySelector("[class*='statusLine']");
		expect(status).not.toBeNull();
		expect(status!.textContent).toContain("existing branch");
	});

	it("shows 'new branch' status when input doesn't match any branch", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		const input = container.querySelector("input[type='text']") as HTMLInputElement;

		fireEvent.input(input, { target: { value: "feature/new-thing" } });

		const status = container.querySelector("[class*='statusLine']");
		expect(status).not.toBeNull();
		expect(status!.textContent).toContain("new branch");
	});

	it("shows path preview with sanitized branch name", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		const input = container.querySelector("input[type='text']") as HTMLInputElement;

		fireEvent.input(input, { target: { value: "feature/auth" } });

		const path = container.querySelector("[class*='pathPreview']");
		expect(path).not.toBeNull();
		// Slashes in branch names should be replaced in the directory name
		expect(path!.textContent).toContain("/repos/myproject/.worktrees/");
		expect(path!.textContent).toContain("feature");
	});

	it("clicking a non-disabled branch populates input", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		const items = container.querySelectorAll("[class*='branchItem']");
		const developItem = Array.from(items).find(
			(el) => el.textContent?.includes("develop") && !el.textContent?.includes("has worktree"),
		);
		expect(developItem).toBeDefined();

		fireEvent.click(developItem!);

		const input = container.querySelector("input[type='text']") as HTMLInputElement;
		expect(input.value).toBe("develop");
	});

	it("clicking a disabled (worktree) branch does NOT populate input", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		const items = container.querySelectorAll("[class*='branchItem']");
		const mainItem = Array.from(items).find((el) => el.textContent?.includes("has worktree"));
		expect(mainItem).toBeDefined();

		fireEvent.click(mainItem!);

		const input = container.querySelector("input[type='text']") as HTMLInputElement;
		expect(input.value).toBe(""); // should remain empty
	});

	it("calls onCreate with createBranch=false for existing branch", () => {
		const handleCreate = vi.fn();
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} onCreate={handleCreate} />);
		const input = container.querySelector("input[type='text']") as HTMLInputElement;

		fireEvent.input(input, { target: { value: "develop" } });

		const createBtn = within(container).getByRole("button", { name: "Create" });
		fireEvent.click(createBtn);

		expect(handleCreate).toHaveBeenCalledWith({
			branchName: "develop",
			createBranch: false,
			baseRef: "",
		});
	});

	it("calls onCreate with createBranch=true for new branch", () => {
		const handleCreate = vi.fn();
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} onCreate={handleCreate} />);
		const input = container.querySelector("input[type='text']") as HTMLInputElement;

		fireEvent.input(input, { target: { value: "feature/new-thing" } });

		const createBtn = within(container).getByRole("button", { name: "Create" });
		fireEvent.click(createBtn);

		expect(handleCreate).toHaveBeenCalledWith({
			branchName: "feature/new-thing",
			createBranch: true,
			baseRef: "",
		});
	});

	it("disables Create button when input is empty", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		const createBtn = within(container).getByRole("button", { name: "Create" }) as HTMLButtonElement;
		expect(createBtn.disabled).toBe(true);
	});

	it("shows validation error for invalid branch name on create", () => {
		const handleCreate = vi.fn();
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} onCreate={handleCreate} />);
		const input = container.querySelector("input[type='text']") as HTMLInputElement;

		fireEvent.input(input, { target: { value: "bad name" } });

		const createBtn = within(container).getByRole("button", { name: "Create" });
		fireEvent.click(createBtn);

		// Should show error, not call onCreate
		const error = container.querySelector(".error");
		expect(error).not.toBeNull();
		expect(handleCreate).not.toHaveBeenCalled();
	});

	it("shows error when trying to create worktree for branch that already has one", () => {
		const handleCreate = vi.fn();
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} onCreate={handleCreate} />);
		const input = container.querySelector("input[type='text']") as HTMLInputElement;

		// "main" already has a worktree
		fireEvent.input(input, { target: { value: "main" } });

		const createBtn = within(container).getByRole("button", { name: "Create" });
		fireEvent.click(createBtn);

		const error = container.querySelector(".error");
		expect(error).not.toBeNull();
		expect(error!.textContent).toContain("already has a worktree");
		expect(handleCreate).not.toHaveBeenCalled();
	});

	it("calls onClose when cancel button is clicked", () => {
		const handleClose = vi.fn();
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} onClose={handleClose} />);
		const cancelBtn = within(container).getByRole("button", { name: "Cancel" });
		fireEvent.click(cancelBtn);
		expect(handleClose).toHaveBeenCalledOnce();
	});

	it("no status or path preview shown when input is empty", () => {
		const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
		const status = container.querySelector("[class*='statusLine']");
		const path = container.querySelector("[class*='pathPreview']");
		expect(status).toBeNull();
		expect(path).toBeNull();
	});

	describe("random name button", () => {
		it("renders a generate-name button", () => {
			const { container } = render(() => <CreateWorktreeDialog {...defaultProps} />);
			const btn = container.querySelector("[class*='generateBtn']");
			expect(btn).not.toBeNull();
		});

		it("calls onGenerateName and populates input on click", async () => {
			const onGenerateName = vi.fn().mockResolvedValue("cool-ripley-007");
			const { container } = render(() => <CreateWorktreeDialog {...defaultProps} onGenerateName={onGenerateName} />);
			const btn = container.querySelector("[class*='generateBtn']")!;
			fireEvent.click(btn);

			expect(onGenerateName).toHaveBeenCalledOnce();

			await vi.waitFor(() => {
				const input = container.querySelector("input[type='text']") as HTMLInputElement;
				expect(input.value).toBe("cool-ripley-007");
			});
		});

		it("clears error when generating a name", async () => {
			const onGenerateName = vi.fn().mockResolvedValue("fresh-name-001");
			const { container } = render(() => <CreateWorktreeDialog {...defaultProps} onGenerateName={onGenerateName} />);

			// Trigger an error first
			const input = container.querySelector("input[type='text']") as HTMLInputElement;
			fireEvent.input(input, { target: { value: "bad name" } });
			const createBtn = within(container).getByRole("button", { name: "Create" });
			fireEvent.click(createBtn);
			expect(container.querySelector(".error")).not.toBeNull();

			// Click generate
			const btn = container.querySelector("[class*='generateBtn']")!;
			fireEvent.click(btn);

			await vi.waitFor(() => {
				expect(container.querySelector(".error")).toBeNull();
			});
		});
	});

	describe("Start from", () => {
		const baseRefs = [
			{ name: "main", kind: "local", is_default: true },
			{ name: "develop", kind: "local", is_default: false },
			{ name: "feature/auth", kind: "local", is_default: false },
			{ name: "origin/release", kind: "remote", is_default: false },
			{ name: "origin/staging", kind: "remote", is_default: false },
		];
		const list = () => document.querySelector<HTMLElement>("[data-testid='base-ref-list']");
		const rows = () => Array.from(list()?.querySelectorAll("[role='option']") ?? []).map((el) => el.textContent);
		const search = () => list()!.querySelector("input") as HTMLInputElement;
		const trigger = (container: HTMLElement) => container.querySelector("[aria-haspopup='listbox']") as HTMLElement;

		it("lists every branch, local first, and marks the default", () => {
			const { container } = render(() => <CreateWorktreeDialog {...defaultProps} baseRefs={baseRefs} />);
			expect(trigger(container).textContent).toBe("main (default)");
			expect(list()).toBeNull();

			fireEvent.click(trigger(container));

			expect(rows()).toEqual(["main (default)", "develop", "feature/auth", "origin/release", "origin/staging"]);
		});

		// Issue #11: with many local branches a remote one sat at the very end of
		// a short list and could only be reached by scrolling.
		it("finds a remote branch by typing part of its name", () => {
			const handleCreate = vi.fn();
			const { container } = render(() => (
				<CreateWorktreeDialog {...defaultProps} baseRefs={baseRefs} onCreate={handleCreate} />
			));
			fireEvent.click(trigger(container));

			fireEvent.input(search(), { target: { value: "STAG" } });
			expect(rows()).toEqual(["origin/staging"]);

			fireEvent.click(list()!.querySelector("[role='option']")!);
			expect(list()).toBeNull();
			expect(trigger(container).textContent).toBe("origin/staging");

			fireEvent.input(container.querySelector("input[type='text']")!, { target: { value: "feature/new" } });
			fireEvent.click(within(container).getByRole("button", { name: "Create" }));
			expect(handleCreate).toHaveBeenCalledWith({
				branchName: "feature/new",
				createBranch: true,
				baseRef: "origin/staging",
			});
		});

		it("says so when nothing matches", () => {
			const { container } = render(() => <CreateWorktreeDialog {...defaultProps} baseRefs={baseRefs} />);
			fireEvent.click(trigger(container));
			fireEvent.input(search(), { target: { value: "nope" } });
			expect(rows()).toEqual([]);
			expect(list()!.textContent).toContain("No matching branches");
		});

		// Enter in the dialog creates the worktree. In the search field it must
		// only pick the branch, or choosing a base would create a worktree.
		it("picks with the arrow keys and Enter without creating the worktree", () => {
			const handleCreate = vi.fn();
			const { container } = render(() => (
				<CreateWorktreeDialog {...defaultProps} baseRefs={baseRefs} onCreate={handleCreate} />
			));
			fireEvent.input(container.querySelector("input[type='text']")!, { target: { value: "feature/new" } });
			fireEvent.click(trigger(container));

			fireEvent.keyDown(search(), { key: "ArrowDown" });
			fireEvent.keyDown(search(), { key: "ArrowDown" });
			fireEvent.keyDown(search(), { key: "ArrowUp" });
			fireEvent.keyDown(search(), { key: "Enter" });

			expect(handleCreate).not.toHaveBeenCalled();
			expect(list()).toBeNull();
			expect(trigger(container).textContent).toBe("develop");
		});

		it("closes the list on Escape and leaves the dialog open", () => {
			const handleClose = vi.fn();
			const { container } = render(() => (
				<CreateWorktreeDialog {...defaultProps} baseRefs={baseRefs} onClose={handleClose} />
			));
			fireEvent.click(trigger(container));
			expect(list()).not.toBeNull();

			fireEvent.keyDown(document, { key: "Escape" });
			expect(list()).toBeNull();
			expect(handleClose).not.toHaveBeenCalled();

			fireEvent.keyDown(document, { key: "Escape" });
			expect(handleClose).toHaveBeenCalledOnce();
		});

		it("starts from the project's default base when one is given", () => {
			const handleCreate = vi.fn();
			const { container } = render(() => (
				<CreateWorktreeDialog
					{...defaultProps}
					baseRefs={baseRefs}
					defaultBaseRef="origin/staging"
					onCreate={handleCreate}
				/>
			));
			expect(trigger(container).textContent).toBe("origin/staging (default)");

			fireEvent.click(trigger(container));
			expect(rows()).toContain("origin/staging (default)");
			expect(rows()).toContain("main");
			fireEvent.keyDown(document, { key: "Escape" });

			fireEvent.input(container.querySelector("input[type='text']")!, { target: { value: "feature/new" } });
			fireEvent.click(within(container).getByRole("button", { name: "Create" }));
			expect(handleCreate).toHaveBeenCalledWith({
				branchName: "feature/new",
				createBranch: true,
				baseRef: "origin/staging",
			});
		});

		it("offers to make another base the project's default, and keeps the typed name when it is", () => {
			// Wired the way the app wires it: one state object, from which the
			// caller computes `visible` as well. Changing the default replaces
			// that object, which must not count as the dialog opening again.
			const [state, setState] = createSignal<{ defaultBaseRef: string } | null>({ defaultBaseRef: "main" });
			const { container } = render(() => (
				<CreateWorktreeDialog
					{...defaultProps}
					visible={state() !== null}
					baseRefs={baseRefs}
					defaultBaseRef={state()?.defaultBaseRef}
					onSetDefaultBaseRef={(defaultBaseRef) => setState({ defaultBaseRef })}
				/>
			));
			const makeDefault = () => container.querySelector("[data-testid='base-ref-make-default']");
			// The chosen base is already the default: nothing to offer.
			expect(makeDefault()).toBeNull();

			const name = container.querySelector("input[type='text']") as HTMLInputElement;
			fireEvent.input(name, { target: { value: "feature/new" } });
			fireEvent.click(trigger(container));
			fireEvent.input(search(), { target: { value: "staging" } });
			fireEvent.keyDown(search(), { key: "Enter" });

			expect(makeDefault()!.textContent).toBe("Always start from origin/staging in this project");
			fireEvent.click(makeDefault()!);

			expect(state()?.defaultBaseRef).toBe("origin/staging");
			expect(makeDefault()).toBeNull();
			expect(trigger(container).textContent).toBe("origin/staging (default)");
			expect(name.value).toBe("feature/new");
		});

		it("offers no default action without a handler", () => {
			const { container } = render(() => <CreateWorktreeDialog {...defaultProps} baseRefs={baseRefs} />);
			fireEvent.click(trigger(container));
			fireEvent.click(Array.from(list()!.querySelectorAll("[role='option']")).at(-1)!);
			expect(trigger(container).textContent).toBe("origin/staging");
			expect(container.querySelector("[data-testid='base-ref-make-default']")).toBeNull();
		});
	});
});
