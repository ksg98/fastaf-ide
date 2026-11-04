import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoriesDialog } from "../../components/StoriesDialog/StoriesDialog";
import { invoke } from "../../invoke";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));
vi.mock("../../stores/modalStack", () => ({ registerModal: vi.fn() }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: vi.fn() } }));

const draft = {
	title: "Search saved work",
	storyType: "feature",
	priority: 2,
	problem: "Saved work is hard to find.",
	criteria: ["A title query finds matching work", "[MANUAL] Review keyboard navigation"],
};
// FastAF fills the draft on its own engine (`story_generate_draft` → the
// Headless provider), not ego: one call, no reservation to prepare or cancel.
// Cancelling drops the late reply on the client.
let generate: () => Promise<unknown>;
const actions = () =>
	vi
		.mocked(invoke)
		.mock.calls.filter(([command]) => command === "story_action_command")
		.map(([, args]) => (args as { action: { action: string; input?: unknown } }).action);

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	generate = async () => draft;
	vi.mocked(invoke).mockImplementation(async (command, args) => {
		if (command === "story_capabilities") return true;
		if (command === "story_generate_draft") return generate();
		const action = (args as { action: { action: string } }).action;
		if (action.action === "list_plans")
			return { type: "plans", value: [{ id: "p1", title: "Plan", project: "/repo", source: "plan.md" }] };
		if (action.action === "plan_view")
			return { type: "plan_view", value: { stories: [], state: "draft", wontFixCount: 0, allCancelled: false } };
		if (action.action === "create_story") return { type: "story", value: { id: "s1" } };
		throw new Error(`Unexpected command ${command} ${action.action}`);
	});
});

async function openForm(project: string | (() => string) = "/repo") {
	const view = render(() => (
		<StoriesDialog project={typeof project === "string" ? project : project()} onClose={() => {}} />
	));
	const open = await screen.findByRole("button", { name: "New story" });
	await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
	fireEvent.click(open);
	fireEvent.input(screen.getByLabelText("Request"), { target: { value: "Let me search saved work" } });
	return view;
}

describe("AI story draft review boundary", () => {
	it("never saves generated fields until the user reviews and explicitly creates the story", async () => {
		// Catches: a successful AI fill bypasses review and calls create_story itself.
		await openForm();
		fireEvent.click(screen.getByRole("button", { name: "Fill with AI" }));
		await waitFor(() => expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Search saved work"));
		expect(actions().some((action) => action.action === "create_story")).toBe(false);
		expect(invoke).toHaveBeenCalledWith("story_generate_draft", {
			project: "/repo",
			request: "Let me search saved work",
		});
		fireEvent.input(screen.getByLabelText("Title"), { target: { value: "Reviewed search" } });
		fireEvent.submit(screen.getByRole("button", { name: "Create story" }).closest("form")!);
		await waitFor(() =>
			expect(actions()).toContainEqual(
				expect.objectContaining({
					action: "create_story",
					problem: draft.problem,
					input: expect.objectContaining({
						title: "Reviewed search",
						criteria: draft.criteria,
						priority: 2,
						storyType: "feature",
					}),
				}),
			),
		);
	});

	it("rejects a late reply after Cancel without clearing the request", async () => {
		// Catches: cancelled generation still overwrites the editable draft.
		let finish!: (value: unknown) => void;
		generate = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		await openForm();
		fireEvent.click(screen.getByRole("button", { name: "Fill with AI" }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("story_generate_draft", expect.anything()));
		expect(screen.getByRole("status").textContent).toContain("Filling");
		fireEvent.click(screen.getByRole("button", { name: "Cancel fill" }));
		await screen.findByText("Fill cancelled.");
		finish(draft);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect((screen.getByLabelText("Request") as HTMLTextAreaElement).value).toBe("Let me search saved work");
		expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
		expect(actions().some((action) => action.action === "create_story")).toBe(false);
	});

	it("keeps request and manually entered fields usable when generation fails", async () => {
		// Catches: malformed/model failure destroys user input or leaves the form locked.
		generate = async () => {
			throw new Error("Invalid story draft reply");
		};
		await openForm();
		fireEvent.input(screen.getByLabelText("Title"), { target: { value: "My title" } });
		fireEvent.click(screen.getByRole("button", { name: "Fill with AI" }));
		await screen.findByText("Invalid story draft reply");
		expect((screen.getByLabelText("Request") as HTMLTextAreaElement).value).toBe("Let me search saved work");
		expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("My title");
		expect((screen.getByRole("button", { name: "Fill with AI" }) as HTMLButtonElement).disabled).toBe(false);
	});
});

// Exercise the real invoke/router for owned work, keeping unrelated story-list
// setup local to this component fixture. Assert outgoing destinations, not mocks'
// return values or a hand-copied routing argument shape.
async function routeOwnedCalls() {
	const { invoke: realInvoke } = await vi.importActual<typeof import("../../invoke")>("../../invoke");
	const runtime = await import("../../transportRuntime");
	runtime.setRepoConnectionLookup((path) => (path === "/remote/repo" ? "story-daemon" : undefined));
	runtime.setRemoteBaseUrlLookup((id) => (id === "story-daemon" ? "http://story-daemon.test" : undefined));
	runtime.setRemoteTokenLookup(() => undefined);
	const setupInvoke = vi.mocked(invoke).getMockImplementation()!;
	vi.mocked(invoke).mockImplementation((command, args) =>
		command === "acp_one_shot_prepare" || command === "acp_one_shot_cancel" || command === "story_generate_draft"
			? realInvoke(command, args)
			: setupInvoke(command, args),
	);
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

afterEach(async () => {
	vi.unstubAllGlobals();
	const runtime = await import("../../transportRuntime");
	runtime.setRepoConnectionLookup(() => undefined);
	runtime.setRemoteBaseUrlLookup(() => undefined);
	runtime.setRemoteTokenLookup(() => undefined);
});

describe("remote story fill ownership", () => {
	it("generates on the daemon that owns the project, and drops the reply once cancelled", async () => {
		// Catches: a remote fill running locally, or a cancelled reply overwriting the draft.
		const fetch = await routeOwnedCalls();
		let finish!: (response: Response) => void;
		fetch.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const [project, setProject] = createSignal("/remote/repo");
		await openForm(project);
		fireEvent.click(screen.getByRole("button", { name: "Fill with AI" }));
		await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		setProject("/other/repo");
		fireEvent.click(screen.getByRole("button", { name: "Cancel fill" }));
		await screen.findByText("Fill cancelled.");
		finish(Response.json(draft));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["http://story-daemon.test/acp/story-draft"]);
		expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
	});
});
