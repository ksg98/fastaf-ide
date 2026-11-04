import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const reloadPlugin = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("./pluginLoader", () => ({ reloadPlugin: (...args: unknown[]) => reloadPlugin(...args) }));

import {
	accountFromValues,
	loadWorkItemSetup,
	missingFields,
	saveWorkItemSetup,
	setupFor,
	upsertAccount,
	valuesFromAccount,
} from "./workItemSetup";

const github = () => {
	const setup = setupFor("github-work");
	if (!setup) throw new Error("github-work setup missing");
	return setup;
};
const gitlab = () => {
	const setup = setupFor("gitlab");
	if (!setup) throw new Error("gitlab setup missing");
	return setup;
};

beforeEach(() => {
	invoke.mockReset();
	reloadPlugin.mockReset();
});

describe("work-item plugin setup", () => {
	// Catches: a pasted repository keeping its stray whitespace, so the plugin queries "owner/repo " and every call 404s.
	it("builds a trimmed account from form values", () => {
		expect(accountFromValues(github(), { id: "github.com", repository: " owner/repo " })).toEqual({
			id: "github.com",
			repository: "owner/repo",
		});
	});

	// Catches: boards typed as lines being stored as one string, which the provider cannot map to board ids.
	it("turns board lines into {id, name} entries and back", () => {
		const account = accountFromValues(gitlab(), {
			id: "gitlab.com",
			host: "https://gitlab.com",
			project: "group/project",
			boards: "12 Sprint board\n13",
		});
		expect(account.boards).toEqual([
			{ id: "12", name: "Sprint board" },
			{ id: "13", name: "13" },
		]);
		expect(valuesFromAccount(gitlab(), account).boards).toBe("12 Sprint board\n13");
	});

	// Catches: an empty optional field written as "" or [], which overrides the provider's own default.
	it("omits optional fields left blank", () => {
		const account = accountFromValues(gitlab(), {
			id: "gitlab.com",
			host: "https://gitlab.com",
			project: "",
			boards: "",
		});
		expect(account).toEqual({ id: "gitlab.com", host: "https://gitlab.com" });
	});

	// Catches: saving with the required project blank, which registers a provider that fails on first use.
	it("names every blank required field", () => {
		expect(missingFields(gitlab(), { id: "gitlab.com", host: "", project: "g/p", boards: "" })).toEqual(["Host"]);
		expect(missingFields(github(), { id: "github.com", repository: "owner/repo" })).toEqual([]);
	});

	// Catches: the form replacing the whole file, which drops accounts and keys the user wrote by hand.
	it("replaces the account with the same id and keeps everything else", () => {
		const raw = JSON.stringify({
			note: "keep",
			accounts: [
				{ id: "a", repository: "o/a" },
				{ id: "b", repository: "o/b" },
			],
		});
		const next = JSON.parse(upsertAccount(raw, { id: "b", repository: "o/new" }));
		expect(next).toEqual({
			note: "keep",
			accounts: [
				{ id: "a", repository: "o/a" },
				{ id: "b", repository: "o/new" },
			],
		});
		expect(JSON.parse(upsertAccount(null, { id: "a", repository: "o/a" }))).toEqual({
			accounts: [{ id: "a", repository: "o/a" }],
		});
	});

	// Catches: a hand-edited config with a syntax error being silently overwritten by the form.
	it("refuses to overwrite a config file that is not valid JSON", () => {
		expect(() => upsertAccount("{ not json", { id: "a" })).toThrow(/work-items\.json/);
	});

	// Catches: the saved file never reaching the plugin, because data/ writes do not trigger the plugin watcher.
	it("writes work-items.json and reloads the plugin", async () => {
		invoke.mockImplementation(async (command: string) => (command === "read_plugin_data" ? null : undefined));
		await saveWorkItemSetup(github(), { id: "github.com", repository: "owner/repo" });
		expect(invoke).toHaveBeenCalledWith("write_plugin_data", {
			pluginId: "github-work",
			path: "work-items.json",
			content: JSON.stringify({ accounts: [{ id: "github.com", repository: "owner/repo" }] }, null, 2),
		});
		expect(reloadPlugin).toHaveBeenCalledWith("github-work");
	});

	// Catches: a failed write still reloading the plugin and reporting success.
	it("does not reload when the write fails", async () => {
		invoke.mockImplementation(async (command: string) => {
			if (command === "write_plugin_data") throw new Error("disk full");
			return null;
		});
		await expect(saveWorkItemSetup(github(), { id: "github.com", repository: "o/r" })).rejects.toThrow("disk full");
		expect(reloadPlugin).not.toHaveBeenCalled();
	});

	// Catches: the form opening empty over an existing config, so one save erases the repository.
	it("loads the first saved account as form values, with defaults when there is none", async () => {
		invoke.mockResolvedValueOnce(JSON.stringify({ accounts: [{ id: "gh", repository: "o/r" }] }));
		expect(await loadWorkItemSetup(github())).toEqual({ id: "gh", repository: "o/r" });
		invoke.mockResolvedValueOnce(null);
		expect(await loadWorkItemSetup(github())).toEqual({ id: "github.com", repository: "" });
	});

	// Catches: saving the form replacing the whole account, dropping keys the form has no field for
	// (GitLab login/label drive the "mine" presets, GitHub apiUrl points at an Enterprise host).
	it("keeps the keys of the saved account that the form does not edit", async () => {
		const existing = {
			accounts: [{ id: "gitlab.com", host: "https://gitlab.com", project: "g/old", login: "sstraus", label: "Work" }],
		};
		invoke.mockImplementation(async (command: string) =>
			command === "read_plugin_data" ? JSON.stringify(existing) : undefined,
		);
		await saveWorkItemSetup(gitlab(), { id: "gitlab.com", host: "https://gitlab.com", project: "g/new", boards: "" });
		const write = invoke.mock.calls.find(([command]) => command === "write_plugin_data");
		expect(JSON.parse(write?.[1].content).accounts).toEqual([
			{ id: "gitlab.com", host: "https://gitlab.com", project: "g/new", login: "sstraus", label: "Work" },
		]);
	});
	// Catches: merging the account restoring cleared optional fields or resetting an existing auth kind.
	it("clears optional form keys while preserving the saved authentication kind", async () => {
		const setup = setupFor("jira");
		if (!setup) throw new Error("jira setup missing");
		invoke.mockImplementation(async (command: string) =>
			command === "account_action"
				? [{ id: "work", provider: "jira", kind: "bearer" }]
				: JSON.stringify({
						accounts: [
							{
								id: "work",
								host: "https://jira.example",
								kind: "bearer",
								projectId: "7",
								boards: [{ id: "1", name: "Sprint" }],
							},
						],
					}),
		);
		await saveWorkItemSetup(setup, { id: "work", host: "https://jira.example", projectId: "", boards: "" });
		const write = invoke.mock.calls.find(([command]) => command === "write_plugin_data");
		expect(JSON.parse(write?.[1].content).accounts).toEqual([
			{ id: "work", host: "https://jira.example", kind: "bearer" },
		]);
	});
});

// Catches: Tasks writing the reserved settings file, another plugin's storage, or a file other
// than the work-items.json a provider plugin reads its accounts from.
it.each(["github-work", "jira", "gitlab"])("Tasks accounts round-trip through %s plugin data", async (pluginId) => {
	const setup = setupFor(pluginId)!;
	const values: Record<string, string> =
		pluginId === "github-work"
			? { id: "test-account", repository: "owner/repo" }
			: { id: "test-account", host: "https://example.test" };
	const files = new Map<string, string>();
	invoke.mockImplementation(async (command: string, args: { pluginId?: string; path: string; content?: string }) => {
		if (command === "account_action") return [{ id: "test-account", provider: "jira", kind: "basic" }];
		if (args.pluginId !== pluginId) throw new Error("wrong storage owner");
		// The real host reserves this name for schema-backed settings, not Tasks data.
		if (args.path === "config.json") throw new Error("Configurable plugin requires a settings schema");
		if (command === "write_plugin_data") files.set(args.path, args.content!);
		return command === "read_plugin_data" ? (files.get(args.path) ?? null) : undefined;
	});
	await saveWorkItemSetup(setup, values);
	expect(await loadWorkItemSetup(setup)).toMatchObject(values);
	expect([...files.keys()]).toEqual(["work-items.json"]);
	expect(JSON.parse(files.get("work-items.json")!).accounts).toEqual([
		{ ...accountFromValues(setup, values), ...(pluginId === "jira" ? { kind: "basic" } : {}) },
	]);
	// Writes under data/ are not watched, so the plugin must be reloaded to read them.
	expect(reloadPlugin).toHaveBeenCalledWith(pluginId);
});

// Catches: new Data Center setup defaults to Cloud or stale plugin kind wins over the registered account.
it.each(["basic", "bearer"])("Jira setup uses registered %s account kind", async (kind) => {
	const setup = setupFor("jira")!;
	invoke.mockImplementation(async (command: string) => {
		if (command === "account_action") return [{ id: "work", provider: "jira", kind }];
		if (command === "read_plugin_data")
			return JSON.stringify({ accounts: [{ id: "work", kind: kind === "basic" ? "bearer" : "basic" }] });
	});
	await saveWorkItemSetup(setup, { id: "work", host: "https://jira.example" });
	const write = invoke.mock.calls.find(([command]) => command === "write_plugin_data");
	expect(JSON.parse(write?.[1].content).accounts[0].kind).toBe(kind);
});

// Catches: a newly configured Data Center site gets the Cloud constant when no plugin account exists yet.
it("new Jira setup stores registered Data Center kind", async () => {
	invoke.mockImplementation(async (command: string) =>
		command === "account_action" ? [{ id: "dc", provider: "jira", kind: "bearer" }] : null,
	);
	await saveWorkItemSetup(setupFor("jira")!, { id: "dc", host: "https://jira.example/jira" });
	const write = invoke.mock.calls.find(([command]) => command === "write_plugin_data");
	expect(JSON.parse(write?.[1].content).accounts).toEqual([
		{ id: "dc", host: "https://jira.example/jira", kind: "bearer" },
	]);
});

// Catches: an unknown account or another provider's account silently registers Jira Cloud.
it("Jira setup refuses missing or unsupported registered accounts without writing", async () => {
	for (const accounts of [
		[],
		[{ id: "work", provider: "gitlab", kind: "bearer" }],
		[{ id: "work", provider: "jira", kind: "ambient" }],
	]) {
		invoke.mockReset();
		invoke.mockResolvedValue(accounts);
		await expect(saveWorkItemSetup(setupFor("jira")!, { id: "work", host: "https://jira.example" })).rejects.toThrow(
			"registered Jira",
		);
		expect(invoke).not.toHaveBeenCalledWith("write_plugin_data", expect.anything());
	}
});
