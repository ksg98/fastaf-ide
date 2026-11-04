import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { BranchBadge, CiBadge, PrBadge, StatusBadge } from "../../components/ui/StatusBadge";
import type { PrReadinessKind } from "../../utils/prReadiness";

describe("StatusBadge", () => {
	it("renders label text", () => {
		const { container } = render(() => <StatusBadge label="Active" />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge).not.toBeNull();
		expect(badge!.textContent).toBe("Active");
	});

	it("applies variant class", () => {
		const { container } = render(() => <StatusBadge label="OK" variant="success" />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.getAttribute("data-variant")).toBe("success");
	});

	it("defaults to 'default' variant when none specified", () => {
		const { container } = render(() => <StatusBadge label="Default" />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.getAttribute("data-variant")).toBe("default");
	});

	it("shows pointer cursor when onClick is provided", () => {
		const { container } = render(() => <StatusBadge label="Clickable" onClick={() => {}} />);
		const badge = container.querySelector("[data-testid='status-badge']") as HTMLElement;
		expect(badge.style.cursor).toBe("pointer");
	});

	it("shows default cursor when no onClick", () => {
		const { container } = render(() => <StatusBadge label="Static" />);
		const badge = container.querySelector("[data-testid='status-badge']") as HTMLElement;
		expect(badge.style.cursor).toBe("default");
	});

	it("fires click handler", () => {
		const handleClick = vi.fn();
		const { container } = render(() => <StatusBadge label="Click me" onClick={handleClick} />);
		fireEvent.click(container.querySelector("[data-testid='status-badge']")!);
		expect(handleClick).toHaveBeenCalledOnce();
	});
});

describe("BranchBadge", () => {
	it("renders branch name", () => {
		const { container } = render(() => <BranchBadge branch="main" ahead={0} behind={0} />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.textContent).toContain("main");
	});

	it("shows ahead indicator", () => {
		const { container } = render(() => <BranchBadge branch="feature" ahead={3} behind={0} />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.textContent).toContain("\u21913");
		expect(badge!.getAttribute("data-variant")).toBe("info");
	});

	it("shows behind indicator", () => {
		const { container } = render(() => <BranchBadge branch="feature" ahead={0} behind={2} />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.textContent).toContain("\u21932");
	});

	it("shows both ahead and behind", () => {
		const { container } = render(() => <BranchBadge branch="feature" ahead={1} behind={5} />);
		const badge = container.querySelector("[data-testid='status-badge']");
		const text = badge!.textContent!;
		expect(text).toContain("\u21911");
		expect(text).toContain("\u21935");
	});

	it("uses branch variant when not ahead", () => {
		const { container } = render(() => <BranchBadge branch="main" ahead={0} behind={0} />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.getAttribute("data-variant")).toBe("branch");
	});
});

describe("PrBadge", () => {
	const variantOf = (readiness: PrReadinessKind) => {
		const { container } = render(() => <PrBadge number={1} title="PR" readiness={readiness} />);
		return container.querySelector("[data-testid='status-badge']")!.getAttribute("data-variant");
	};

	// Catches: the status bar keeping its own verdict (mergeable === CONFLICTING) next to the shared one.
	it.each([
		["merged", "merged"],
		["closed", "closed"],
		["open", "pr"],
		["ready", "success"],
		["conflict", "error"],
		["ci-failed", "error"],
		["changes-requested", "error"],
		["unresolved-comments", "warning"],
		["ci-pending", "warning"],
		["checking", "warning"],
	] as const)("%s shows the %s variant", (readiness, variant) => {
		expect(variantOf(readiness)).toBe(variant);
	});
});

describe("CiBadge", () => {
	it("shows 'CI passed' for success conclusion", () => {
		const { container } = render(() => <CiBadge status="completed" conclusion="success" workflowName="CI" />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.textContent).toBe("CI passed");
		expect(badge!.getAttribute("data-variant")).toBe("success");
	});

	it("shows 'CI failed' for failure conclusion", () => {
		const { container } = render(() => <CiBadge status="completed" conclusion="failure" workflowName="CI" />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.textContent).toBe("CI failed");
		expect(badge!.getAttribute("data-variant")).toBe("error");
	});

	it("shows 'CI pending' when status is pending and no conclusion", () => {
		const { container } = render(() => <CiBadge status="pending" conclusion={null} workflowName="Build" />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.textContent).toBe("CI pending");
		expect(badge!.getAttribute("data-variant")).toBe("warning");
	});

	it("sets title to workflow name", () => {
		const { container } = render(() => <CiBadge status="completed" conclusion="success" workflowName="My Workflow" />);
		const badge = container.querySelector("[data-testid='status-badge']");
		expect(badge!.getAttribute("title")).toBe("My Workflow");
	});
});
