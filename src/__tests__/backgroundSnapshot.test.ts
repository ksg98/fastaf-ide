import { afterEach, expect, it, vi } from "vitest";
import { persistBackgroundSnapshot } from "../services/backgroundSnapshot";
import { appLogger } from "../stores/appLogger";

afterEach(() => vi.restoreAllMocks());

// Catches: ack sent before the persistence promise settles, allowing hide to lose a snapshot.
it("acknowledges the request only after persistence finishes", async () => {
	let finish: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const acknowledge = vi.fn().mockResolvedValue(undefined);
	const result = persistBackgroundSnapshot("request-1", () => pending, acknowledge);
	await Promise.resolve();
	expect(acknowledge).not.toHaveBeenCalled();
	finish();
	await result;
	expect(acknowledge).toHaveBeenCalledExactlyOnceWith("request-1");
});

// Catches: failed persistence reported as an acknowledged snapshot.
it("logs a failed snapshot without acknowledging it", async () => {
	const log = vi.spyOn(appLogger, "error").mockImplementation(() => {});
	const acknowledge = vi.fn();
	await persistBackgroundSnapshot("request-2", () => Promise.reject("disk full"), acknowledge);
	expect(acknowledge).not.toHaveBeenCalled();
	expect(log).toHaveBeenCalledWith("app", "Background snapshot failed", "disk full");
});
