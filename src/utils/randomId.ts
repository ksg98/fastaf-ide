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

/**
 * A random UUID, in a form `uuid::Uuid` will parse.
 *
 * `randomId` above is deliberately not a UUID, which makes it the wrong thing
 * to send to a backend field typed as one: the request would be refused at
 * deserialization, in a non-secure context only, which is exactly where nobody
 * tests. The fallback keeps the version-4 shape for that reason and not because
 * anything reads the version bits.
 */
export function randomUuid(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return uuid;
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
		const value = Math.floor(Math.random() * 16);
		return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
	});
}
