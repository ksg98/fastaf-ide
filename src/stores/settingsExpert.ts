import { createSignal } from "solid-js";
import { invoke } from "../invoke";
import { appLogger } from "./appLogger";
import { uiStore } from "./ui";

/** Response of `get_config_defaults`: each config domain's Rust `Default`, in
 * its serialized (snake_case) shape. `dictation` is absent outside desktop. */
export interface ConfigDefaults {
	app: Record<string, unknown>;
	notifications: Record<string, unknown>;
	agent_settings: Record<string, unknown>;
	repo_defaults: Record<string, unknown>;
	agents: Record<string, unknown>;
	dictation?: Record<string, unknown>;
	launch_instructions?: LaunchInstructionsDefaults;
}

/** The shipped launch-instruction text and the markers the TUIC parser needs. */
export interface LaunchInstructionsDefaults {
	default_text: string;
	required_markers: string[];
	effective_text: Record<string, string>;
}

/**
 * Visibility of Settings "expert" controls.
 *
 * ## configKey convention
 *
 * `<domain>.<field>[.<field>…]` — the domain is a top-level key of
 * `ConfigDefaults` (`app`, `notifications`, `agent_settings`, `repo_defaults`,
 * `agents`, `dictation`), the rest is the serialized snake_case path inside it,
 * exactly as the Rust config file spells it: `app.osc52_clipboard`,
 * `app.services.auth.session_token_duration_secs`, `repo_defaults.after_merge`,
 * `agents.headless_agent`. The value compared against it must use the same
 * serialized shape.
 *
 * A leaf missing from an object that is present has the default `null`: serde
 * omits `None` fields marked `skip_serializing_if = "Option::is_none"`
 * (`notifications.audio_device`, `agents.headless_agent`, several
 * `agent_settings` fields), so their absence is the default, not a typo.
 *
 * Every lookup that cannot answer — defaults still loading, the call failed,
 * the domain is absent on this host, the path does not exist — counts as
 * "not at default", so the control stays visible. Hiding a user's override
 * because of a race or a typo would be the one unacceptable failure.
 */
function createSettingsExpertStore() {
	const [defaults, setDefaults] = createSignal<ConfigDefaults | null>(null);
	/** configKeys a search result opened during the current Settings open */
	const [revealed, setRevealed] = createSignal<ReadonlySet<string>>(new Set());
	/** configKeys the user edited during the current Settings open */
	const [pinned, setPinned] = createSignal<ReadonlySet<string>>(new Set());
	let loadSeq = 0;
	const warnedKeys = new Set<string>();

	function lookup(configKey: string): { found: boolean; value?: unknown } {
		let node: unknown = defaults();
		const parts = configKey.split(".");
		for (const [index, part] of parts.entries()) {
			if (node === null || typeof node !== "object") return { found: false };
			if (!(part in node)) {
				// A missing leaf under a present domain object is an omitted `None`.
				// A missing domain or intermediate object stays "not found".
				// DEFERRED (2026-09-24) — serde also omits empty strings, `false`
				// and empty maps (`agent_settings.env_flags`); their default is not
				// `null`, so such a control reads as modified and stays visible.
				// Safe (never hides an override) but not exact; exact needs the
				// payload to carry skipped fields, which config.json must not.
				return index === parts.length - 1 && index > 0 ? { found: true, value: null } : { found: false };
			}
			node = (node as Record<string, unknown>)[part];
		}
		return { found: true, value: node };
	}

	/** True only when defaults are known and `value` equals the default. */
	function isAtDefault(configKey: string, value: unknown): boolean {
		const loaded = defaults();
		if (!loaded) return false;
		const { found, value: fallback } = lookup(configKey);
		if (!found) {
			const domain = configKey.split(".")[0];
			// An absent domain is expected (dictation on a non-desktop host); a
			// missing path inside a present domain is a wrong configKey.
			if (domain in loaded && !warnedKeys.has(configKey)) {
				warnedKeys.add(configKey);
				appLogger.warn("config", `Expert setting "${configKey}" has no config default`);
			}
			return false;
		}
		return deepEqual(value, fallback);
	}

	return {
		/** Start a Settings open: forget reveals and refresh the defaults. The
		 * previous defaults stay in use meanwhile — they are compile-time Rust
		 * values, and clearing them would flash every expert control on open. */
		async open(): Promise<void> {
			setRevealed(new Set<string>());
			setPinned(new Set<string>());
			const seq = ++loadSeq;
			try {
				const loaded = await invoke<ConfigDefaults>("get_config_defaults");
				if (seq === loadSeq) setDefaults(loaded);
			} catch (err) {
				appLogger.warn("config", "Failed to load config defaults; expert settings stay visible", err);
			}
		},

		/** Show an expert control for the rest of this Settings open, without
		 * touching the persisted expert-mode pref. */
		reveal(configKey: string): void {
			setRevealed((prev) => new Set(prev).add(configKey));
		},

		/** Keep an expert control visible for the rest of this Settings open
		 * because the user edited it, so editing it back to the default does not
		 * remove it under the cursor. Called on the edit, never on a render: a
		 * tab's pre-load placeholder value is not an edit. */
		pin(configKey: string): void {
			if (!pinned().has(configKey)) setPinned((prev) => new Set(prev).add(configKey));
		},

		isAtDefault,

		/** The shipped launch instructions, or undefined until the defaults load. */
		launchInstructions(): LaunchInstructionsDefaults | undefined {
			return defaults()?.launch_instructions;
		},

		/** The single visibility rule for an expert control. */
		isVisible(configKey: string, value: unknown): boolean {
			return (
				uiStore.state.settingsExpertMode ||
				revealed().has(configKey) ||
				pinned().has(configKey) ||
				!isAtDefault(configKey, value)
			);
		},

		/** Exposed for tests only — do not use in production code. */
		_resetForTests(): void {
			loadSeq++;
			setDefaults(null);
			setRevealed(new Set<string>());
			setPinned(new Set<string>());
			warnedKeys.clear();
		},
	};
}

/** Structural equality for JSON-shaped config values. */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every(
		(key) => key in b && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
	);
}

export const settingsExpertStore = createSettingsExpertStore();
