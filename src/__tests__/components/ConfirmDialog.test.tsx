import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../components/ConfirmDialog/ConfirmDialog";

describe("ConfirmDialog", () => {
	const baseProps = {
		visible: true,
		title: "Confirm",
		message: "Proceed?",
	};

	it("renders nothing when not visible", () => {
		const { container } = render(() => (
			<ConfirmDialog {...baseProps} visible={false} onConfirm={() => {}} onClose={() => {}} />
		));
		expect(container.querySelector("button")).toBeNull();
	});

	it("wires the confirm and cancel buttons", () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		const { getByText } = render(() => (
			<ConfirmDialog {...baseProps} confirmLabel="Yes" cancelLabel="No" onConfirm={onConfirm} onClose={onClose} />
		));
		fireEvent.click(getByText("Yes"));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		fireEvent.click(getByText("No"));
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
		const { getByText } = render(() => (
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
		fireEvent.click(getByText("Don't Save"));
		expect(onDiscard).toHaveBeenCalledTimes(1);
	});

	it("omits the discard button when discardLabel is not set", () => {
		const { queryByText } = render(() => (
			<ConfirmDialog {...baseProps} confirmLabel="Save" onConfirm={() => {}} onClose={() => {}} />
		));
		expect(queryByText("Don't Save")).toBeNull();
	});
});
