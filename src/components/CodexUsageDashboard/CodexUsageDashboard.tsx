import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { type CodexRateWindow, type CodexUsageApiResponse, windowLabel } from "../../features/codexUsage";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { formatQuotaWindow } from "../../utils/sessionUsageFormatting";
// Reuses the Claude dashboard's CSS module on purpose: same card grid, same bar,
// same insight tiles. A second stylesheet would drift on the first theme change.
import s from "../ClaudeUsageDashboard/ClaudeUsageDashboard.module.css";

// ---------------------------------------------------------------------------
// Types (mirrors the Rust structs in codex_usage.rs)
// ---------------------------------------------------------------------------

interface CodexDailyBucket {
	start_date: string;
	tokens: number;
}

interface CodexStats {
	lifetime_tokens: number | null;
	peak_daily_tokens: number | null;
	current_streak_days: number | null;
	longest_streak_days: number | null;
	total_threads: number | null;
	longest_running_turn_sec: number | null;
	fast_mode_usage_percentage: number | null;
	total_skills_used: number | null;
	unique_skills_used: number | null;
	most_used_reasoning_effort: string | null;
	most_used_reasoning_effort_percentage: number | null;
	daily_usage_buckets: CodexDailyBucket[];
}

interface CodexStatsResponse {
	stats: CodexStats;
}

/** A rate window flattened for display, with the name it should carry. */
interface LabelledWindow {
	key: string;
	label: string;
	window: CodexRateWindow;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Compact token counts: 25241643691 -> "25.2B". Raw digits are unreadable. */
export function formatTokens(n: number | null): string {
	if (n === null || !Number.isFinite(n)) return "--";
	const abs = Math.abs(n);
	if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
	return String(n);
}

/** Longest turn in seconds -> "17h 6m". Codex reports turns that run for hours. */
export function formatDuration(seconds: number | null): string {
	if (seconds === null || seconds <= 0) return "--";
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

export function formatPercent(value: number | null): string {
	return value === null || !Number.isFinite(value) ? "--" : `${value.toFixed(1)}%`;
}

function rateClass(usedPercent: number): string {
	if (usedPercent >= 90) return s.rateCritical;
	if (usedPercent >= 70) return s.rateWarn;
	return s.rateOk;
}

/**
 * Flatten the account limit and every per-model limit into one display list.
 *
 * The account windows come first and keep a plain "5h"/"7d" name; per-model
 * windows are prefixed with the model so a cold Spark window can never be read
 * as account headroom.
 */
export function labelWindows(api: CodexUsageApiResponse): LabelledWindow[] {
	const out: LabelledWindow[] = [];
	const push = (prefix: string, key: string, w: CodexRateWindow | null | undefined) => {
		if (!w) return;
		const name = windowLabel(w.limit_window_seconds);
		out.push({ key: `${key}:${name}`, label: prefix ? `${prefix} ${name}` : name, window: w });
	};

	push("", "account", api.rate_limit?.primary_window);
	push("", "account", api.rate_limit?.secondary_window);

	for (const extra of api.additional_rate_limits ?? []) {
		const name = extra.limit_name ?? extra.metered_feature ?? "model";
		push(name, name, extra.rate_limit?.primary_window);
		push(name, name, extra.rate_limit?.secondary_window);
	}
	return out;
}

/** Bar height for one day, relative to the busiest day in the window. */
export function barHeightPercent(tokens: number, peak: number): number {
	if (peak <= 0) return 0;
	return Math.max(2, Math.round((tokens / peak) * 100));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CodexUsageDashboard: Component = () => {
	const [usage, setUsage] = createSignal<CodexUsageApiResponse | null>(null);
	const [stats, setStats] = createSignal<CodexStats | null>(null);
	const [usageError, setUsageError] = createSignal<string | null>(null);
	const [statsError, setStatsError] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(true);

	const refresh = async () => {
		// The backend coalesces both commands into one App Server snapshot. Keep
		// the calls independent so either transport error has an honest section.
		const [usageResult, statsResult] = await Promise.allSettled([
			invoke<CodexUsageApiResponse>("get_codex_usage_api"),
			invoke<CodexStatsResponse>("get_codex_usage_stats"),
		]);

		if (usageResult.status === "fulfilled") {
			setUsage(usageResult.value);
			// A refresh that succeeds must retract the previous failure, else the
			// section keeps showing an error next to fresh numbers.
			setUsageError(null);
		} else {
			const message = String(usageResult.reason);
			setUsageError(message);
			appLogger.warn("network", "Codex usage fetch failed", message);
		}

		if (statsResult.status === "fulfilled") {
			setStats(statsResult.value.stats);
			setStatsError(null);
		} else {
			const message = String(statsResult.reason);
			setStatsError(message);
			appLogger.warn("network", "Codex stats fetch failed", message);
		}
	};

	// Only the first load blanks the dashboard; a periodic refresh swaps the
	// numbers in place.
	onMount(() => {
		void refresh().finally(() => setLoading(false));
	});

	// Auto-refresh every 5 minutes, same cadence as the Claude dashboard and the
	// Rust-side cache behind both endpoints.
	const timer = setInterval(() => void refresh(), 5 * 60 * 1000);
	onCleanup(() => clearInterval(timer));

	const windows = createMemo(() => {
		const api = usage();
		return api ? labelWindows(api) : [];
	});

	const buckets = createMemo(() => stats()?.daily_usage_buckets ?? []);
	const peakBucket = createMemo(() => Math.max(0, ...buckets().map((b) => b.tokens)));

	return (
		<div class={s.dashboard}>
			<div class={s.header}>
				<span class={s.title}>Codex Usage Dashboard</span>
				<Show when={usage()?.plan_type}>{(plan) => <span class={s.sectionHint}>{plan()} plan</span>}</Show>
			</div>

			<Show when={!loading()} fallback={<div class={s.section}>Loading…</div>}>
				{/* Rate limits */}
				<div class={s.section}>
					<div class={s.sectionTitle}>
						<span>Rate Limits</span>
						<Show when={usage()?.rate_limit?.limit_reached}>
							<span class={s.sectionHint}>(limit reached)</span>
						</Show>
					</div>
					<Show
						when={windows().length > 0}
						fallback={<div class={s.rateLimitHint}>{usageError() ?? "No rate limit data."}</div>}
					>
						<div class={s.rateGrid}>
							<For each={windows()}>
								{(item) => (
									<div class={s.rateCard}>
										<div class={s.rateLabel}>
											<span>{item.label}</span>
											<span class={s.rateValue}>{Math.round(item.window.used_percent)}%</span>
										</div>
										<div class={s.rateBar}>
											<div
												class={`${s.rateFill} ${rateClass(item.window.used_percent)}`}
												style={{
													transform: `scaleX(${Math.min(100, item.window.used_percent) / 100})`,
												}}
											/>
										</div>
										<span class={s.rateReset}>
											{formatQuotaWindow({
												provider: "Codex",
												plan: usage()?.plan_type ?? null,
												window_seconds: item.window.limit_window_seconds,
												window_name: item.label,
												used_percent: item.window.used_percent,
												resets_at:
													item.window.reset_at == null ? null : new Date(item.window.reset_at * 1000).toISOString(),
											})}
										</span>
									</div>
								)}
							</For>
						</div>
					</Show>
				</div>

				{/* Daily tokens */}
				<div class={s.section}>
					<div class={s.sectionTitle}>Tokens per Day ({buckets().length} days)</div>
					<Show
						when={buckets().length > 0}
						fallback={<div class={s.rateLimitHint}>{statsError() ?? "No history available."}</div>}
					>
						<div class={s.chartContainer}>
							<div class={s.codexBars}>
								<For each={buckets()}>
									{(bucket) => (
										<div
											class={s.codexBar}
											style={{ height: `${barHeightPercent(bucket.tokens, peakBucket())}%` }}
											title={`${bucket.start_date}: ${formatTokens(bucket.tokens)} tokens`}
										/>
									)}
								</For>
							</div>
						</div>
					</Show>
				</div>

				{/* Lifetime stats */}
				<Show when={stats()}>
					{(st) => (
						<div class={s.section}>
							<div class={s.sectionTitle}>Insights</div>
							<div class={s.insightsGrid}>
								<div class={s.insightCard}>
									<span class={s.insightLabel}>Lifetime tokens</span>
									<span class={s.insightValue}>{formatTokens(st().lifetime_tokens)}</span>
								</div>
								<div class={s.insightCard}>
									<span class={s.insightLabel}>Peak day</span>
									<span class={s.insightValue}>{formatTokens(st().peak_daily_tokens)}</span>
								</div>
								<div class={s.insightCard}>
									<span class={s.insightLabel}>Streak</span>
									<span class={s.insightValue}>{st().current_streak_days ?? "--"}d</span>
									<span class={s.insightSub}>longest {st().longest_streak_days ?? "--"}d</span>
								</div>
								<div class={s.insightCard}>
									<span class={s.insightLabel}>Longest turn</span>
									<span class={s.insightValue}>{formatDuration(st().longest_running_turn_sec)}</span>
								</div>
							</div>
						</div>
					)}
				</Show>
			</Show>
		</div>
	);
};
