import { type Component, createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke, listen } from "../../../invoke";
import { appLogger } from "../../../stores/appLogger";
import { type DiscoveredModel, ENCODABLE_EFFORT_LEVELS, providerRegistryStore } from "../../../stores/providerRegistry";
import { toastsStore } from "../../../stores/toasts";
import { IconTrash } from "../../icons";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Slider } from "../../ui/Slider";
import { StatusBadge } from "../../ui/StatusBadge";
import { Switch } from "../../ui/Switch";
import { SettingSelect } from "../SettingFields";
import s from "../Settings.module.css";
import { ListRow, SectionCard, SettingPageHeader, SettingRow } from "../SettingsPrimitives";
import c from "./AiChatTab.module.css";

/// "auto"/"off" always apply; the levels in between come from whatever the
/// active model's endpoint advertises, so this can't be a closed union.
type ReasoningEffort = string;

interface AiChatConfig {
	temperature: number;
	reasoning_effort?: ReasoningEffort;
}

/** A job as stored in `ai-cron.json` — the shape `save_scheduler_config` takes. */
interface ScheduledJob {
	id: string;
	cron_expr: string;
	goal: string;
	target_session?: string | null;
	max_duration_secs: number;
	enabled: boolean;
	one_shot?: boolean;
}

/** `load_scheduler_config` adds when each enabled job fires next (UTC, from the
 * backend's cron engine) and how its schedule reads ("Every 15 min"). */
interface ScheduledJobView extends ScheduledJob {
	next_run?: string | null;
	label: string;
}

/** The interval units `add_scheduled_job` takes. */
type IntervalUnit = "minutes" | "hours" | "day";

/** The even steps a new task may use — the backend's list, not a second copy here. */
interface IntervalChoices {
	minutes: number[];
	hours: number[];
}

interface SchedulerView {
	jobs: ScheduledJobView[];
	choices: IntervalChoices;
}

/** Local wall-clock time of the backend's next-run instant; the weekday too when it isn't today. */
function nextRunLabel(iso: string | null | undefined): string {
	if (!iso) return "";
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "";
	const today = at.toDateString() === new Date().toDateString();
	return today
		? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: at.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function scheduleLabel(job: ScheduledJobView): string {
	if (!job.enabled) return `${job.label} · paused`;
	const next = nextRunLabel(job.next_run);
	return next ? `${job.label} · next ${next}` : job.label;
}

/** Strip the view-only fields so a save writes exactly the stored shape. */
function stored(job: ScheduledJobView): ScheduledJob {
	const { next_run: _next, label: _label, ...rest } = job;
	return rest;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AiChatTab: Component = () => {
	const [temperature, setTemperature] = createSignal(0.7);
	const [reasoningEffort, setReasoningEffort] = createSignal<ReasoningEffort>("auto");

	// Effort levels for the model the Main slot points at, read from its endpoint
	// rather than hardcoded — different models expose different vocabularies
	// (low/medium/high, xhigh, minimal, …).
	const [effortLevels, setEffortLevels] = createSignal<string[]>(ENCODABLE_EFFORT_LEVELS);
	const [effortModel, setEffortModel] = createSignal("");

	onMount(async () => {
		const resolved = providerRegistryStore.resolveSlot("main");
		if (!resolved) return;
		setEffortModel(resolved.model.model_name);
		try {
			const models = await invoke<DiscoveredModel[]>("fetch_provider_models", {
				providerId: resolved.provider.id,
			});
			const match = models.find((m) => m.id === resolved.model.model_name);
			if (match?.effort_options?.length) setEffortLevels(match.effort_options);
		} catch (e) {
			// Discovery is best-effort — the fallback list still lets the user choose.
			appLogger.warn("config", `Effort discovery failed for ${resolved.provider.id}: ${String(e)}`);
		}
	});

	// Scheduler state
	const [jobs, setJobs] = createSignal<ScheduledJobView[]>([]);
	const [choices, setChoices] = createSignal<IntervalChoices>({ minutes: [], hours: [] });
	const [newEvery, setNewEvery] = createSignal(15);
	const [newUnit, setNewUnit] = createSignal<IntervalUnit>("minutes");
	const [newGoal, setNewGoal] = createSignal("");
	const [newOneShot, setNewOneShot] = createSignal(false);

	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let unlistenCompleted: (() => void) | undefined;
	let disposed = false;

	// ---------------------------------------------------------------------------
	// Config persistence
	// ---------------------------------------------------------------------------

	const saveConfig = () => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(async () => {
			try {
				await invoke("save_ai_chat_config", {
					config: {
						temperature: temperature(),
						reasoning_effort: reasoningEffort(),
					},
				});
			} catch (e) {
				appLogger.error("config", "Failed to save AI Chat config", e);
			}
		}, 500);
	};

	const showView = (view: SchedulerView) => {
		setJobs(view.jobs);
		setChoices(view.choices);
	};

	const loadJobs = async () => {
		try {
			showView(await invoke<SchedulerView>("load_scheduler_config"));
		} catch (e) {
			appLogger.warn("config", "Failed to load scheduler config", e);
		}
	};

	onMount(async () => {
		try {
			const config = await invoke<AiChatConfig>("load_ai_chat_config");
			setTemperature(config.temperature ?? 0.7);
			setReasoningEffort(config.reasoning_effort ?? "auto");
		} catch (e) {
			appLogger.warn("config", "Failed to load AI Chat config", e);
		}

		await loadJobs();

		const unlisten = await listen<{ job_id: string; goal: string; timed_out: boolean }>(
			"scheduled-job-completed",
			() => {
				// The toast is app-wide (hooks/useAiEngineEvents). Here only the list
				// refreshes: one-shot jobs are disabled after their run, and every run
				// moves next_run.
				void loadJobs();
			},
		);
		// onCleanup cannot be registered after an await (the owner is gone), so
		// the synchronous cleanup below releases it — or this does, if the page
		// closed while the subscription was still being set up.
		if (disposed) unlisten();
		else unlistenCompleted = unlisten;
	});
	onCleanup(() => {
		disposed = true;
		clearTimeout(saveTimer);
		unlistenCompleted?.();
	});

	// ---------------------------------------------------------------------------
	// Scheduler handlers
	// ---------------------------------------------------------------------------

	/** Persist the whole list, then re-read it so next-run times come from the backend. */
	const saveJobs = async (next: ScheduledJobView[]): Promise<boolean> => {
		try {
			await invoke("save_scheduler_config", { config: { jobs: next.map(stored) } });
		} catch (e) {
			appLogger.error("config", "Failed to save scheduler config", e);
			toastsStore.add("Couldn't save scheduled tasks", String(e), "error");
			return false;
		}
		await loadJobs();
		return true;
	};

	/** The steps the backend allows for a unit; "day" has none to pick. */
	const steps = (unit: IntervalUnit) => (unit === "day" ? [] : choices()[unit]);

	// The step options arrive with the backend's list and change with the unit,
	// and a select value set before its option exists is dropped. So the value
	// is applied here, after each render of the options.
	let intervalSelect: HTMLSelectElement | undefined;
	createEffect(() => {
		const value = String(newEvery());
		steps(newUnit());
		if (intervalSelect) intervalSelect.value = value;
	});

	const canAdd = () => !!newGoal().trim() && (newUnit() === "day" || steps(newUnit()).includes(newEvery()));

	/** Send the goal and the interval; the backend builds the cron string and the id. */
	const handleAddJob = async () => {
		if (!canAdd()) return;
		try {
			showView(
				await invoke<SchedulerView>("add_scheduled_job", {
					goal: newGoal().trim(),
					every: newUnit() === "day" ? 1 : newEvery(),
					unit: newUnit(),
					oneShot: newOneShot(),
				}),
			);
		} catch (e) {
			appLogger.error("config", "Failed to add scheduled task", e);
			toastsStore.add("Couldn't add the scheduled task", String(e), "error");
			return;
		}
		setNewGoal("");
		setNewOneShot(false);
	};

	const handleToggleJob = (id: string) =>
		saveJobs(jobs().map((j) => (j.id === id ? { ...j, enabled: !j.enabled } : j)));

	const handleRemoveJob = (id: string) => saveJobs(jobs().filter((j) => j.id !== id));

	const reasoningHint = () =>
		`Shows the model's reasoning in a collapsible Thinking block; higher effort costs more tokens and time. Auto turns it on only for models known to support it (Claude Opus 4.7+).${
			effortModel() ? ` Levels shown are those advertised for ${effortModel()}.` : ""
		}`;

	// ---------------------------------------------------------------------------
	// Render
	// ---------------------------------------------------------------------------

	return (
		<div class={`${s.section} ${s.applicationPage}`}>
			<SettingPageHeader title="AI Chat" breadcrumb="AI / AI Chat" scope="Application defaults" />

			<SectionCard title="Parameters">
				<SettingRow label="Temperature" hint="Controls randomness of responses (0.0 = deterministic, 1.0 = creative)">
					{(id, descriptionId) => (
						<div class={s.slider}>
							<Slider
								data-setting-exclusion="fastaf.ai_chat"
								id={id}
								aria-describedby={descriptionId()}
								min={0}
								max={1}
								step={0.1}
								value={temperature()}
								onInput={(e) => {
									setTemperature(parseFloat(e.currentTarget.value));
									saveConfig();
								}}
							/>
							<span>{temperature().toFixed(1)}</span>
						</div>
					)}
				</SettingRow>

				<SettingSelect
					data-setting-exclusion="fastaf.ai_chat"
					row
					label="Extended thinking"
					value={reasoningEffort()}
					onChange={(value) => {
						setReasoningEffort(value);
						saveConfig();
					}}
					options={[
						{ value: "auto", label: "Auto (on for Opus 4.7+)" },
						{ value: "off", label: "Off" },
						...effortLevels().map((level) => ({ value: level, label: level })),
					]}
					hint={reasoningHint()}
				/>
			</SectionCard>

			<SectionCard
				title="Scheduled tasks"
				description="An agent works on each goal on its schedule, in its own terminal and with standard trust: destructive commands wait for your approval."
			>
				<Show when={jobs().length > 0}>
					<div class={c.jobs} data-testid="scheduled-jobs">
						<For each={jobs()}>
							{(job) => (
								<ListRow
									name={job.goal}
									description={scheduleLabel(job)}
									badges={
										job.one_shot || job.id.startsWith("agent-") ? (
											<>
												<Show when={job.one_shot}>
													<StatusBadge label="Runs once" />
												</Show>
												<Show when={job.id.startsWith("agent-")}>
													<StatusBadge label="Added by agent" />
												</Show>
											</>
										) : undefined
									}
									actions={
										<>
											<Switch
												data-setting-exclusion="fastaf.ai_chat"
												aria-label={`Run "${job.goal}" on schedule`}
												checked={job.enabled}
												onChange={() => void handleToggleJob(job.id)}
											/>
											<Button
												data-setting-exclusion="fastaf.ai_chat"
												shape="icon"
												variant="ghost"
												class={c.remove}
												aria-label={`Remove "${job.goal}"`}
												title="Remove task"
												onClick={() => void handleRemoveJob(job.id)}
											>
												<IconTrash size={14} />
											</Button>
										</>
									}
								/>
							)}
						</For>
					</div>
				</Show>

				<div class={c.addForm}>
					<Input
						data-setting-exclusion="fastaf.ai_chat"
						aria-label="New task goal"
						value={newGoal()}
						placeholder="Goal, e.g. run the tests and report failures"
						onInput={(e) => setNewGoal(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleAddJob();
						}}
					/>
					<div class={c.addControls}>
						<span class={c.every}>Every</span>
						{/* Only steps that tick evenly: `0/45` minutes would fire at :00 and :45. */}
						<Show when={newUnit() !== "day"}>
							<Select
								data-setting-exclusion="fastaf.ai_chat"
								class={c.interval}
								aria-label="Interval"
								ref={(el) => {
									intervalSelect = el;
								}}
								onChange={(e) => setNewEvery(Number(e.currentTarget.value))}
							>
								<For each={steps(newUnit())}>{(step) => <option value={String(step)}>{step}</option>}</For>
							</Select>
						</Show>
						<Select
							data-setting-exclusion="fastaf.ai_chat"
							class={c.unit}
							aria-label="Interval unit"
							value={newUnit()}
							onChange={(e) => {
								const unit = e.currentTarget.value as IntervalUnit;
								setNewUnit(unit);
								const allowed = steps(unit);
								if (allowed.length && !allowed.includes(newEvery())) {
									setNewEvery(allowed.includes(15) ? 15 : allowed[0]);
								}
							}}
						>
							<option value="minutes">minutes</option>
							<option value="hours">hours</option>
							<option value="day">day</option>
						</Select>
						<label class={c.once}>
							<Switch
								data-setting-exclusion="fastaf.ai_chat"
								checked={newOneShot()}
								onChange={(e) => setNewOneShot(e.currentTarget.checked)}
							/>
							<span>Run once</span>
						</label>
						<Button
							data-setting-exclusion="fastaf.ai_chat"
							variant="primary"
							class={c.add}
							disabled={!canAdd()}
							onClick={() => void handleAddJob()}
						>
							Add task
						</Button>
					</div>
				</div>
			</SectionCard>
		</div>
	);
};
