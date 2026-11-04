/** Origin stamped by the local backend, never accepted from another mirror hop. */
export interface RemoteEventOrigin {
	connection: string;
	name: string;
}

export interface RemoteEventPayload {
	__tuic_origin?: unknown;
}

/** A malformed stamp must not turn a remote notice into a local action. */
export function remoteEventOrigin(payload: RemoteEventPayload): RemoteEventOrigin | undefined {
	const value = payload.__tuic_origin;
	if (!value || typeof value !== "object" || !("connection" in value)) return undefined;
	if (typeof value.connection !== "string" || !value.connection) return undefined;
	return {
		connection: value.connection,
		name: "name" in value && typeof value.name === "string" ? value.name : value.connection,
	};
}
