import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { CountBadge } from "../../components/ui/CountBadge";

/**
 * One counter for every icon button (status bar toggles, sidebar footer). The
 * two used to be separate implementations with different size, radius, offset
 * and inline colors, so the same idea looked different a few pixels apart.
 */
describe("CountBadge", () => {
	it("renders the count with the tone as a class, never an inline color", () => {
		const badge = render(() => <CountBadge count={12} tone="error" />).container.querySelector(
			".countBadge",
		) as HTMLElement;
		expect(badge.textContent).toBe("12");
		expect(badge.classList.contains("error")).toBe(true);
		expect(badge.getAttribute("style")).toBeNull();
	});

	it("defaults to the accent tone", () => {
		const badge = render(() => <CountBadge count={4} />).container.querySelector(".countBadge") as HTMLElement;
		expect(badge.classList.contains("accent")).toBe(true);
	});

	it("renders nothing for a zero count", () => {
		const { container } = render(() => <CountBadge count={0} />);
		expect(container.querySelector(".countBadge")).toBeNull();
	});
});
