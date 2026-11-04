// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { Transcript } from "../../components/AIChatPanel/Transcript";

afterEach(cleanup);

it("renders old and new edit text instead of dropping the diff body", () => {
	// catches: structured diff content reduced to its path in the tool disclosure.
	const view = render(() => (
		<Transcript
			mobile
			entries={() => [
				{
					id: "edit",
					kind: "tool",
					call: {
						toolCallId: "edit",
						title: "Edit: table.tsv",
						kind: "edit",
						status: "completed",
						content: [
							{
								type: "diff",
								path: "table.tsv",
								oldText: "key\told\nsecond\tbefore",
								newText: "key\tnew\nsecond\tafter",
							},
						],
					},
				},
			]}
			busy={() => false}
			emptyMessage=""
			observeToolDuration={false}
		/>
	));
	for (const details of view.container.querySelectorAll("details")) details.open = true;
	const diff = view.getByRole("figure", { name: "Edit diff: table.tsv" });
	expect(diff.querySelector('[aria-label="Old text"]')?.textContent).toBe("key\told\nsecond\tbefore");
	expect(diff.querySelector('[aria-label="New text"]')?.textContent).toBe("key\tnew\nsecond\tafter");
	expect(view.getByRole("region", { name: "Scrollable edit: table.tsv" }).getAttribute("tabindex")).toBe("0");
});

it("renders a new-file diff without inventing an old version or interpreting code as markup", () => {
	// catches: null oldText becomes a bogus deletion and file text is interpreted as HTML.
	const view = render(() => (
		<Transcript
			mobile
			entries={() => [
				{
					id: "new",
					kind: "tool",
					call: {
						toolCallId: "new",
						title: "New file",
						status: "completed",
						content: [{ type: "diff", path: "new.html", oldText: null, newText: "<script>unsafe()</script>" }],
					},
				},
			]}
			busy={() => false}
			emptyMessage=""
			observeToolDuration={false}
		/>
	));
	for (const details of view.container.querySelectorAll("details")) details.open = true;
	expect(view.queryByLabelText("Old text")).toBeNull();
	expect(view.getByLabelText("New text").textContent).toBe("<script>unsafe()</script>");
	expect(view.container.querySelector("script")).toBeNull();
});

// Catches: structured edit disclosures reintroduce an always-visible scrolling caption.
it("renders edit diffs without invented guidance", () => {
	const view = render(() => (
		<Transcript
			entries={() => [
				{
					id: "edit",
					kind: "tool",
					call: {
						toolCallId: "edit",
						title: "Edit",
						status: "completed",
						content: [{ type: "diff", path: "file.txt", oldText: "before", newText: "after" }],
					},
				},
			]}
			busy={() => false}
			emptyMessage=""
		/>
	));
	for (const details of view.container.querySelectorAll("details")) details.open = true;
	expect(view.getByLabelText("New text").textContent).toBe("after");
	expect(view.container.textContent).not.toContain("Scroll horizontally to read long lines →");
});
