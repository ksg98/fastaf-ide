// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryWorkItemProvider } from "../../../../plugins/testing/inMemoryWorkItemProvider";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import type { WorkItemAction, WorkItemDetail, WorkItemFieldSchema } from "../../../../types/work-items.gen";
import { TasksCreate } from "../TasksCreate";

const enumField = (id: string, name: string, required: boolean, options: string[]): WorkItemFieldSchema => ({
	id,
	name,
	kind: "enum",
	required,
	editable: true,
	sortable: false,
	groupable: false,
	filterable: false,
	options: options.map((option) => ({ id: option, name: option.toUpperCase() })),
});
const picker = enumField("itemType", "Type", true, ["bug", "task"]);
const priority = enumField("priority", "Priority", true, ["high", "low"]);
const schemas: Record<string, WorkItemFieldSchema[]> = {
	bug: [priority, enumField("severity", "Severity", true, ["s1", "s2"])],
	task: [
		priority,
		{
			id: "component",
			name: "Component",
			kind: "text",
			required: true,
			editable: true,
			sortable: false,
			groupable: false,
			filterable: false,
			options: [],
		},
	],
};

/** The A4 fake has one schema for every type; two types with different required fields need a wrapper. */
function typedProvider(overrides: Partial<WorkItemProvider> = {}) {
	const fake = createInMemoryWorkItemProvider();
	const created: WorkItemAction[] = [];
	const provider: WorkItemProvider = {
		...fake,
		createFields: async (itemType) => structuredClone(itemType ? schemas[itemType] : [picker]),
		act: async (_reference, action) => {
			created.push(action);
			return { kind: "item", value: await fake.detail({ providerId: "demo", accountId: "local", id: "1" }) };
		},
		...overrides,
	};
	return { provider, created };
}

const select = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const type = (label: string, value: string) => fireEvent.input(screen.getByLabelText(label), { target: { value } });
const createButton = () => screen.getByRole("button", { name: "Create" });

describe("TasksCreate", () => {
	// Catches: switching from bug to task keeps the bug's required Severity, so the form blocks or sends it.
	it("type_change_reloads_required_fields", async () => {
		const { provider, created } = typedProvider();
		render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
		await screen.findByRole("option", { name: "BUG" });
		select("Type *", "bug");
		await screen.findByLabelText("Severity *");
		type("Title *", "Crash on start");
		select("Priority *", "high");
		select("Severity *", "s1");
		select("Type *", "task");
		await screen.findByLabelText("Component *");
		expect(screen.queryByLabelText("Severity *")).toBeNull();
		expect(createButton()).toBeDisabled();
		type("Component *", "terminal");
		await waitFor(() => expect(createButton()).not.toBeDisabled());
		fireEvent.click(createButton());
		await waitFor(() => expect(created).toHaveLength(1));
		expect(created[0]).toEqual({
			kind: "create",
			value: {
				title: "Crash on start",
				body: "",
				itemType: "task",
				fields: { priority: { kind: "enum", value: "high" }, component: { kind: "text", value: "terminal" } },
			},
		});
	});

	// Catches: an empty required field reaches the provider, which answers 400 instead of the form blocking it.
	it("submit_blocked_until_required_filled", async () => {
		const { provider, created } = typedProvider();
		const { container } = render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
		await screen.findByRole("option", { name: "BUG" });
		select("Type *", "bug");
		await screen.findByLabelText("Severity *");
		type("Title *", "Crash on start");
		select("Priority *", "high");
		expect(createButton()).toBeDisabled();
		expect(screen.getByText("Required: Severity")).toBeTruthy();
		fireEvent.submit(container.querySelector("form") as HTMLFormElement);
		await Promise.resolve();
		expect(created).toHaveLength(0);
		select("Severity *", "s2");
		expect(createButton()).not.toBeDisabled();
		fireEvent.click(createButton());
		await waitFor(() => expect(created).toHaveLength(1));
	});

	// Catches: a slow schema answer for the earlier type replaces the schema of the type now selected.
	it("stale_type_schema_never_replaces_current", async () => {
		let releaseBug: () => void = () => {};
		const { provider } = typedProvider({
			createFields: (itemType) => {
				if (!itemType) return Promise.resolve([picker]);
				if (itemType === "task") return Promise.resolve(structuredClone(schemas.task));
				return new Promise((resolve) => {
					releaseBug = () => resolve(structuredClone(schemas.bug));
				});
			},
		});
		render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
		await screen.findByRole("option", { name: "BUG" });
		select("Type *", "bug");
		select("Type *", "task");
		await screen.findByLabelText("Component *");
		releaseBug();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(screen.getByLabelText("Component *")).toBeTruthy();
		expect(screen.queryByLabelText("Severity *")).toBeNull();
	});

	// Catches: a double click on Create files the item twice at the provider.
	it("double_submit_creates_once", async () => {
		let finish: (detail: WorkItemDetail) => void = () => {};
		const act = vi.fn(
			() =>
				new Promise<{ kind: "item"; value: WorkItemDetail }>(
					(resolve) => (finish = (value) => resolve({ kind: "item", value })),
				),
		);
		const { provider } = typedProvider({ act });
		const onCreated = vi.fn();
		render(() => <TasksCreate provider={provider} onCreated={onCreated} />);
		await screen.findByRole("option", { name: "BUG" });
		select("Type *", "task");
		await screen.findByLabelText("Component *");
		type("Title *", "Docs");
		select("Priority *", "low");
		type("Component *", "docs");
		fireEvent.click(createButton());
		fireEvent.click(screen.getByRole("button", { name: "Creating…" }));
		expect(act).toHaveBeenCalledTimes(1);
		finish(await createInMemoryWorkItemProvider().detail({ providerId: "demo", accountId: "local", id: "1" }));
		await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
	});

	// Catches: a rejected create clears the draft, so the user retypes everything after a provider error.
	it("rejected_create_keeps_draft", async () => {
		const { provider } = typedProvider({
			act: async () => {
				throw new Error("HTTP 400: component is not valid");
			},
		});
		const onCreated = vi.fn();
		render(() => <TasksCreate provider={provider} onCreated={onCreated} />);
		await screen.findByRole("option", { name: "BUG" });
		select("Type *", "task");
		await screen.findByLabelText("Component *");
		type("Title *", "Docs");
		select("Priority *", "low");
		type("Component *", "docs");
		fireEvent.click(createButton());
		expect((await screen.findByRole("alert")).textContent).toContain("HTTP 400: component is not valid");
		expect((screen.getByLabelText("Title *") as HTMLInputElement).value).toBe("Docs");
		expect((screen.getByLabelText("Component *") as HTMLInputElement).value).toBe("docs");
		expect(onCreated).not.toHaveBeenCalled();
	});

	// Catches: the created item is not handed to the host, so it never opens; checked end to end on the A4 fake.
	it("created_item_opens_from_the_fake_provider", async () => {
		const fake = createInMemoryWorkItemProvider();
		const onCreated = vi.fn<(detail: WorkItemDetail) => void>();
		render(() => <TasksCreate provider={fake} onCreated={onCreated} />);
		await screen.findByLabelText("Priority *");
		expect((screen.getByLabelText("Type *") as HTMLSelectElement).value).toBe("issue");
		type("Title *", "Created from the form");
		select("Priority *", "high");
		fireEvent.click(createButton());
		await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
		const opened = await fake.detail(onCreated.mock.calls[0][0].item.reference);
		expect(opened.item.title).toBe("Created from the form");
		expect(opened.item.itemType).toBe("issue");
		expect((screen.getByLabelText("Title *") as HTMLInputElement).value).toBe("");
	});

	// Catches: a provider without the itemType picker leaves a silent empty form instead of an error.
	it("provider_without_item_types_reports_it", async () => {
		const fake = createInMemoryWorkItemProvider();
		const provider: WorkItemProvider = { ...fake, createFields: async () => structuredClone([...fake.fields]) };
		render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
		expect((await screen.findByRole("alert")).textContent).toContain("declares no item types");
		expect(createButton()).toBeDisabled();
	});
});
