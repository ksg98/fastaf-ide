import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionAction, SectionHeader } from "../../components/shared/SectionHeader";

afterEach(cleanup);

describe("SectionHeader", () => {
	it("shows the label, the count and the meta text", () => {
		const { container } = render(() => <SectionHeader label="Staged" count="3/8" meta="ChangesTab.tsx" />);
		expect(container.querySelector(".sectionLabel")?.textContent).toBe("Staged");
		expect(container.querySelector(".sectionCount")?.textContent).toBe("3/8");
		expect(container.querySelector(".sectionMeta")?.textContent).toBe("ChangesTab.tsx");
	});

	it("omits an empty count", () => {
		const { container } = render(() => <SectionHeader label="Remote" count="" />);
		expect(container.querySelector(".sectionCount")).toBeNull();
	});

	it("is a plain label, with no toggle, when it cannot collapse", () => {
		const { container } = render(() => <SectionHeader label="Changed files" count={14} />);
		expect(container.querySelector("button")).toBeNull();
		expect(container.querySelector("svg")).toBeNull();
	});

	it("toggles from a real button that reports aria-expanded", () => {
		const [open, setOpen] = createSignal(true);
		const onToggle = vi.fn(() => setOpen((v) => !v));
		const { container } = render(() => (
			<SectionHeader label="Unstaged" count={8} open={open()} onToggle={onToggle} title="src/a.ts" />
		));
		const toggle = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(toggle.getAttribute("title")).toBe("src/a.ts");
		// An explicit Tab stop: WebKit skips plain buttons unless macOS keyboard navigation is on.
		expect(toggle.getAttribute("tabindex")).toBe("0");
		toggle.click();
		expect(onToggle).toHaveBeenCalledOnce();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});

	it("keeps its actions visible and outside the toggle, so an action never collapses the group", () => {
		const onToggle = vi.fn();
		const onStageAll = vi.fn();
		const { container } = render(() => (
			<SectionHeader
				label="Unstaged"
				open={true}
				onToggle={onToggle}
				actions={
					<SectionAction title="Stage all" onClick={onStageAll}>
						+
					</SectionAction>
				}
			/>
		));
		const action = container.querySelector('button[title="Stage all"]') as HTMLButtonElement;
		expect(action.getAttribute("aria-label")).toBe("Stage all");
		expect(action.closest("button[aria-expanded]")).toBeNull();
		action.click();
		expect(onStageAll).toHaveBeenCalledOnce();
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("marks a danger action and honours disabled", () => {
		const onDiscard = vi.fn();
		const { container } = render(() => (
			<SectionHeader
				label="Unstaged"
				actions={
					<SectionAction title="Discard all" tone="danger" disabled onClick={onDiscard}>
						x
					</SectionAction>
				}
			/>
		));
		const action = container.querySelector('button[title="Discard all"]') as HTMLButtonElement;
		expect(action.classList.contains("sectionActionDanger")).toBe(true);
		expect(action.disabled).toBe(true);
	});

	it("draws the drawer form as a full-width band", () => {
		const { container } = render(() => <SectionHeader label="History" variant="drawer" />);
		expect(container.querySelector(".sectionHeaderDrawer")).not.toBeNull();
	});
});
