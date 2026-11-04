import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke, error } = vi.hoisted(() => ({ invoke: vi.fn(), error: vi.fn() }));
vi.mock("../../invoke", () => ({ invoke }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { error, debug: vi.fn() } }));

const item = (id: string) => ({ id, pluginId: "core", sectionId: "messages", title: id, icon: "", dismissible: true });

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("activity startup persistence", () => {
	// Catches: mutations racing the first load being logged and silently discarded.
	it("retains pre-load activity without logging a refused save", async () => {
		vi.resetModules();
		vi.useFakeTimers();
		const { activityStore: store } = await import("../../stores/activityStore");
		let finishLoad!: (items: unknown[]) => void;
		invoke.mockImplementation((command) =>
			command === "load_activity"
				? new Promise((resolve) => {
						finishLoad = resolve;
					})
				: Promise.resolve(),
		);
		const hydration = store.hydrate();
		store.addItem(item("live"));
		await vi.advanceTimersByTimeAsync(300);
		expect(error).not.toHaveBeenCalled();
		expect(invoke.mock.calls.filter(([command]) => command === "save_activity")).toHaveLength(0);
		store.updateItem("live", { title: "latest" });
		await vi.advanceTimersByTimeAsync(300);
		finishLoad([{ ...item("saved"), createdAt: 1 }]);
		await hydration;
		await vi.advanceTimersByTimeAsync(300);
		const saves = invoke.mock.calls.filter(([command]) => command === "save_activity");
		expect(saves).toHaveLength(1);
		expect(saves[0][1].items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "saved" }),
				expect.objectContaining({ id: "live", title: "latest" }),
			]),
		);
		store._testCancelPendingSave();
	});
	// Catches: a failed first load dropping queued notices or overwriting unreadable disk state.
	it("keeps pending changes through a failed load and saves on a successful retry", async () => {
		vi.resetModules();
		vi.useFakeTimers();
		const { activityStore: store } = await import("../../stores/activityStore");
		invoke.mockRejectedValueOnce(new Error("offline"));
		store.addItem(item("pending"));
		await vi.advanceTimersByTimeAsync(300);
		await store.hydrate();
		expect(invoke.mock.calls.filter(([command]) => command === "save_activity")).toHaveLength(0);
		invoke.mockResolvedValueOnce(null).mockResolvedValue(undefined);
		await store.hydrate();
		await Promise.resolve();
		const saves = invoke.mock.calls.filter(([command]) => command === "save_activity");
		expect(saves).toHaveLength(1);
		expect(saves[0][1]).toEqual({ base: [], items: [expect.objectContaining({ id: "pending" })] });
		expect(error).not.toHaveBeenCalled();
		store._testCancelPendingSave();
	});

	// Catches: fast hydration causing the queued timer to save an unmerged or stale item list.
	it("uses the hydrated baseline when load finishes before the debounce", async () => {
		vi.resetModules();
		vi.useFakeTimers();
		const { activityStore: store } = await import("../../stores/activityStore");
		const saved = { ...item("saved"), createdAt: 1 };
		invoke.mockResolvedValueOnce([saved]).mockResolvedValue(undefined);
		store.addItem(item("live"));
		await store.hydrate();
		await vi.advanceTimersByTimeAsync(300);
		const saves = invoke.mock.calls.filter(([command]) => command === "save_activity");
		expect(saves).toHaveLength(1);
		expect(saves[0][1].base).toEqual([saved]);
		expect(saves[0][1].items).toHaveLength(2);
		expect(error).not.toHaveBeenCalled();
		store._testCancelPendingSave();
	});
});
