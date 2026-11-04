import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoBadge } from "../../../components/SettingsPanel/InfoBadge";

// Catches: CSS hover exposes an unmeasured fixed tooltip after a mount.
describe("InfoBadge measured visibility", () => {
	afterEach(() => vi.restoreAllMocks());

	it("hides until entry placement and supports keyboard focus without a mouse", () => {
		const view = render(() => <InfoBadge>Help</InfoBadge>);
		const tip = view.getByText("Help");
		const badge = tip.parentElement!;
		expect(tip.dataset.visible).toBeUndefined();
		expect(badge.tabIndex).toBe(0);
		expect(badge.getAttribute("aria-describedby")).toBe(tip.id);
		fireEvent.focus(badge);
		expect(tip.style.left).not.toBe("");
		expect(tip.style.top).not.toBe("");
		expect(tip.dataset.visible).toBe("true");
		fireEvent.blur(badge);
		expect(tip.dataset.visible).toBeUndefined();
		view.unmount();
	});

	// Catches: fixed coordinates remain stale when the containing panel scrolls.
	it("repositions at viewport edges on scroll and resize and retains focused help after mouse leave", () => {
		const view = render(() => <InfoBadge>Help</InfoBadge>);
		const tip = view.getByText("Help");
		const badge = tip.parentElement!;
		const rectangle = vi.spyOn(badge, "getBoundingClientRect");
		rectangle.mockReturnValue({
			left: window.innerWidth - 16,
			top: window.innerHeight - 30,
			bottom: window.innerHeight - 14,
		} as DOMRect);
		vi.spyOn(tip, "getBoundingClientRect").mockReturnValue({ width: 320, height: 200 } as DOMRect);
		fireEvent.mouseEnter(badge);
		expect(tip.style.left).toBe(`${window.innerWidth - 328}px`);
		expect(tip.style.top).toBe(`${window.innerHeight - 236}px`);
		fireEvent.focus(badge);
		fireEvent.mouseLeave(badge);
		expect(tip.dataset.visible).toBe("true");
		rectangle.mockReturnValue({ left: -10, top: 30, bottom: 46 } as DOMRect);
		fireEvent.scroll(document);
		expect(tip.style.left).toBe("8px");
		expect(tip.style.top).toBe("52px");
		rectangle.mockReturnValue({ left: 40, top: 60, bottom: 76 } as DOMRect);
		fireEvent.resize(window);
		expect(tip.style.left).toBe("40px");
		expect(tip.style.top).toBe("82px");
		view.unmount();
	});
});
