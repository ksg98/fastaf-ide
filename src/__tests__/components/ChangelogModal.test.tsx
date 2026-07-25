import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../mocks/tauri";
import "../mocks/tauri";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

const { mockWriteClipboard, mockDownloadText } = vi.hoisted(() => ({
	mockWriteClipboard: vi.fn<() => Promise<void>>(() => Promise.resolve()),
	mockDownloadText: vi.fn(),
}));

vi.mock("../../utils/clipboard", () => ({
	writeClipboard: mockWriteClipboard,
}));

vi.mock("../../utils/downloadText", () => ({
	downloadText: mockDownloadText,
}));

import { ChangelogModal } from "../../components/ChangelogModal/ChangelogModal";

describe("ChangelogModal", () => {
	const defaultProps = {
		repoPath: "/repo",
		onClose: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue({ markdown: "## CL\n- x", json: {} });
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("shows loading state then renders the markdown", async () => {
		let resolveInvoke!: (value: unknown) => void;
		mockInvoke.mockReturnValueOnce(new Promise((res) => (resolveInvoke = res)));

		const { container } = render(() => <ChangelogModal {...defaultProps} />);
		// Loading state visible before the promise resolves
		expect(container.querySelector(".spinner")).not.toBeNull();

		resolveInvoke({ markdown: "## CL\n- x", json: {} });

		await waitFor(() => {
			expect(container.querySelector(".markdown")).not.toBeNull();
		});
		expect(container.querySelector(".markdown")!.textContent).toContain("## CL");
		expect(container.querySelector(".spinner")).toBeNull();
	});

	it("calls writeClipboard when Copy is clicked", async () => {
		const { container } = render(() => <ChangelogModal {...defaultProps} />);

		await waitFor(() => {
			expect(container.querySelector(".markdown")).not.toBeNull();
		});

		const copyBtn = container.querySelectorAll(".btn")[0] as HTMLButtonElement;
		fireEvent.click(copyBtn);
		expect(mockWriteClipboard).toHaveBeenCalledWith("## CL\n- x");
	});

	it("calls downloadText when Save is clicked", async () => {
		const { container } = render(() => <ChangelogModal {...defaultProps} />);

		await waitFor(() => {
			expect(container.querySelector(".markdown")).not.toBeNull();
		});

		const saveBtn = container.querySelectorAll(".btn")[1] as HTMLButtonElement;
		fireEvent.click(saveBtn);
		expect(mockDownloadText).toHaveBeenCalledWith("CHANGELOG-ai.md", "## CL\n- x");
	});
});
