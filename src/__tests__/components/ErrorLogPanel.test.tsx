import { render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorLogPanel } from "../../components/ErrorLogPanel/ErrorLogPanel";
import { appLogger } from "../../stores/appLogger";
import { errorLogStore } from "../../stores/errorLog";

/**
 * The panel is mounted for the whole app lifetime — App renders it
 * unconditionally and the `Show` inside gates only the JSX. Solid memos are
 * eager: they re-run whenever a dependency changes, whether or not anything
 * reads them. So a panel nobody has opened was still re-filtering the entire
 * log ring on every single log line, forever.
 *
 * The observable is `appLogger.getEntries` — the memos' one expensive call.
 */
describe("ErrorLogPanel memo gating", () => {
	beforeEach(() => {
		errorLogStore.close();
		appLogger.clear();
		vi.restoreAllMocks();
	});

	it("does not filter the log ring while the panel is closed", () => {
		const view = render(() => <ErrorLogPanel />);
		const getEntries = vi.spyOn(appLogger, "getEntries");

		for (let i = 0; i < 10; i++) appLogger.error("app", `boom ${i}`);

		expect(getEntries).not.toHaveBeenCalled();
		view.unmount();
	});

	/**
	 * The contrast that proves the test above is not vacuous: once opened, the
	 * same entries must be filtered and rendered.
	 */
	it("filters the log ring once the panel is opened", () => {
		const view = render(() => <ErrorLogPanel />);
		const { container } = view;
		appLogger.error("app", "visible failure");

		const getEntries = vi.spyOn(appLogger, "getEntries");
		errorLogStore.open();

		expect(getEntries).toHaveBeenCalled();
		expect(container.textContent).toContain("visible failure");
		view.unmount();
	});

	it("stops filtering again after the panel is closed", () => {
		const view = render(() => <ErrorLogPanel />);
		errorLogStore.open();
		errorLogStore.close();

		const getEntries = vi.spyOn(appLogger, "getEntries");
		for (let i = 0; i < 5; i++) appLogger.warn("app", `later ${i}`);

		expect(getEntries).not.toHaveBeenCalled();
		view.unmount();
	});

	it("cancels focus and auto-scroll frames when the panel closes", () => {
		const pending = new Set<number>();
		let nextFrame = 1;
		const request = vi.fn((_callback: FrameRequestCallback) => {
			const id = nextFrame++;
			pending.add(id);
			return id;
		});
		const cancel = vi.fn((id: number) => {
			pending.delete(id);
		});
		vi.stubGlobal("requestAnimationFrame", request);
		vi.stubGlobal("cancelAnimationFrame", cancel);

		const view = render(() => <ErrorLogPanel />);
		errorLogStore.open();
		expect(request).toHaveBeenCalledTimes(2);

		errorLogStore.close();
		expect(cancel).toHaveBeenCalledTimes(2);
		expect(pending.size).toBe(0);

		view.unmount();
		vi.unstubAllGlobals();
	});
});
