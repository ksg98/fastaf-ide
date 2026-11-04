import { invoke } from "../invoke";
import { mergeSettingsSnapshot } from "./mergeSettingsSnapshot";

/** Retain each loaded snapshot so writes carry only this client's changes. */
export function createConfigDeltaWriter<T>(
	command: string,
	field: "config" | "layout" | "items" = "config",
	saveSnapshot: (base: T, desired: T) => Promise<void> = (base, desired) => invoke(command, { base, [field]: desired }),
) {
	let base: T | undefined;
	let tail: Promise<void> | null = null;
	let epoch = 0;
	let lastDesired: T | undefined;
	const snapshot = (value: T): T => JSON.parse(JSON.stringify(value)) as T;
	return {
		loaded(value: T): void {
			base = snapshot(value);
		},
		adopt(remote: T, local: T): { value: T; conflicts: string[] } {
			const merged = mergeSettingsSnapshot(base ?? remote, local, remote);
			epoch++; // In-flight acknowledgements must not reset the adopted base.
			base = snapshot(remote);
			return merged;
		},
		save(value: T): Promise<void> {
			const desired = snapshot(value);
			const queuedEpoch = epoch;
			const intentBase = snapshot(tail && lastDesired !== undefined ? lastDesired : (base ?? value));
			lastDesired = desired;
			const write = async () => {
				if (base === undefined) throw new Error(`${command} refused before config load`);
				const rebased =
					queuedEpoch === epoch ? desired : mergeSettingsSnapshot(intentBase, desired, base, "remote").value;
				if (queuedEpoch !== epoch && JSON.stringify(rebased) === JSON.stringify(base)) return;
				const dispatchEpoch = epoch;
				await saveSnapshot(base, rebased);
				if (dispatchEpoch === epoch) base = rebased;
			};
			const operation = tail ? tail.then(write) : write();
			const settled = operation.then(
				() => undefined,
				() => undefined,
			);
			tail = settled;
			void settled.then(() => {
				if (tail === settled) {
					tail = null;
					lastDesired = undefined;
				}
			});
			return operation;
		},
	};
}
