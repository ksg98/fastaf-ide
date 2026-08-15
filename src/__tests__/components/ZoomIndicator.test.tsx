import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { ZoomIndicator } from "../../components/ui/ZoomIndicator";

describe("ZoomIndicator", () => {
	const percent = (level: number): string | null | undefined => {
		const { container } = render(() => <ZoomIndicator level={level} />);
		return container.querySelector("[data-testid='zoom-indicator']")?.textContent;
	};

	it("renders 100% at the default zoom level", () => {
		expect(percent(1)).toBe("100%");
	});

	it("renders the zoom factor as a percentage", () => {
		expect(percent(1.5)).toBe("150%");
		expect(percent(0.5)).toBe("50%");
		expect(percent(2)).toBe("200%");
	});

	it("rounds to the nearest integer", () => {
		expect(percent(0.7142)).toBe("71%");
	});
});
