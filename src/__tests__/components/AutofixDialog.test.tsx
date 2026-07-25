import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../mocks/tauri";
import "../mocks/tauri";

import { AutofixDialog } from "../../components/AutofixDialog/AutofixDialog";

const ISSUE_DETAIL = {
	number: 42,
	title: "Crash on startup",
	body: "It crashes",
	author: "octocat",
	url: "https://github.com/o/r/issues/42",
	comments: [],
	autofix_prompt: "Fix issue #42: Crash on startup. Investigate and patch.",
};

describe("AutofixDialog", () => {
	const baseProps = () => ({
		repoPath: "/repo",
		issueNumber: 42,
		onConfirm: vi.fn(),
		onClose: vi.fn(),
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue(ISSUE_DETAIL);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("shows loading, then prefills the textarea with autofix_prompt", async () => {
		let resolveInvoke!: (value: unknown) => void;
		mockInvoke.mockReturnValueOnce(new Promise((res) => (resolveInvoke = res)));

		const { container } = render(() => <AutofixDialog {...baseProps()} />);
		// Loading spinner visible before the promise resolves
		expect(container.querySelector(".spinner")).not.toBeNull();
		expect(container.querySelector("textarea")).toBeNull();

		resolveInvoke(ISSUE_DETAIL);

		await waitFor(() => {
			expect(container.querySelector("textarea")).not.toBeNull();
		});
		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(textarea.value).toBe(ISSUE_DETAIL.autofix_prompt);
		expect(container.querySelector(".spinner")).toBeNull();
		// get_issue_detail was called with repoPath + issueNumber
		expect(mockInvoke).toHaveBeenCalledWith("get_issue_detail", {
			repoPath: "/repo",
			issueNumber: 42,
		});
	});

	it("passes the edited prompt to onConfirm and closes on Start auto-fix", async () => {
		const props = baseProps();
		const { container, getByText } = render(() => <AutofixDialog {...props} />);

		await waitFor(() => {
			expect(container.querySelector("textarea")).not.toBeNull();
		});
		const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
		fireEvent.input(textarea, { target: { value: "Edited prompt text" } });

		fireEvent.click(getByText("Start auto-fix"));

		expect(props.onConfirm).toHaveBeenCalledWith("Edited prompt text");
		expect(props.onClose).toHaveBeenCalledTimes(1);
	});

	it("calls onClose when Cancel is clicked", async () => {
		const props = baseProps();
		const { container, getByText } = render(() => <AutofixDialog {...props} />);

		await waitFor(() => {
			expect(container.querySelector("textarea")).not.toBeNull();
		});

		fireEvent.click(getByText("Cancel"));
		expect(props.onClose).toHaveBeenCalledTimes(1);
		expect(props.onConfirm).not.toHaveBeenCalled();
	});
});
