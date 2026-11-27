import type { SmartPromptResult } from "../../hooks/useSmartPrompts";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import type { SavedPrompt } from "../../stores/promptLibrary";

/** Mirrors `StashFacts` in tuic-git `stash_check.rs`. */
export interface StashFacts {
	stash_ref: string;
	hash: string;
	message: string;
	all_in_head: boolean;
}

/** Mirrors `StashCheckOutcome` in tuic-git `stash_check.rs`. */
interface StashCheckOutcome {
	dropped: boolean;
	reason: string;
	archive_ref: string | null;
	restore: string | null;
}

export interface StashCheckResult {
	stashRef: string;
	verdict: string;
	dropped: boolean;
	/** One line for the user: why it was kept, or that it was dropped and why. */
	summary: string;
	/** For a dropped stash: the ref its commit is kept under, and the command that restores it. */
	archiveRef?: string;
	restore?: string;
}

type Verdict = "redundant" | "obsolete" | "useful" | "unsure";

/** How a kept stash's line starts; the model's reason follows. */
const KEPT: Record<Verdict, string> = {
	useful: "Kept, still useful.",
	unsure: "Kept, not sure.",
	redundant: "Kept.",
	obsolete: "Kept.",
};

function parseVerdict(output: string | undefined): { verdict: Verdict; reason: string } {
	const unsure = { verdict: "unsure" as Verdict, reason: "the prompt returned no usable verdict" };
	const match = output?.match(/\{[\s\S]*\}/);
	if (!match) return unsure;
	try {
		const parsed = JSON.parse(match[0]) as { verdict?: string; reason?: string };
		const verdict = ["redundant", "obsolete", "useful", "unsure"].includes(parsed.verdict ?? "")
			? (parsed.verdict as Verdict)
			: "unsure";
		return { verdict, reason: parsed.reason ?? "" };
	} catch {
		return unsure;
	}
}

/**
 * Check one stash: git computes the facts, the smart prompt classifies, and
 * only the backend decides whether to drop (after archiving the commit).
 * Anything but a proven redundant/obsolete verdict keeps the stash.
 */
export async function checkStash(
	repoPath: string,
	stashRef: string,
	prompt: SavedPrompt,
	run: (prompt: SavedPrompt, vars: Record<string, string>) => Promise<SmartPromptResult>,
): Promise<StashCheckResult> {
	const facts = await invoke<StashFacts>("git_stash_facts", { path: repoPath, stashRef });
	const result = await run(prompt, { stash_facts: JSON.stringify(facts, null, 2) });
	if (!result.ok) {
		return { stashRef, verdict: "unsure", dropped: false, summary: `Kept. ${result.reason ?? "The check failed"}` };
	}
	const { verdict, reason } = parseVerdict(result.output);
	if (verdict !== "redundant" && verdict !== "obsolete") {
		return { stashRef, verdict, dropped: false, summary: `${KEPT[verdict]} ${reason}`.trim() };
	}
	const outcome = await invoke<StashCheckOutcome>("git_stash_check_drop", {
		path: repoPath,
		stashRef,
		hash: facts.hash,
		verdict,
	});
	if (!outcome.dropped) {
		return {
			stashRef,
			verdict,
			dropped: false,
			summary: `Kept. It looks ${verdict}, but git could not prove it: ${outcome.reason}`,
		};
	}
	appLogger.info("git", `Dropped ${stashRef} after check; archived as ${outcome.archive_ref}`);
	return {
		stashRef,
		verdict,
		dropped: true,
		summary: verdict === "redundant" ? "Dropped. HEAD already has its changes." : "Dropped. Newer work replaced it.",
		archiveRef: outcome.archive_ref ?? undefined,
		restore: outcome.restore ?? undefined,
	};
}
