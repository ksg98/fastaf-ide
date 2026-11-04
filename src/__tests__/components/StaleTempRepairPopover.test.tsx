import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #763-d219 — the popover is the discoverable repair entry point: it must
// name exactly the backend-classified candidates (never "every repo"), send
// exactly their paths on repair, and surface a failed repair visibly rather
// than silently doing nothing.

const mockInvoke = vi.fn().mockResolvedValue(undefined);

describe("StaleTempRepairPopover", () => {
	let repositoriesStore: typeof import("../../stores/repositories").repositoriesStore;
	let StaleTempRepairPopover: typeof import("../../components/Sidebar/StaleTempRepairPopover").StaleTempRepairPopover;

	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);

		vi.doMock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

		repositoriesStore = (await import("../../stores/repositories")).repositoriesStore;
		StaleTempRepairPopover = (await import("../../components/Sidebar/StaleTempRepairPopover")).StaleTempRepairPopover;
		repositoriesStore._testSetHydrated(true);
	});

	afterEach(() => {
		// `repositoriesStore.add()` schedules a debounced (500ms real-timer)
		// save; nothing in this file waits it out, so it must be cancelled or
		// it leaks past the test into vitest's async-leak detector.
		repositoriesStore._testCancelPendingSave();
		vi.restoreAllMocks();
	});

	async function seedCandidates(candidates: Array<{ path: string; displayName: string }>) {
		mockInvoke.mockImplementationOnce((cmd: string) => {
			if (cmd === "list_stale_temp_repository_candidates") return Promise.resolve(candidates);
			return Promise.resolve(undefined);
		});
		await repositoriesStore.refreshStaleTempCandidates();
	}

	it("lists only the backend-classified candidates by display name, not every repo", async () => {
		repositoriesStore.add({ path: "/legit-repo", displayName: "Legit Repo" });
		await seedCandidates([{ path: "/tmp/ghost-1", displayName: "ghost-1" }]);

		render(() => <StaleTempRepairPopover onClose={vi.fn()} />);

		expect(screen.getByText("ghost-1")).toBeTruthy();
		expect(screen.queryByText("Legit Repo")).toBeNull();
	});

	it("sends exactly the listed candidates' paths when repairing, nothing more", async () => {
		await seedCandidates([
			{ path: "/tmp/ghost-1", displayName: "ghost-1" },
			{ path: "/tmp/ghost-2", displayName: "ghost-2" },
		]);

		mockInvoke.mockImplementationOnce((cmd: string, args: unknown) => {
			if (cmd === "repair_stale_temp_repositories") {
				expect(args).toEqual({ paths: ["/tmp/ghost-1", "/tmp/ghost-2"] });
				return Promise.resolve({ removed: ["/tmp/ghost-1", "/tmp/ghost-2"], backupPath: "/x/backup.json" });
			}
			return Promise.resolve(undefined);
		});

		render(() => <StaleTempRepairPopover onClose={vi.fn()} />);
		fireEvent.click(screen.getByText("Repair 2 stale repositories"));

		await screen.findByText("No stale repositories found");
	});

	it("closes once every candidate has been repaired", async () => {
		await seedCandidates([{ path: "/tmp/ghost-1", displayName: "ghost-1" }]);
		mockInvoke.mockImplementationOnce((cmd: string) => {
			if (cmd === "repair_stale_temp_repositories") {
				return Promise.resolve({ removed: ["/tmp/ghost-1"], backupPath: "/x/backup.json" });
			}
			return Promise.resolve(undefined);
		});
		const onClose = vi.fn();

		render(() => <StaleTempRepairPopover onClose={onClose} />);
		fireEvent.click(screen.getByText("Repair 1 stale repository"));

		await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("shows a visible error and keeps the candidate when the backend refuses the repair", async () => {
		await seedCandidates([{ path: "/tmp/ghost-1", displayName: "ghost-1" }]);
		mockInvoke.mockImplementationOnce((cmd: string) => {
			if (cmd === "repair_stale_temp_repositories") {
				return Promise.reject(new Error("no longer a stale-temp candidate on disk"));
			}
			return Promise.resolve(undefined);
		});
		// The failure path re-fetches the preview to resync with disk.
		mockInvoke.mockImplementationOnce((cmd: string) => {
			if (cmd === "list_stale_temp_repository_candidates") {
				return Promise.resolve([{ path: "/tmp/ghost-1", displayName: "ghost-1" }]);
			}
			return Promise.resolve(undefined);
		});
		// `beforeEach` resets the module registry, so spy on the same appLogger
		// instance that the freshly imported component uses.
		const { appLogger } = await import("../../stores/appLogger");
		const loggerSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});

		render(() => <StaleTempRepairPopover onClose={vi.fn()} />);
		fireEvent.click(screen.getByText("Repair 1 stale repository"));

		expect(await screen.findByText(/Repair failed/)).toBeTruthy();
		expect(screen.getByText("ghost-1")).toBeTruthy();
		expect(loggerSpy).toHaveBeenCalledWith("store", "Stale-temp repository repair failed", expect.any(Error));
	});

	it("shows an empty state when there are no candidates", async () => {
		render(() => <StaleTempRepairPopover onClose={vi.fn()} />);
		expect(screen.getByText("No stale repositories found")).toBeTruthy();
	});
});
