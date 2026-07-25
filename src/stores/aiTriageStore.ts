import { createStore } from "solid-js/store";
import { invoke, listen } from "../invoke";

// ---------------------------------------------------------------------------
// Types — mirror Rust diff_triage.rs
// ---------------------------------------------------------------------------

export type Relevance = "high" | "medium" | "low";
export type Category = "business-logic" | "api-surface" | "schema" | "config" | "test" | "boilerplate" | "style";
export type Risk = "breaking-change" | "behavioral-change" | "cosmetic";
export type ClassificationSource = "heuristic" | "llm";
export type Severity = "bug" | "risk" | "nit";

export interface Finding {
	path: string;
	line: number | null;
	hunk: string | null;
	severity: Severity;
	message: string;
	confidence: number;
}

export interface FileClassification {
	path: string;
	relevance: Relevance;
	category: Category;
	risk: Risk;
	summary: string;
	findings?: Finding[];
	source: ClassificationSource;
	additions: number;
	deletions: number;
}

export interface TriageResult {
	summary: string | null;
	files: FileClassification[];
	llm_used: boolean;
	llm_model: string | null;
}

interface TriageProgress {
	repo_path: string;
	summary: string | null;
	files: FileClassification[];
	phase: string;
	done: boolean;
	llm_used: boolean;
	llm_model: string | null;
}

// ---------------------------------------------------------------------------
// Per-repo triage state
// ---------------------------------------------------------------------------

export interface TriageStats {
	llmClassified: number;
	cached: number;
	heuristic: number;
	fallback: number;
}

const DEFAULT_STATS: TriageStats = { llmClassified: 0, cached: 0, heuristic: 0, fallback: 0 };

interface TriageState {
	summary: string | null;
	files: FileClassification[];
	loading: boolean;
	llmUsed: boolean;
	llmModel: string | null;
	error: string | null;
	stats: TriageStats;
}

const DEFAULT_STATE: TriageState = {
	summary: null,
	files: [],
	loading: false,
	llmUsed: false,
	llmModel: null,
	error: null,
	stats: DEFAULT_STATS,
};

interface AiTriageStoreState {
	repos: Record<string, TriageState>;
}

const DEBOUNCE_MS = 2000;

function createAiTriageStore() {
	const [state, setState] = createStore<AiTriageStoreState>({ repos: {} });
	const pending = new Map<string, ReturnType<typeof setTimeout>>();
	const inflight = new Set<string>();

	// Coalesce progressive triage-progress events. On a large dirty tree the
	// backend streams one event per file; applying each straight to the store
	// re-renders the (unvirtualized) file list every time — a burst big enough
	// to thrash the main thread into a hard UI freeze (investigated 2026-07-10:
	// AI Triage open on tuicommander's ~100-file working tree while it was being
	// mutated). We accumulate onto a per-repo snapshot and flush to the store at
	// most every PROGRESS_FLUSH_MS, always immediately on `done`. During the
	// stream files keep arrival order; we sort only on the final flush (the
	// authoritative run_diff_triage result sorts too).
	const PROGRESS_FLUSH_MS = 200;
	const progressSnap = new Map<string, TriageState>();
	const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

	function flushProgress(repo: string): void {
		const t = flushTimers.get(repo);
		if (t) {
			clearTimeout(t);
			flushTimers.delete(repo);
		}
		const snap = progressSnap.get(repo);
		if (snap) setState("repos", repo, snap);
	}

	/** Drop any buffered progress for a repo — called when a fresh run starts so
	 *  a new pass never merges onto the previous run's accumulated files. */
	function resetProgress(repo: string): void {
		progressSnap.delete(repo);
		const t = flushTimers.get(repo);
		if (t) {
			clearTimeout(t);
			flushTimers.delete(repo);
		}
	}

	// Listen for progressive triage events from Rust
	listen<TriageProgress>("triage-progress", (event) => {
		const p = event.payload;
		const repo = p.repo_path;
		// Accumulate onto the in-progress snapshot (fall back to the store), and
		// only sort on the terminal event — no per-event O(n log n) re-sort.
		const prev = progressSnap.get(repo) ?? state.repos[repo] ?? DEFAULT_STATE;
		const existingByPath = new Map(prev.files.map((f) => [f.path, f]));
		for (const f of p.files) existingByPath.set(f.path, f);
		const merged = [...existingByPath.values()];
		if (p.done) merged.sort((a, b) => relevanceOrder(a.relevance) - relevanceOrder(b.relevance));

		const count = p.files.length;
		const stats = { ...prev.stats };
		if (p.phase === "llm-file") stats.llmClassified += count;
		else if (p.phase === "cached") stats.cached += count;
		else if (p.phase === "heuristic") stats.heuristic += count;
		else if (p.phase === "fallback") stats.fallback += count;

		progressSnap.set(repo, {
			summary: p.summary ?? prev.summary,
			files: merged,
			loading: !p.done,
			llmUsed: p.llm_used || prev.llmUsed,
			llmModel: p.llm_model ?? prev.llmModel,
			error: null,
			stats,
		});

		if (p.done) {
			flushProgress(repo);
			progressSnap.delete(repo);
		} else if (!flushTimers.has(repo)) {
			flushTimers.set(
				repo,
				setTimeout(() => flushProgress(repo), PROGRESS_FLUSH_MS),
			);
		}
	});

	function relevanceOrder(r: Relevance): number {
		if (r === "high") return 0;
		if (r === "medium") return 1;
		return 2;
	}

	function getState(repoPath: string): TriageState {
		return state.repos[repoPath] ?? DEFAULT_STATE;
	}

	function runTriage(repoPath: string): void {
		if (pending.has(repoPath)) clearTimeout(pending.get(repoPath));
		pending.set(
			repoPath,
			setTimeout(() => {
				pending.delete(repoPath);
				void executeTriage(repoPath);
			}, DEBOUNCE_MS),
		);
	}

	async function executeTriage(repoPath: string, refresh?: boolean): Promise<void> {
		if (inflight.has(repoPath)) return;
		inflight.add(repoPath);
		resetProgress(repoPath);
		const prev = getState(repoPath);
		setState("repos", repoPath, {
			...prev,
			loading: true,
			error: null,
		});
		try {
			const result = await invoke<TriageResult>("run_diff_triage", {
				repoPath,
				refresh: refresh || undefined,
			});
			// Final result — authoritative, replaces progressive state (keep accumulated stats)
			result.files.sort((a, b) => relevanceOrder(a.relevance) - relevanceOrder(b.relevance));
			setState("repos", repoPath, {
				summary: result.summary,
				files: result.files,
				loading: false,
				llmUsed: result.llm_used,
				llmModel: result.llm_model,
				error: null,
				stats: getState(repoPath).stats,
			});
		} catch (err) {
			setState("repos", repoPath, {
				...getState(repoPath),
				loading: false,
				error: String(err),
			});
		} finally {
			inflight.delete(repoPath);
		}
	}

	function clear(repoPath: string): void {
		if (pending.has(repoPath)) {
			clearTimeout(pending.get(repoPath));
			pending.delete(repoPath);
		}
		resetProgress(repoPath);
		setState("repos", repoPath, undefined!);
	}

	function refreshTriage(repoPath: string): void {
		if (pending.has(repoPath)) {
			clearTimeout(pending.get(repoPath));
			pending.delete(repoPath);
		}
		setState("repos", repoPath, { ...DEFAULT_STATE, stats: { ...DEFAULT_STATS }, loading: true });
		void executeTriage(repoPath, true);
	}

	return { state, getState, runTriage, refreshTriage, clear };
}

export const aiTriageStore = createAiTriageStore();
