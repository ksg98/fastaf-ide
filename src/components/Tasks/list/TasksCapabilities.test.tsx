import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { listDemo } from "./demo";
import { TasksList } from "./TasksList";

afterEach(cleanup);

// Catches: unsupported hard-coded sort options and every schema field offered as a filter/group.
it("offers_only_provider_declared_query_capabilities", async () => {
	const provider = listDemo(2);
	const list = provider.list.bind(provider);
	provider.list = async (query, signal) => ({ ...(await list(query, signal)), total: 1001 });
	provider.fields.forEach((field) =>
		Object.assign(field, {
			sortable: false,
			groupable: field.id === "priority",
			filterable: field.id === "priority",
		}),
	);
	render(() => <TasksList providers={[provider]} onOpen={() => {}} />);
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 of 1,001 items"));
	fireEvent.click(screen.getByRole("button", { name: "Filters" }));
	expect(screen.getByLabelText("Sort tasks").querySelectorAll("option")).toHaveLength(1);
	expect(screen.getByLabelText("Group tasks").querySelectorAll("option")).toHaveLength(2);
	expect(screen.queryByLabelText("Filter State")).not.toBeInTheDocument();
	expect(screen.getByLabelText("Filter Priority")).toBeInTheDocument();
});

// Catches: rejected sort stays selected, claiming stale rows use the rejected query.
it("restores_last_successful_selection_and_keeps_rejection_reason", async () => {
	const provider = listDemo(2);
	const list = provider.list.bind(provider);
	Object.assign(provider.fields.find((field) => field.id === "title") ?? provider.fields[0], { sortable: true });
	provider.list = async (query, signal) => {
		if (query.sort) throw new Error("Sort permission revoked");
		return { ...(await list(query, signal)), total: 1001 };
	};
	render(() => <TasksList providers={[provider]} onOpen={() => {}} />);
	await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 of 1,001 items"));
	fireEvent.click(screen.getByRole("button", { name: "Filters" }));
	fireEvent.change(screen.getByLabelText("Sort tasks"), { target: { value: "title" } });
	await screen.findByText("Sort permission revoked");
	await waitFor(() => expect(screen.getByLabelText("Sort tasks")).toHaveValue(""));
});
