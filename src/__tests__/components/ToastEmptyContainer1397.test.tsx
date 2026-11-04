import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { ToastContainer } from "../../components/ToastContainer/ToastContainer";
import { toastsStore } from "../../stores/toasts";

describe("empty toast container 1397", () => {
	afterEach(cleanup);

	it("renders no click-capturing box while there are no toasts", () => {
		// catches: pointer-events:auto + padding on an always-mounted container blocks a 16px corner of the terminal when idle
		for (const t of [...toastsStore.toasts]) toastsStore.remove(t.id);
		const { container } = render(() => <ToastContainer />);
		expect(container.children).toHaveLength(0);
	});
});
