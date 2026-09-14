/**
 * A random client-side id that survives a non-secure context.
 *
 * `crypto.randomUUID` is only defined in a secure context. TUIC is reached over
 * https tunnels but also over plain http on a LAN address, so a bare call
 * throws for exactly the remote clients that need the id most. The fallback is
 * not a UUID and does not need to be: these ids only have to be distinct among
 * the live clients of one backend, never globally.
 *
 * `prefix` keeps ids readable in logs. It must not contain `/` — the backend
 * qualifies watcher ids with that separator.
 */
export function randomId(prefix: string): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	return `${prefix}${uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`;
}
