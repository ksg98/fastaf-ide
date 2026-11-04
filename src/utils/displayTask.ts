// Pure helper kept apart from activitySnapshot: that module imports the terminals
// store, which would drag it (and settings, tabManager, paneLayout) into the mobile bundle.
/** Every label `terminalStatusLabel` can produce, lowercased. */
const STATUS_LABELS = new Set(["rate limited", "error", "waiting for input", "working", "completed", "idle"]);

/**
 * The task worth showing next to a status badge — `null` when there is none.
 *
 * A `current_task` is whatever the agent painted on its status line. When that
 * is a bare spinner verb it repeats the badge sitting right next to it: a row
 * reading "Working / Working" costs a line and says nothing. Claude's verbs are
 * dropped wholesale because it cycles decorative ones ("Undulating",
 * "Crunching") that restate the badge without matching its wording.
 *
 * Matching is exact against the labels this module itself produces, so a real
 * task ("Waiting for background terminal") is never mistaken for a verb.
 */
export function displayTask(
	currentTask: string | null | undefined,
	agentType: string | null | undefined,
): string | null {
	if (!currentTask) return null;
	if (agentType === "claude") return null;
	return STATUS_LABELS.has(currentTask.trim().toLowerCase()) ? null : currentTask;
}
