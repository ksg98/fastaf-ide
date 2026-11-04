import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, readers } = vi.hoisted(() => ({
	invoke: vi.fn(),
	readers: [] as { read: () => Promise<unknown>; apply: (snapshot: unknown) => void }[],
}));
vi.mock("../../../invoke", () => ({ invoke, listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("../../../stores/repositories", () => ({ repositoriesStore: { getAllReposOrdered: () => [] } }));
vi.mock("../../../services/settingsRefresh", () => ({
	settingsRefresh: {
		register: (reader: (typeof readers)[number]) => {
			readers.push(reader);
			void reader.read().then(reader.apply);
			return () => {};
		},
	},
}));

import { settingsCatalogue } from "../../../generated/settingsCatalogue";
import { hasCatalogueEditor } from "../../../services/settingsCatalogue";
import { AllSettingsTab, CatalogueFieldEditor } from "../AllSettingsTab";
import { SettingSelect } from "../SettingFields";

afterEach(cleanup);
beforeEach(() => {
	invoke.mockReset();
	readers.length = 0;
});
function snapshot(path: string, stored: unknown, revision = "r1") {
	return { revision, values: { [path]: { stored, effective: stored, source: "stored" } } };
}

// Catches: an expert inspector advertising a scalar field without a real native control.
it.each(Object.values(settingsCatalogue.fields).filter(hasCatalogueEditor))(
	"mounts the descriptor identity for $id",
	async (field) => {
		const schema = field.schema as Record<string, unknown>;
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const initial =
			("default" in field ? field.default : undefined) ??
			(types.includes("array")
				? []
				: types.includes("boolean")
					? false
					: types.includes("integer") || types.includes("number")
						? 1
						: "");
		invoke.mockResolvedValue(snapshot(field.path, initial));
		const view = render(() => <CatalogueFieldEditor field={field} path={field.path} />);
		const { container } = view;
		if (types.includes("array") && !schema.enum) {
			fireEvent.click(await view.findByText("Add row"));
		}
		await waitFor(() =>
			expect(container.querySelector("input[data-setting-id],select[data-setting-id]")).not.toBeNull(),
		);
		const controls = [...container.querySelectorAll("[data-setting-id]")];
		expect(controls.every((control) => control.getAttribute("data-setting-id") === field.id)).toBe(true);
		// Catches: the inspector dropping an owner's numeric limits while retaining its identity.
		if (!schema.enum && (types.includes("integer") || types.includes("number"))) {
			const numeric = container.querySelector<HTMLInputElement>("input[type=number]")!;
			expect(numeric.min).toBe(schema.minimum === undefined ? "" : String(schema.minimum));
			expect(numeric.max).toBe(schema.maximum === undefined ? "" : String(schema.maximum));
			if (types.includes("integer")) expect(numeric.step).toBe("1");
		}
	},
);

// Catches: catalogue actions rendering as adjacent buttons without a shared wrapping row.
it("groups catalogue owner actions separately from the field control", async () => {
	const field = settingsCatalogue.fields["app.shell"];
	invoke.mockResolvedValue(snapshot(field.path, null));
	const view = render(() => <CatalogueFieldEditor field={field} path={field.path} />);
	await view.findByText("Save setting");
	const actions = view.getByRole("group", { name: "Setting actions" });
	expect([...actions.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
		"Use null / inherit",
		"Save setting",
		"Reset to owner default",
		"Reload owner",
	]);
	expect(actions.querySelector("input,select")).toBeNull();
});

// Catches: owner provenance repeating the effect already shown beneath the field label.
it("shows the setting effect once and keeps provenance source-only", async () => {
	const field = settingsCatalogue.fields["app.shell"];
	invoke.mockResolvedValue(snapshot(field.path, null));
	const view = render(() => <CatalogueFieldEditor field={field} path={field.path} />);
	await view.findByText("Save setting");
	expect(view.getByRole("status").textContent).toBe("Source: stored.");
	expect(view.getByText(`${field.effect} Apply: ${field.apply}.`)).toBeTruthy();
	expect(view.container.textContent?.split(field.effect)).toHaveLength(2);
});

describe("catalogue owner writes", () => {
	// Catches: a dynamic stable record row reading one path but saving a sibling.
	it("writes_the_bound_record_with_the_read_revision", async () => {
		const field = settingsCatalogue.fields["connections.connections.{id}.enabled"];
		const path = "/connections/test-record/enabled";
		invoke.mockResolvedValue(snapshot(path, false));
		const view = render(() => <CatalogueFieldEditor field={field} path={path} />);
		const control = await view.findByRole("switch");
		fireEvent.click(control);
		fireEvent.click(view.getByText("Save setting"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("settings_action", {
				request: {
					action: "set",
					store: "connections",
					target: { kind: "machine" },
					path,
					expectedRevision: "r1",
					value: true,
				},
			}),
		);
	});

	// Catches: remote refresh moving the CAS token while preserving a dirty draft, allowing silent overwrite.
	it("dirty_refresh_does_not_authorize_a_stale_write", async () => {
		const field = settingsCatalogue.fields["app.shell"];
		invoke.mockResolvedValue(snapshot(field.path, "old"));
		const view = render(() => <CatalogueFieldEditor field={field} path={field.path} />);
		const control = await view.findByRole("textbox");
		fireEvent.input(control, { target: { value: "draft" } });
		readers[0].apply(snapshot(field.path, "remote", "r2"));
		expect((control as HTMLInputElement).value).toBe("draft");
		fireEvent.click(view.getByText("Save setting"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("settings_action", {
				request: expect.objectContaining({ action: "set", value: "draft", expectedRevision: "r1" }),
			}),
		);
	});

	// Catches: replaying a possibly committed mutation before an authoritative recovery read.
	it.each(["partial", "unknown"])("requires_readback_after_%s_outcome", async (outcome) => {
		const field = settingsCatalogue.fields["app.shell"];
		invoke.mockResolvedValue(snapshot(field.path, "old"));
		const view = render(() => <CatalogueFieldEditor field={field} path={field.path} />);
		fireEvent.input(await view.findByRole("textbox"), { target: { value: "draft" } });
		if (outcome === "partial") {
			invoke.mockResolvedValueOnce({ error: { code: "apply_failed", nextAction: "get", persisted: true } });
		} else invoke.mockRejectedValueOnce(new Error("transport lost"));
		fireEvent.click(view.getByText("Save setting"));
		await waitFor(() => expect(view.queryByText("Save setting")).toBeNull());
		expect(view.getByRole("status").textContent).toMatch(/Read back/);
		invoke.mockResolvedValue(snapshot(field.path, "committed", "r2"));
		fireEvent.click(view.getByText("Discard draft and reload"));
		expect(((await view.findByRole("textbox")) as HTMLInputElement).value).toBe("committed");
		fireEvent.input(view.getByRole("textbox"), { target: { value: "new draft" } });
		fireEvent.click(view.getByText("Save setting"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("settings_action", {
				request: expect.objectContaining({ action: "set", expectedRevision: "r2", value: "new draft" }),
			}),
		);
	});

	// Catches: a UI option omitted or invented by a page rather than the Rust enum.
	it.each(
		Object.values(settingsCatalogue.fields).filter((field) =>
			Array.isArray((field.schema as Record<string, unknown>).enum),
		),
	)("ui_options_match_schema: $id", (field) => {
		const view = render(() => (
			<SettingSelect
				settingId={field.id}
				label={field.label}
				value=""
				options={[{ value: "invented", label: "Not authoritative" }]}
				onChange={() => {}}
			/>
		));
		const allowed = ((field.schema as Record<string, unknown>).enum as unknown[]).map((value) =>
			value === null ? "" : String(value),
		);
		expect([...view.container.querySelectorAll("option")].map((option) => option.value)).toEqual(allowed);
	});
});

// Catches: a second catalogue search result leaving the mounted inspector on the previous owner field.
it("follows_second_search_selection_without_leaving_the_inspector", async () => {
	const first = settingsCatalogue.fields["app.shell"];
	const second = settingsCatalogue.fields["app.theme"];
	invoke.mockImplementation((_command, { request }) => Promise.resolve(snapshot(request.paths[0], "")));
	const [selection, select] = createSignal<string>(first.id);
	const view = render(() => <AllSettingsTab initialSetting={selection()} />);
	await waitFor(() => expect(view.container.querySelector(`[data-setting-id="${first.id}"]`)).not.toBeNull());
	select(second.id);
	await waitFor(() => expect(view.container.querySelector(`[data-setting-id="${second.id}"]`)).not.toBeNull());
	expect(view.container.querySelector(`[data-setting-id="${first.id}"]`)).toBeNull();
	const selector = view.container.querySelector("select[data-non-setting]")!;
	fireEvent.change(selector, { target: { value: first.id } });
	await waitFor(() => expect(view.container.querySelector(`[data-setting-id="${first.id}"]`)).not.toBeNull());
});
