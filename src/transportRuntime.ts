export interface TransportLogger {
	debug(source: "network", message: string, data?: unknown): void;
	warn(source: "network", message: string, data?: unknown): void;
}

const noopLogger: TransportLogger = {
	debug() {},
	warn() {},
};

let logger: TransportLogger = noopLogger;
let remoteBaseUrlLookup: (connectionId: string) => string | undefined = () => undefined;
let remoteTokenLookup: (connectionId: string) => string | undefined = () => undefined;
let repoConnectionLookup: (path: string) => string | undefined = () => undefined;
let sessionConnectionLookup: (sessionId: string) => string | undefined = () => undefined;

export function setTransportLogger(nextLogger: TransportLogger): void {
	logger = nextLogger;
}

export function setRemoteBaseUrlLookup(lookup: (connectionId: string) => string | undefined): void {
	remoteBaseUrlLookup = lookup;
}

export function setRemoteTokenLookup(lookup: (connectionId: string) => string | undefined): void {
	remoteTokenLookup = lookup;
}

/**
 * Teach the transport which machine owns a repository path.
 *
 * Injected rather than imported: the stores import this module, so this module
 * can import no store. `src/stores/repositories.ts` registers the real lookup.
 */
export function setRepoConnectionLookup(lookup: (path: string) => string | undefined): void {
	repoConnectionLookup = lookup;
}

/** The same for a PTY session id. Registered by `src/stores/terminals.ts`. */
export function setSessionConnectionLookup(lookup: (sessionId: string) => string | undefined): void {
	sessionConnectionLookup = lookup;
}

/** The connection that owns the repository containing `path`, or undefined when local. */
export function getRepoConnection(path: string | null | undefined): string | undefined {
	return path ? repoConnectionLookup(path) : undefined;
}

/** The connection that owns a PTY session, or undefined when the session is local. */
export function getSessionConnection(sessionId: string | null | undefined): string | undefined {
	return sessionId ? sessionConnectionLookup(sessionId) : undefined;
}

export function transportLogger(): TransportLogger {
	return logger;
}

export function getRemoteBaseUrl(connectionId: string): string | undefined {
	return remoteBaseUrlLookup(connectionId);
}

export function getRemoteToken(connectionId: string): string | undefined {
	return remoteTokenLookup(connectionId);
}

/**
 * Append a remote daemon's session token to a URL.
 *
 * Every TCP request to `tuic-remote` is authenticated — the headless build has
 * no loopback bypass, so an SSH tunnel does not make it local. A WebSocket
 * upgrade and an `EventSource` can carry neither an `Authorization` header nor
 * (cross-origin, with `Access-Control-Allow-Origin: *`) a cookie, so `?token=`
 * is the one credential all three transports can carry. Local calls have no
 * connection id and are left untouched.
 */
export function withRemoteToken(url: string, connectionId?: string): string {
	if (!connectionId) return url;
	const token = getRemoteToken(connectionId);
	if (!token) return url;
	return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

/**
 * Argument keys that name a PTY session.
 *
 * `id` is here because `write_pty` accepts it as an alias. A key that holds
 * something else entirely — a plugin id, a tunnel id — costs one map probe that
 * misses, so the loose key is safe.
 */
const SESSION_ARG_KEYS = ["sessionId", "session_id", "id"] as const;

/** Argument keys that name a path inside a repository. */
const PATH_ARG_KEYS = ["repoPath", "repo_path", "path", "cwd", "worktreePath", "base_repo", "project"] as const;

/**
 * Argument keys holding a nested bag, and the keys read inside one.
 *
 * Deliberately narrower than `PATH_ARG_KEYS`: `config` is also the app's whole
 * settings object, and a `path` field added to that someday must not start
 * sending settings saves to another machine. A nested bag is a PTY spawn
 * request, and a spawn names a working directory and a base repo, nothing else.
 */
const NESTED_ARG_KEYS = ["config", "pty_config", "worktree_config"] as const;
const NESTED_PATH_KEYS = ["cwd", "base_repo"] as const;

function firstOwnerIn(
	bags: readonly Record<string, unknown>[],
	keys: readonly string[],
	lookup: (value: string) => string | undefined,
): string | undefined {
	for (const bag of bags) {
		for (const key of keys) {
			const value = bag[key];
			if (typeof value === "string" && value) {
				const owner = lookup(value);
				if (owner) return owner;
			}
		}
	}
	return undefined;
}

/**
 * Which remote machine an RPC call belongs to, read off the call's own arguments.
 *
 * A repository registered against a remote machine has to reach that machine for
 * every operation — not only the handful of call sites that remembered to thread
 * a connection id through. Deciding it here, once, is what makes that mechanical:
 * a command added tomorrow is routed without anyone editing its caller.
 *
 * The session is asked first. A session id is an exact identity, while a path is
 * a prefix match, and a session already knows which backend spawned it.
 */
export function resolveOwningConnection(args: Record<string, unknown>): string | undefined {
	const nested: Record<string, unknown>[] = [];
	for (const key of NESTED_ARG_KEYS) {
		const bag = args[key];
		if (bag && typeof bag === "object") nested.push(bag as Record<string, unknown>);
	}
	const all = [args, ...nested];
	return (
		firstOwnerIn(all, SESSION_ARG_KEYS, sessionConnectionLookup) ??
		firstOwnerIn([args], PATH_ARG_KEYS, repoConnectionLookup) ??
		firstOwnerIn(nested, NESTED_PATH_KEYS, repoConnectionLookup)
	);
}

const LOG_PAYLOAD_PREVIEW = 500;

export function previewLogPayload(value: string): string {
	return value.length > LOG_PAYLOAD_PREVIEW ? `${value.slice(0, LOG_PAYLOAD_PREVIEW)}...` : value;
}
