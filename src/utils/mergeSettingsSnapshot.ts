/** Three-way adoption for UI snapshots. Arrays are atomic owner values, not index edits. */
export function mergeSettingsSnapshot<T>(
	base: T,
	local: T,
	remote: T,
	conflict: "local" | "remote" = "local",
): { value: T; conflicts: string[] } {
	const conflicts: string[] = [];
	const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const object = (value: unknown): value is Record<string, unknown> =>
		value !== null && typeof value === "object" && !Array.isArray(value);
	function merge(before: unknown, current: unknown, incoming: unknown, path: string): unknown {
		if (equal(current, before)) return incoming;
		if (equal(current, incoming) || equal(incoming, before)) return current;
		if (object(before) && object(current) && object(incoming)) {
			const result: Record<string, unknown> = {};
			for (const key of new Set([...Object.keys(before), ...Object.keys(current), ...Object.keys(incoming)])) {
				const value = merge(
					before[key],
					current[key],
					incoming[key],
					`${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
				);
				if (value !== undefined) result[key] = value;
			}
			return result;
		}
		conflicts.push(path || "/");
		return conflict === "remote" ? incoming : current;
	}
	return { value: merge(base, local, remote, "") as T, conflicts };
}
