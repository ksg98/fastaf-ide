import { createStore } from "solid-js/store";
import { invoke } from "../invoke";
import { appLogger } from "./appLogger";

// ---------------------------------------------------------------------------
// Types (mirror Rust AiPromptsConfig — snake_case)
// ---------------------------------------------------------------------------

interface AiPromptsConfig {
	diff_triage_system_prompt: string | null;
}

interface AiPromptsState {
	config: AiPromptsConfig;
	loaded: boolean;
}

// ---------------------------------------------------------------------------
// Default prompts — keep in sync with Rust constants
// ---------------------------------------------------------------------------

export const DEFAULT_DIFF_TRIAGE_PROMPT = `You are a senior code reviewer triaging a changeset. \
I'll show the file list first, then each file's diff one at a time. \
Keep context across turns — relate files to each other.

RESPONSES — always a single JSON line, nothing else:

When I show the file list:
{"summary": "2-3 sentence changeset overview"}

When I show a file diff:
{"path": "...", "summary": "one sentence", "findings": [\
{"path": "...", "line": 123, "hunk": "optional hunk/context", \
"severity": "bug|risk|nit", "message": "actionable review finding", \
"confidence": 0.0}]}

Rules: findings are line-level and actionable. \
Use severity=bug for likely defects, risk for plausible regressions, nit for minor cleanup. \
Use confidence 0.0-1.0; omit low-confidence speculation by using confidence below 0.7. \
If no actionable finding exists, return an empty findings array. \
Relate files to each other. ONLY output the JSON line.`;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createAiPromptsStore() {
	const [state, setState] = createStore<AiPromptsState>({
		config: { diff_triage_system_prompt: null },
		loaded: false,
	});

	async function hydrate(): Promise<void> {
		if (state.loaded) return;
		try {
			const config = await invoke<AiPromptsConfig>("load_ai_prompts");
			setState({ config, loaded: true });
		} catch (e) {
			appLogger.warn("config", `Failed to load AI prompts: ${e}`);
			setState("loaded", true);
		}
	}

	async function save(): Promise<void> {
		try {
			await invoke("save_ai_prompts", { config: state.config });
		} catch (e) {
			appLogger.error("config", `Failed to save AI prompts: ${e}`);
		}
	}

	function setDiffTriagePrompt(text: string | null): void {
		const value = text?.trim() ? text : null;
		setState("config", "diff_triage_system_prompt", value);
		void save();
	}

	type AiService = "diff_triage";

	function getEffectivePrompt(service: AiService): string {
		if (service === "diff_triage") {
			return state.config.diff_triage_system_prompt ?? DEFAULT_DIFF_TRIAGE_PROMPT;
		}
		return "";
	}

	function isCustom(service: AiService): boolean {
		if (service === "diff_triage") {
			return state.config.diff_triage_system_prompt != null;
		}
		return false;
	}

	function resetToDefault(service: AiService): void {
		if (service === "diff_triage") {
			setDiffTriagePrompt(null);
		}
	}

	return {
		get state() {
			return state;
		},
		hydrate,
		getEffectivePrompt,
		isCustom,
		setDiffTriagePrompt,
		resetToDefault,
	};
}

export const aiPromptsStore = createAiPromptsStore();
