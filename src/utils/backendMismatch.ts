const PREFIX = "Backend/frontend version mismatch";

/** A missing local dev command cannot be repaired by retrying the same binary. */
export function backendMismatchMessage(command: string): string {
	return `${PREFIX}: the running backend does not have ${command}. Restart make dev (or pnpm tauri dev) when you are ready to end the current backend session. Reloading the frontend or retrying will not update the backend.`;
}

export function isBackendVersionMismatch(message: string | null): boolean {
	return import.meta.env.DEV && !!message?.startsWith(`${PREFIX}:`);
}
