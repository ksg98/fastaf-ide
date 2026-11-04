import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Plugin ids this build bundles (`list_bundled_plugins`). FastAF ships none. */
const bundled = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("../../../invoke", () => ({
	invoke: vi.fn(async (command: string) =>
		command === "fetch_plugin_registry"
			? []
			: command === "list_bundled_plugins"
				? bundled.ids
				: command === "get_plugin_readme_path"
					? "/fixture/README.md"
					: null,
	),
}));

import { PluginsTab } from "../../../components/SettingsPanel/tabs/PluginsTab";
import { invoke } from "../../../invoke";
import { pluginStore } from "../../../stores/pluginStore";

afterEach(() => {
	cleanup();
	pluginStore.clear();
	bundled.ids = [];
});

describe("Plugins settings work-item hints", () => {
	// Catches: Settings listing no hint that Tasks needs a work-item plugin, so the user never finds where to get one.
	it("hints at each work-item plugin this build can install", async () => {
		bundled.ids = ["github-work", "gitlab", "jira"];
		render(() => <PluginsTab />);
		expect(await screen.findByText(/GitHub issues and pull requests · Not installed/)).toBeInTheDocument();
		expect(screen.getByText(/GitLab issues · Not installed/)).toBeInTheDocument();
		expect(screen.getByText(/Jira issues · Not installed/)).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("button", { name: "Install GitHub Work" })).toBeEnabled());
	});

	// Catches: a column of disabled "Install …" cards saying "Not available in
	// this build" when nothing is bundled and no registry lists a provider.
	it("shows no provider card when none can be installed", async () => {
		render(() => <PluginsTab />);
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_bundled_plugins"));
		await Promise.resolve();
		expect(screen.queryByText(/· Not installed/)).toBeNull();
		expect(screen.queryByRole("button", { name: /^Install (GitHub Work|GitLab|Jira)$/ })).toBeNull();
		expect(screen.queryByText("Not available in this build.")).toBeNull();
	});

	it("shows a card only for the providers this build can install", async () => {
		bundled.ids = ["jira"];
		render(() => <PluginsTab />);
		expect(await screen.findByText(/Jira issues · Not installed/)).toBeInTheDocument();
		expect(screen.queryByText(/GitLab issues · Not installed/)).toBeNull();
		expect(screen.queryByText(/GitHub issues and pull requests · Not installed/)).toBeNull();
	});

	it("opens only a loaded catalogue page through its named Settings action", () => {
		pluginStore.registerPlugin("fixture", { loaded: true });
		const open = vi.fn();
		render(() => <PluginsTab settingsPluginIds={["fixture"]} onOpenSettings={open} />);
		fireEvent.click(screen.getByRole("button", { name: "Settings" }));
		expect(open).toHaveBeenCalledWith("fixture");
	});

	// Catches: migrated controls losing the icon name, log pressed state or uninstall confirmation boundary.
	it("names documentation, toggles logs and confirms before uninstalling", async () => {
		pluginStore.registerPlugin("fixture", { loaded: true });
		pluginStore.getLogger("fixture").info("Fixture log entry");
		render(() => <PluginsTab />);
		expect(await screen.findByRole("button", { name: "View plugin documentation" })).toHaveAttribute("type", "button");
		fireEvent.click(screen.getByText("Manage plugin"));
		const logs = screen.getByRole("button", { name: "Logs" });
		expect(logs).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(logs);
		expect(logs).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("Fixture log entry")).toBeInTheDocument();
		fireEvent.click(logs);
		expect(screen.queryByText("Fixture log entry")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
		expect(invoke).not.toHaveBeenCalledWith("uninstall_plugin", { id: "fixture" });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(pluginStore.getPlugin("fixture")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
		fireEvent.keyDown(document, { key: "Enter" });
		await waitFor(() => expect(pluginStore.getPlugin("fixture")).toBeUndefined());
		expect(invoke).toHaveBeenCalledWith("uninstall_plugin", { id: "fixture" });
	});

	// Catches: a hint staying on screen for a plugin that is already installed.
	it("drops the hint of an installed work-item plugin", async () => {
		bundled.ids = ["github-work", "gitlab", "jira"];
		pluginStore.registerPlugin("gitlab", { loaded: true });
		render(() => <PluginsTab />);
		expect(await screen.findByText(/Jira issues · Not installed/)).toBeInTheDocument();
		expect(screen.queryByText(/GitLab issues · Not installed/)).not.toBeInTheDocument();
	});
});
