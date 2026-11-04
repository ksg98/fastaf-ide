// @vitest-environment jsdom
import { render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { WIDE_TYPE, wideSchemaProvider } from "../../create/__tests__/wideSchemaProvider";
import { TasksDetail } from "../TasksDetail";
import { detail, provider, reference } from "./detailFixture";

const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

// Catches: ~50 field forms rendered before Description and Comments, burying the text a reader came for.
it("wide_detail_reads_description_and_comments_before_the_folded_fields", async () => {
	const fields = await wideSchemaProvider().provider.createFields(WIDE_TYPE);
	const wide = { ...detail(), fields };
	render(() => <TasksDetail provider={provider({ detail: async () => wide })} reference={reference} />);
	const section = await screen.findByLabelText("Task fields");
	const group = section.closest("details");
	if (!group) throw new Error("The fields have no group");
	expect(group.open).toBe(false);
	expect(group).toHaveTextContent(`Fields (${fields.length})`);
	expect(section.querySelectorAll("form")).toHaveLength(fields.length);
	const description = screen.getByRole("region", { name: "Description" });
	const comments = screen.getByLabelText("Comments");
	expect(follows(description, group)).toBe(true);
	expect(follows(group, comments)).toBe(true);
});

// Catches: a project with a handful of fields loses the always-visible field list.
it("small_detail_keeps_its_few_fields_open", async () => {
	render(() => <TasksDetail provider={provider()} reference={reference} />);
	const group = (await screen.findByLabelText("Task fields")).closest("details");
	expect(group?.open).toBe(true);
});
