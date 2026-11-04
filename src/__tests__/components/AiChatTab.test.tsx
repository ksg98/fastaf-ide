import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockListen, mockToast } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	mockListen: vi.fn().mockResolvedValue(vi.fn()),
	mockToast: vi.fn(),
}));

vi.mock("../../invoke", () => ({
	invoke: mockInvoke,
	listen: mockListen,
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../stores/toasts", () => ({
	toastsStore: { add: mockToast },
}));

import { AiChatTab } from "../../components/SettingsPanel/tabs/AiChatTab";

// The reasoning dropdown is the select that carries the effort options.
function reasoningSelect(container: HTMLElement): HTMLSelectElement {
	const select = Array.from(container.querySelectorAll("select")).find((el) =>
		el.querySelector('option[value="medium"]'),
	);
	if (!select) throw new Error("reasoning select not found");
	return select as HTMLSelectElement;
}

interface Job {
	id: string;
	cron_expr: string;
	goal: string;
	target_session: string | null;
	max_duration_secs: number;
	enabled: boolean;
	one_shot: boolean;
	next_run?: string | null;
}

const job = (over: Partial<Job> = {}): Job => ({
	id: "job-a",
	cron_expr: "0 0/15 * * * *",
	goal: "run tests and report",
	target_session: null,
	max_duration_secs: 300,
	enabled: true,
	one_shot: false,
	next_run: null,
	...over,
});

/** The backend's even steps (scheduler::MINUTE_STEPS / HOUR_STEPS). */
const CHOICES = { minutes: [5, 6, 10, 12, 15, 20, 30], hours: [1, 2, 3, 4, 6, 8, 12] };

/** Stand-in for the backend's cron building and labels, for the shapes used here. */
const CRON: Record<string, string> = { minutes: "0 0/{n} * * * *", hours: "0 0 0/{n} * * *", day: "0 0 9 * * *" };
const LABELS: Record<string, string> = {
	"0 0/15 * * * *": "Every 15 min",
	"0 0/30 * * * *": "Every 30 min",
	"0 0 0/2 * * *": "Every 2 hours",
	"0 0 9 */1 * *": "Every day",
	"0 0 9 * * *": "Every day",
};

type AddArgs = { goal: string; every: number; unit: string; oneShot: boolean };

/** Resolve invoke per command so onMount's loads don't reject. `jobs` is the
 * backend's `ai-cron.json`: saves replace it and the next load reads it back,
 * with the view-only label added as the backend would. */
function invokeImpl(config: { temperature?: number; reasoning_effort?: string } = {}, initialJobs: Job[] = []) {
	let jobs = initialJobs;
	const view = () => ({
		jobs: jobs.map((j) => ({ ...j, label: LABELS[j.cron_expr] ?? j.cron_expr })),
		choices: CHOICES,
	});
	return (cmd: string, args?: { config?: { jobs: Job[] } } & Partial<AddArgs>) => {
		if (cmd === "load_ai_chat_config") return Promise.resolve({ temperature: 0.7, ...config });
		if (cmd === "load_scheduler_config") return Promise.resolve(view());
		if (cmd === "save_scheduler_config") {
			jobs = args?.config?.jobs ?? [];
			return Promise.resolve(undefined);
		}
		if (cmd === "add_scheduled_job") {
			const { goal = "", every = 0, unit = "", oneShot = false } = args ?? {};
			jobs = [
				...jobs,
				job({
					id: `job-${jobs.length}`,
					goal,
					cron_expr: CRON[unit].replace("{n}", String(every)),
					one_shot: oneShot,
				}),
			];
			return Promise.resolve(view());
		}
		return Promise.resolve(undefined);
	};
}

/** The jobs passed to the most recent `save_scheduler_config`. */
function lastSavedJobs(): Job[] {
	const last = mockInvoke.mock.calls.filter(([cmd]) => cmd === "save_scheduler_config").at(-1);
	if (!last) throw new Error("save_scheduler_config was never called");
	return last[1].config.jobs;
}

describe("AiChatTab extended-thinking setting", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockImplementation(invokeImpl());
		mockListen.mockResolvedValue(vi.fn());
	});

	afterEach(() => {
		cleanup();
	});

	it("renders auto/off plus every level the backend can encode", () => {
		// With no provider slot resolved there is nothing to ask an endpoint about,
		// so the list falls back to the encodable vocabulary rather than a
		// Claude-shaped subset.
		const { container } = render(() => <AiChatTab />);
		const values = Array.from(reasoningSelect(container).options).map((o) => o.value);
		expect(values).toEqual(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("defaults to auto", () => {
		const { container } = render(() => <AiChatTab />);
		expect(reasoningSelect(container).value).toBe("auto");
	});

	it("reflects the persisted value loaded from config", async () => {
		mockInvoke.mockImplementation(invokeImpl({ reasoning_effort: "high" }));
		const { container } = render(() => <AiChatTab />);
		await vi.waitFor(() => {
			expect(reasoningSelect(container).value).toBe("high");
		});
	});

	it("persists the chosen effort to the AI chat config", async () => {
		const { container } = render(() => <AiChatTab />);
		// Let onMount's async config load settle before changing the dropdown,
		// otherwise the load resets the signal after our change.
		await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("load_ai_chat_config"));
		const select = reasoningSelect(container);
		fireEvent.change(select, { target: { value: "low" } });
		// saveConfig is debounced by 500ms — wait past the debounce.
		await new Promise((r) => setTimeout(r, 700));
		expect(mockInvoke).toHaveBeenCalledWith(
			"save_ai_chat_config",
			expect.objectContaining({ config: expect.objectContaining({ reasoning_effort: "low" }) }),
		);
	});
});

describe("AiChatTab page structure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockImplementation(invokeImpl());
		mockListen.mockResolvedValue(vi.fn());
	});

	afterEach(() => cleanup());

	// Same shape as General, Appearance and Dictation: a page header, then cards.
	it("opens with the page header, then the Parameters and Scheduled tasks cards", () => {
		const { container } = render(() => <AiChatTab />);
		expect(container.querySelector("[data-settings-page-header] h2")?.textContent).toBe("AI Chat");
		const cards = Array.from(container.querySelectorAll("section")).map(
			(card) => card.querySelector("h3")?.textContent,
		);
		expect(cards).toEqual(["Parameters", "Scheduled tasks"]);
		const [parameters] = container.querySelectorAll("section");
		expect(within(parameters as HTMLElement).getByText("Temperature")).toBeTruthy();
		expect(within(parameters as HTMLElement).getByText("Extended thinking")).toBeTruthy();
	});
});

describe("AiChatTab scheduled tasks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockListen.mockResolvedValue(vi.fn());
	});

	afterEach(() => cleanup());

	it("lists the jobs already in ai-cron.json with their schedule and badges", async () => {
		mockInvoke.mockImplementation(
			invokeImpl({}, [
				job({ id: "job-a", goal: "run tests and report" }),
				job({ id: "agent-1f", goal: "check the deploy", cron_expr: "0 0 0/2 * * *", one_shot: true }),
				job({ id: "job-b", goal: "tidy branches", cron_expr: "0 0 9 */1 * *", enabled: false }),
			]),
		);
		render(() => <AiChatTab />);
		const list = await screen.findByTestId("scheduled-jobs");
		expect(within(list).getByText("run tests and report")).toBeTruthy();
		expect(within(list).getByText("Every 15 min")).toBeTruthy();
		expect(within(list).getByText("Every 2 hours")).toBeTruthy();
		expect(within(list).getByText("Every day · paused")).toBeTruthy();
		expect(within(list).getByText("Runs once")).toBeTruthy();
		expect(within(list).getByText("Added by agent")).toBeTruthy();
		const switches = within(list).getAllByRole("switch") as HTMLInputElement[];
		expect(switches.map((s) => s.checked)).toEqual([true, true, false]);
	});

	it("shows the next run the backend computed", async () => {
		const next = new Date();
		next.setHours(23, 45, 0, 0);
		mockInvoke.mockImplementation(invokeImpl({}, [job({ next_run: next.toISOString() })]));
		render(() => <AiChatTab />);
		const label = next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		expect(await screen.findByText(`Every 15 min · next ${label}`)).toBeTruthy();
	});

	// The backend builds the cron string and the id; the page sends an interval.
	it("adds a task by sending its goal and interval, not a cron string", async () => {
		mockInvoke.mockImplementation(invokeImpl({}, [job({ next_run: "2026-11-03T10:15:00Z" })]));
		render(() => <AiChatTab />);
		await screen.findByTestId("scheduled-jobs");

		const add = screen.getByRole("button", { name: "Add task" }) as HTMLButtonElement;
		expect(add.disabled).toBe(true);
		fireEvent.input(screen.getByLabelText("New task goal"), { target: { value: "  summarise CI failures  " } });
		fireEvent.change(screen.getByLabelText("Interval"), { target: { value: "30" } });
		fireEvent.click(screen.getByText("Run once"));
		expect(add.disabled).toBe(false);
		fireEvent.click(add);

		await vi.waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("add_scheduled_job", {
				goal: "summarise CI failures",
				every: 30,
				unit: "minutes",
				oneShot: true,
			}),
		);
		expect(mockInvoke).not.toHaveBeenCalledWith("save_scheduler_config", expect.anything());
		// The list comes back from the backend, and the form resets.
		expect(await screen.findByText("summarise CI failures")).toBeTruthy();
		expect(screen.getByText("Every 30 min")).toBeTruthy();
		await vi.waitFor(() => expect((screen.getByLabelText("New task goal") as HTMLInputElement).value).toBe(""));
	});

	// `0/45` minutes would fire at :00 and :45, so only even steps are offered.
	it("offers only the backend's even steps for each unit", async () => {
		mockInvoke.mockImplementation(invokeImpl());
		render(() => <AiChatTab />);
		const values = () =>
			Array.from((screen.getByLabelText("Interval") as HTMLSelectElement).options).map((o) => Number(o.value));
		await vi.waitFor(() => expect(values()).toEqual(CHOICES.minutes));
		expect((screen.getByLabelText("Interval") as HTMLSelectElement).value).toBe("15");

		fireEvent.change(screen.getByLabelText("Interval unit"), { target: { value: "hours" } });
		expect(values()).toEqual(CHOICES.hours);
		// 15 is not an hour step, so the picker moves to one that is.
		expect((screen.getByLabelText("Interval") as HTMLSelectElement).value).toBe("1");
	});

	it("sends a daily task as every 1 day, with no step to pick", async () => {
		mockInvoke.mockImplementation(invokeImpl());
		render(() => <AiChatTab />);
		await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("load_scheduler_config"));

		fireEvent.input(screen.getByLabelText("New task goal"), { target: { value: "nightly audit" } });
		fireEvent.change(screen.getByLabelText("Interval unit"), { target: { value: "day" } });
		expect(screen.queryByLabelText("Interval")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Add task" }));
		await vi.waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("add_scheduled_job", {
				goal: "nightly audit",
				every: 1,
				unit: "day",
				oneShot: false,
			}),
		);
	});

	it("rejects a goal-less task", async () => {
		mockInvoke.mockImplementation(invokeImpl());
		render(() => <AiChatTab />);
		const add = screen.getByRole("button", { name: "Add task" }) as HTMLButtonElement;
		fireEvent.input(screen.getByLabelText("New task goal"), { target: { value: "   " } });
		expect(add.disabled).toBe(true);
	});

	it("tells the user when the backend refuses a new task", async () => {
		const base = invokeImpl();
		mockInvoke.mockImplementation((cmd: string, args?: never) =>
			cmd === "add_scheduled_job"
				? Promise.reject("Intervals must divide the hour or the day evenly")
				: base(cmd, args),
		);
		render(() => <AiChatTab />);
		await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("load_scheduler_config"));
		fireEvent.input(screen.getByLabelText("New task goal"), { target: { value: "lint" } });
		fireEvent.click(screen.getByRole("button", { name: "Add task" }));
		await vi.waitFor(() =>
			expect(mockToast).toHaveBeenCalledWith(
				"Couldn't add the scheduled task",
				"Intervals must divide the hour or the day evenly",
				"error",
			),
		);
		expect((screen.getByLabelText("New task goal") as HTMLInputElement).value).toBe("lint");
	});

	it("pauses and removes a task", async () => {
		mockInvoke.mockImplementation(invokeImpl({}, [job({ id: "job-a" }), job({ id: "job-b", goal: "second" })]));
		render(() => <AiChatTab />);
		const list = await screen.findByTestId("scheduled-jobs");

		fireEvent.click(within(list).getByLabelText('Run "run tests and report" on schedule'));
		await vi.waitFor(() => expect(lastSavedJobs().map((j) => j.enabled)).toEqual([false, true]));
		// View-only fields are not written back into ai-cron.json.
		expect(lastSavedJobs()[0]).not.toHaveProperty("label");
		expect(lastSavedJobs()[0]).not.toHaveProperty("next_run");
		expect(await within(list).findByText("Every 15 min · paused")).toBeTruthy();

		fireEvent.click(within(list).getByLabelText('Remove "second"'));
		await vi.waitFor(() => expect(lastSavedJobs().map((j) => j.id)).toEqual(["job-a"]));
	});

	it("tells the user when a save is refused and keeps the list", async () => {
		const base = invokeImpl({}, [job()]);
		mockInvoke.mockImplementation((cmd: string, args?: { config?: { jobs: Job[] } }) =>
			cmd === "save_scheduler_config" ? Promise.reject("Invalid cron expression") : base(cmd, args),
		);
		render(() => <AiChatTab />);
		const list = await screen.findByTestId("scheduled-jobs");
		fireEvent.click(within(list).getByLabelText('Remove "run tests and report"'));
		await vi.waitFor(() =>
			expect(mockToast).toHaveBeenCalledWith("Couldn't save scheduled tasks", "Invalid cron expression", "error"),
		);
		expect(within(list).getByText("run tests and report")).toBeTruthy();
	});

	// The completion toast is app-wide (hooks/useAiEngineEvents); the page only refreshes.
	it("refreshes the list when a job finishes, without a second toast", async () => {
		let completed: ((event: { payload: { job_id: string; goal: string; timed_out: boolean } }) => void) | undefined;
		mockListen.mockImplementation((event: string, handler: typeof completed) => {
			if (event === "scheduled-job-completed") completed = handler;
			return Promise.resolve(vi.fn());
		});
		mockInvoke.mockImplementation(invokeImpl({}, [job()]));
		render(() => <AiChatTab />);
		await vi.waitFor(() => expect(completed).toBeDefined());
		const loads = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === "load_scheduler_config").length;
		const before = loads();

		completed?.({ payload: { job_id: "job-a", goal: "run tests and report", timed_out: true } });
		await vi.waitFor(() => expect(loads()).toBe(before + 1));
		expect(mockToast).not.toHaveBeenCalledWith("Scheduled task timed out", "run tests and report", "warn");
	});
});
