import { AGENT_USAGE_BLINK_THRESHOLD } from "./usageThresholds";

/**
 * Codex usage — types and ticker formatting.
 *
 * The lifecycle (polling, ticker writes, agent switching) lives in
 * `agentUsage.ts`; this module only owns the Codex-specific shape and how it
 * renders. Mirrors `claudeUsage.ts`'s pure helpers so the two agents can share
 * one ticker slot.
 */

export interface CodexRateWindow {
	used_percent: number;
	limit_window_seconds: number | null;
	/** Seconds until reset — preferred over `reset_at`, it needs no local clock. */
	reset_after_seconds: number | null;
	reset_at: number | null;
}

export interface CodexRateLimit {
	allowed: boolean | null;
	limit_reached: boolean;
	primary_window: CodexRateWindow | null;
	secondary_window: CodexRateWindow | null;
}

export interface CodexAdditionalRateLimit {
	limit_name: string | null;
	metered_feature: string | null;
	rate_limit: CodexRateLimit | null;
}

export interface CodexUsageApiResponse {
	plan_type: string | null;
	rate_limit: CodexRateLimit | null;
	additional_rate_limits: CodexAdditionalRateLimit[];
	credits: { has_credits: boolean; unlimited: boolean; balance: string | null } | null;
	model_usage: Record<string, { available: boolean; available_at: string | null; credits_would_enable: boolean }>;
}

/** Name a window by its length: 18000s -> "5h", 604800s -> "7d".
 * Codex does not label its windows, so the duration is the only honest name. */
export function windowLabel(seconds: number | null): string {
	if (!seconds || seconds <= 0) return "?";
	const hours = Math.round(seconds / 3600);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/** Compact countdown from a seconds-remaining value, e.g. "3d", "5h", "12m".
 * Returns null when there is nothing to count down to. */
export function formatResetAfter(seconds: number | null): string | null {
	if (seconds === null || seconds <= 0) return null;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Every window worth showing: the account limit first, then per-model limits. */
function allWindows(api: CodexUsageApiResponse): CodexRateWindow[] {
	const limits = [api.rate_limit, ...(api.additional_rate_limits ?? []).map((a) => a.rate_limit)];
	return limits.flatMap((l) => [l?.primary_window, l?.secondary_window]).filter((w): w is CodexRateWindow => !!w);
}

/** Build status bar ticker text. `used_percent` is already 0-100. */
export function buildCodexTickerText(api: CodexUsageApiResponse): string {
	const windows = [api.rate_limit?.primary_window, api.rate_limit?.secondary_window].filter(
		(w): w is CodexRateWindow => !!w,
	);
	if (windows.length === 0) return "no data";

	return windows
		.map((w) => {
			const reset = formatResetAfter(w.reset_after_seconds);
			const suffix = reset ? ` -${reset}` : "";
			return `${windowLabel(w.limit_window_seconds)}: ${Math.round(w.used_percent)}%${suffix}`;
		})
		.join(" · ");
}

/** Ticker priority from the hottest window across account and per-model limits. */
export function getCodexTickerPriority(api: CodexUsageApiResponse): number {
	const maxUsed = Math.max(0, ...allWindows(api).map((w) => w.used_percent));
	if (maxUsed >= AGENT_USAGE_BLINK_THRESHOLD) return AGENT_USAGE_BLINK_THRESHOLD;
	if (maxUsed >= 70) return 50;
	return 10;
}
