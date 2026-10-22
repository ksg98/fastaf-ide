import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { IconGit } from "../../components/icons";
import { EmptyState } from "../../components/shared/EmptyState";

afterEach(cleanup);

describe("EmptyState", () => {
	it("has a shape: icon, title and one line of help", () => {
		const { container } = render(() => (
			<EmptyState icon={IconGit} title="No changes" description="The working tree matches main." />
		));
		expect(container.querySelector("svg")).not.toBeNull();
		expect(container.querySelector(".emptyTitle")?.textContent).toBe("No changes");
		expect(container.querySelector(".emptyDescription")?.textContent).toBe("The working tree matches main.");
		expect(container.querySelector("[role]")).toBeNull();
	});

	it("renders one action under the text", () => {
		const { getByText } = render(() => (
			<EmptyState title="This folder is empty" action={<button type="button">New file</button>} />
		));
		expect(getByText("New file").closest(".emptyAction")).not.toBeNull();
	});

	it("shows a spinner instead of the icon while loading, as a status", () => {
		const { container } = render(() => <EmptyState icon={IconGit} loading title="Loading commits…" />);
		const root = container.querySelector(".emptyState") as HTMLElement;
		expect(root.getAttribute("role")).toBe("status");
		expect(root.classList.contains("emptyStateLoading")).toBe(true);
		expect(container.querySelector(".loadingSpinner")).not.toBeNull();
		expect(container.querySelector("svg")).toBeNull();
	});

	it("announces an error and keeps its message", () => {
		const { container } = render(() => (
			<EmptyState
				icon={IconGit}
				tone="error"
				title="Couldn't load the history"
				description={"fatal: bad object\nHEAD"}
			/>
		));
		const root = container.querySelector(".emptyState") as HTMLElement;
		expect(root.getAttribute("role")).toBe("alert");
		expect(root.classList.contains("emptyStateError")).toBe(true);
		expect(container.querySelector(".emptyDescription")?.textContent).toBe("fatal: bad object\nHEAD");
	});

	it("drops the icon in the compact drawer form", () => {
		const { container } = render(() => (
			<EmptyState icon={IconGit} size="compact" title="Select a file to see its history" />
		));
		expect(container.querySelector(".emptyStateCompact")).not.toBeNull();
		expect(container.querySelector("svg")).toBeNull();
	});
});
