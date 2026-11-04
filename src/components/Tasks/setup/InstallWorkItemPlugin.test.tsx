import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItemPluginSetup } from "../../../plugins/workItemSetup";

const invoke = vi.fn();
vi.mock("../../../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { InstallWorkItemPlugin } from "./InstallWorkItemPlugin";

const setup: WorkItemPluginSetup = {
	pluginId: "github-work",
	providerId: "github",
	name: "GitHub Work",
	missing: "No GitHub account",
	purpose: "Issues and pull requests",
	constants: {},
} as WorkItemPluginSetup;

function answer(bundled: string[], registry: unknown[] = []) {
	invoke.mockImplementation((command: string) => {
		if (command === "list_bundled_plugins") return Promise.resolve(bundled);
		if (command === "fetch_plugin_registry") return Promise.resolve(registry);
		if (command === "install_bundled_plugin") return Promise.resolve({ id: "github-work" });
		return Promise.resolve(null);
	});
}

describe("InstallWorkItemPlugin", () => {
	beforeEach(() => invoke.mockReset());

	// Catches: Tasks dead-ending because FastAF has no plugin registry, although
	// the provider ships inside the app.
	it("installs a bundled provider without the registry", async () => {
		answer(["github-work", "gitlab", "jira"]);
		render(() => <InstallWorkItemPlugin setup={setup} />);
		const button = await screen.findByRole("button", { name: "Install GitHub Work" });
		await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(button);
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("install_bundled_plugin", { id: "github-work" }));
		expect(invoke).not.toHaveBeenCalledWith("install_plugin_from_url", expect.anything());
	});

	// Catches: a button that looks usable but can do nothing.
	it("disables the button and says so when the provider is neither bundled nor listed", async () => {
		answer([]);
		render(() => <InstallWorkItemPlugin setup={setup} />);
		expect(await screen.findByText("Not available in this build.")).toBeTruthy();
		expect((screen.getByRole("button", { name: "Install GitHub Work" }) as HTMLButtonElement).disabled).toBe(true);
	});
});
