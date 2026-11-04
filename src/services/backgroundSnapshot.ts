import { appLogger } from "../stores/appLogger";

/** Acknowledge only after the terminal snapshot has reached persistent storage. */
export async function persistBackgroundSnapshot(
	requestId: string,
	persist: () => Promise<void>,
	acknowledge: (requestId: string) => Promise<unknown>,
): Promise<void> {
	try {
		await persist();
		await acknowledge(requestId);
	} catch (error) {
		appLogger.error("app", "Background snapshot failed", error);
	}
}
