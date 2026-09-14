/**
 * Shallow camelCase <-> snake_case key conversion for config payloads.
 *
 * Every config surface in this app is camelCase in the store and snake_case on
 * the wire, because that is what the Rust structs deserialize. Stores that spell
 * the mapping out by hand (`settings.ts`, `repoDefaults.ts`) pay for it with a
 * line per field, and a field added on one side and forgotten on the other is
 * dropped in silence: serde ignores an unknown key, so a mismatched name reads
 * as "the user set nothing".
 *
 * SHALLOW ON PURPOSE. Only the top-level keys are renamed. A value that is
 * itself an object is passed through untouched, because the ones we carry are
 * maps keyed by user data — `branch_labels` is keyed by branch name, and a
 * branch called `my_feature` must not come back as `myFeature`.
 */

type Dict = Record<string, unknown>;

/** `promptOnCreate` -> `prompt_on_create` */
export function snakeKey(key: string): string {
	return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** `prompt_on_create` -> `promptOnCreate` */
export function camelKey(key: string): string {
	return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function mapKeys(obj: object, fn: (key: string) => string): Dict {
	const out: Dict = {};
	for (const [key, value] of Object.entries(obj)) out[fn(key)] = value;
	return out;
}

/** Store shape -> wire shape. */
export function toSnakeKeys(obj: object): Dict {
	return mapKeys(obj, snakeKey);
}

/** Wire shape -> store shape. */
export function toCamelKeys(obj: object): Dict {
	return mapKeys(obj, camelKey);
}
