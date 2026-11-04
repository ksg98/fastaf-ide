import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workItemProviderRegistry } from "../../plugins/workItemProviderRegistry";
import { pluginStore } from "../../stores/pluginStore";
import { listDemo } from "./list/demo";
import { roadmapDemo } from "./roadmap/demo";
import { TasksShell } from "./TasksShell";

vi.mock("../../invoke", () => ({
	invoke: vi.fn(async (command: string) => (command === "fetch_plugin_registry" ? [] : null)),
}));

// happy-dom has no layout. Supply viewport geometry, keeping the real virtualizer.
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
});
afterEach(() => {
	cleanup();
	pluginStore.clear();
	vi.restoreAllMocks();
});

describe("Tasks shell", () => {
	// Catches: the shell mounting views without any provider and showing a broken list.
	it("explains that a provider plugin is needed when none is registered", () => {
		render(() => <TasksShell />);
		expect(screen.getByText(/No work-item provider is set up/)).toBeInTheDocument();
	});

	// Catches: the empty tab saying "no provider" twice, or pointing at a Settings
	// page name ("Plugins") that the nav does not have.
	it("says what to do in one sentence that names the real Settings page", async () => {
		render(() => <TasksShell />);
		expect(
			await screen.findByText("Install a provider plugin from a folder or .zip in Settings › Manage plugins."),
		).toBeInTheDocument();
		expect(screen.queryByText("Install and configure one to show tasks.")).not.toBeInTheDocument();
		expect(screen.queryByText(/ships with FastAF/)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Install/ })).not.toBeInTheDocument();
	});

	// Catches: an empty Tasks tab that cannot start the setup, so the user must edit data/config.json by hand.
	it("shows the setup form of an installed plugin instead of an empty tab", async () => {
		pluginStore.registerPlugin("github-work", { loaded: true });
		render(() => <TasksShell />);
		expect(await screen.findByText(/GitHub Work needs a repository/)).toBeInTheDocument();
		expect(screen.getByLabelText("Repository")).toBeInTheDocument();
		expect(await screen.findByText("Install and configure one to show tasks.")).toBeInTheDocument();
		expect(screen.queryByText(/Manage plugins/)).not.toBeInTheDocument();
	});

	// Catches: the Roadmap tab opening onto an empty timeline for a provider with no date field.
	it("hides the Roadmap view when the provider has no date field", async () => {
		const registration = workItemProviderRegistry.register(listDemo(3));
		try {
			render(() => <TasksShell />);
			await screen.findByRole("button", { name: /Task 00001/ });
			expect(screen.getByRole("tab", { name: "Board" })).toBeInTheDocument();
			expect(screen.queryByRole("tab", { name: "Roadmap" })).not.toBeInTheDocument();
		} finally {
			registration.dispose();
		}
	});

	// Catches: switching to a source without dates leaving the shell on the Roadmap view it just hid.
	it("falls back to the list when the selected source has no date field", async () => {
		const dated = workItemProviderRegistry.register(roadmapDemo(2));
		const plain = workItemProviderRegistry.register(listDemo(2, "plain"));
		try {
			render(() => <TasksShell />);
			fireEvent.click(await screen.findByRole("tab", { name: "Roadmap" }));
			await screen.findByRole("region", { name: "Tasks roadmap" });
			fireEvent.change(screen.getByLabelText("Tasks source"), { target: { value: JSON.stringify(["demo", "plain"]) } });
			expect(await screen.findByRole("button", { name: /Task 00001/ })).toBeInTheDocument();
			expect(screen.queryByRole("region", { name: "Tasks roadmap" })).not.toBeInTheDocument();
		} finally {
			plain.dispose();
			dated.dispose();
		}
	});

	// Catches: a configured provider with no way to change its repository, project or boards from the UI.
	it("opens the setup form of the selected provider from the header", async () => {
		pluginStore.registerPlugin("gitlab", { loaded: true });
		const base = listDemo(2);
		const registration = workItemProviderRegistry.register({
			...base,
			providerId: "gitlab",
			list: base.list,
		} as typeof base);
		try {
			render(() => <TasksShell />);
			fireEvent.click(await screen.findByRole("button", { name: "Provider settings" }));
			expect(await screen.findByLabelText("Project")).toBeInTheDocument();
			expect(screen.getByLabelText("Boards")).toBeInTheDocument();
		} finally {
			registration.dispose();
		}
	});

	// Catches: a list row click that never reaches the detail view.
	it("opens the detail of a clicked list row for the selected provider", async () => {
		const registration = workItemProviderRegistry.register(listDemo(3));
		try {
			render(() => <TasksShell />);
			fireEvent.click(await screen.findByRole("button", { name: /Task 00002/ }));
			expect(await screen.findByRole("region", { name: "Task detail" })).toBeInTheDocument();
			await waitFor(() => expect(screen.getByText("DEMO-2")).toBeInTheDocument());
		} finally {
			registration.dispose();
		}
	});

	// Catches: the board and roadmap views not being reachable from the shell.
	it("switches to the board and the roadmap views", async () => {
		const registration = workItemProviderRegistry.register(roadmapDemo(3));
		try {
			render(() => <TasksShell />);
			await screen.findByRole("tab", { name: "Roadmap" });
			fireEvent.click(screen.getByRole("tab", { name: "Board" }));
			expect(await screen.findByRole("region", { name: "Tasks board" })).toBeInTheDocument();
			fireEvent.click(screen.getByRole("tab", { name: "Roadmap" }));
			expect(await screen.findByRole("region", { name: "Tasks roadmap" })).toBeInTheDocument();
		} finally {
			registration.dispose();
		}
	});

	// Catches: New task never reaching the create form of the selected provider.
	it("opens the create form for the selected provider", async () => {
		const registration = workItemProviderRegistry.register(listDemo(1));
		try {
			render(() => <TasksShell />);
			fireEvent.click(await screen.findByRole("button", { name: "New task" }));
			expect(await screen.findByRole("form", { name: "Create task" })).toBeInTheDocument();
		} finally {
			registration.dispose();
		}
	});

	// Catches: below 700 px the detail has no way back to the list (the list is hidden by CSS).
	it("back_control_returns_from_the_detail_to_the_list", async () => {
		const registration = workItemProviderRegistry.register(listDemo(3));
		try {
			render(() => <TasksShell />);
			const body = await screen.findByLabelText("Tasks shell").then((shell) => shell.querySelector("[data-detail]"));
			expect(body).toHaveAttribute("data-detail", "closed");
			fireEvent.click(await screen.findByRole("button", { name: /Task 00002/ }));
			await screen.findByRole("region", { name: "Task detail" });
			expect(body).toHaveAttribute("data-detail", "open");
			// Hidden above 700 px by a container query, which happy-dom evaluates as plain display:none.
			fireEvent.click(screen.getByRole("button", { name: "Back to list", hidden: true }));
			expect(screen.queryByRole("region", { name: "Task detail" })).not.toBeInTheDocument();
			expect(body).toHaveAttribute("data-detail", "closed");
			expect(screen.getByRole("button", { name: /Task 00002/ })).toBeInTheDocument();
		} finally {
			registration.dispose();
		}
	});

	// Catches: the shell not telling the list which task is open, so no row is highlighted.
	it("highlights the row of the open task", async () => {
		const registration = workItemProviderRegistry.register(listDemo(3));
		try {
			render(() => <TasksShell />);
			fireEvent.click(await screen.findByRole("button", { name: /Task 00002/ }));
			await waitFor(() =>
				expect(screen.getByRole("button", { name: /Task 00002/ })).toHaveAttribute("aria-current", "true"),
			);
			expect(screen.getByRole("button", { name: /Task 00001/ })).not.toHaveAttribute("aria-current");
		} finally {
			registration.dispose();
		}
	});
	// Catches: below 700 px an open detail keeps `.main` hidden, so "New task" opens a form the user cannot see.
	it("closes the open detail when New task is chosen, so the narrow layout shows the form", async () => {
		const registration = workItemProviderRegistry.register(listDemo(3));
		try {
			render(() => <TasksShell />);
			fireEvent.click(await screen.findByRole("button", { name: /Task 00002/ }));
			await screen.findByRole("region", { name: "Task detail" });
			fireEvent.click(screen.getByRole("button", { name: "New task" }));
			expect(await screen.findByRole("form", { name: "Create task" })).toBeInTheDocument();
			expect(screen.queryByRole("region", { name: "Task detail" })).not.toBeInTheDocument();
		} finally {
			registration.dispose();
		}
	});
});
