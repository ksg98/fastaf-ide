import type { EgoPermissionMode, EgoSandbox } from "../agents";

/** Permission profile of ego as stored in the agent settings. */
export interface EgoProfile {
	ego_mode?: EgoPermissionMode;
	ego_sandbox?: EgoSandbox;
}

/** One launch argument produced by the profile rather than typed by the user. */
export interface ProfileChip {
	flag: string;
	value: string;
}

export interface ArgConflict {
	/** `duplicate`: raw args disagree with themselves. `overridden`: the profile replaces a raw value. */
	kind: "duplicate" | "overridden";
	flag: string;
	message: string;
}

/**
 * Exclusive ego options. `shorthands` map a value-less flag to the value it
 * stands for, mirroring `ego_permission_args` in `agent_hook_launch.rs`.
 */
const EGO_OPTIONS: ReadonlyArray<{ flag: string; shorthands: Record<string, string> }> = [
	{ flag: "--mode", shorthands: { "--plan": "plan", "--yolo": "yolo" } },
	{ flag: "--sandbox", shorthands: {} },
];

export function egoProfileChips(profile: EgoProfile | undefined): ProfileChip[] {
	const chips: ProfileChip[] = [];
	if (profile?.ego_mode) chips.push({ flag: "--mode", value: profile.ego_mode });
	if (profile?.ego_sandbox) chips.push({ flag: "--sandbox", value: profile.ego_sandbox });
	return chips;
}

/** Split the raw args field the way the launcher receives it: on whitespace. */
export function splitRawArgs(raw: string): string[] {
	const trimmed = raw.trim();
	return trimmed ? trimmed.split(/\s+/) : [];
}

/** Values given to one exclusive option in `args`, in order. Stops at `--`. */
function valuesFor(args: readonly string[], option: (typeof EGO_OPTIONS)[number]): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === option.flag) {
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				values.push(next);
				i++;
			}
		} else if (arg.startsWith(`${option.flag}=`)) {
			values.push(arg.slice(option.flag.length + 1));
		} else if (arg in option.shorthands) {
			values.push(option.shorthands[arg]);
		}
	}
	return values;
}

/**
 * Detect launch-time conflicts in the raw args of an ego run config.
 * Other agents have no known exclusive options, so they never conflict.
 */
export function findArgConflicts(agentType: string, rawArgs: readonly string[], profile?: EgoProfile): ArgConflict[] {
	if (agentType !== "ego") return [];
	const conflicts: ArgConflict[] = [];
	const profileValues = new Map(egoProfileChips(profile).map((c) => [c.flag, c.value]));
	for (const option of EGO_OPTIONS) {
		const distinct = [...new Set(valuesFor(rawArgs, option))];
		if (distinct.length > 1) {
			conflicts.push({
				kind: "duplicate",
				flag: option.flag,
				message: `${option.flag} is given more than once with different values (${distinct.join(", ")})`,
			});
		}
		const fromProfile = profileValues.get(option.flag);
		const replaced = distinct.filter((v) => v !== fromProfile);
		if (fromProfile !== undefined && replaced.length > 0) {
			conflicts.push({
				kind: "overridden",
				flag: option.flag,
				message: `${option.flag} ${replaced.join(", ")} in raw args is replaced by the permissions profile (${fromProfile})`,
			});
		}
	}
	return conflicts;
}

/** Conflicts that must stop a save; `overridden` is only a warning. */
export function hasBlockingConflict(conflicts: readonly ArgConflict[]): boolean {
	return conflicts.some((c) => c.kind === "duplicate");
}
