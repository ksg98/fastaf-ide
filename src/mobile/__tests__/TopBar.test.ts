// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { TopBar } from "../components/TopBar";

afterEach(cleanup);

describe("TopBar connectivity", () => {
	// Catches: explanatory copy returns beneath the connected mobile header.
	it("omits the explanatory subtitle when connected", () => {
		const view = render(() => TopBar({ isConnected: true }));
		expect(view.getByText("FastAF")).toBeTruthy();
		expect(view.queryByText("Manage your sessions")).toBeNull();
		expect(view.container.querySelector("header")?.textContent).toBe("FastAF");
	});

	// Catches: removing the subtitle also hides the actionable offline state.
	it("keeps the reconnecting status when offline", () => {
		const view = render(() => TopBar({ isConnected: false }));
		expect(view.getByText("Reconnecting…")).toBeTruthy();
		expect(view.getByTitle("Offline")).toBeTruthy();
	});

	it("keeps the connected status dot without narration", () => {
		const view = render(() => TopBar({ isConnected: true }));
		expect(view.getByTitle("Connected")).toBeTruthy();
	});
});
