import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMoney, GrokUsageDashboard } from "../../components/GrokUsageDashboard/GrokUsageDashboard";
import { mockInvoke } from "../mocks/tauri";

describe("GrokUsageDashboard", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockInvoke.mockReset();
		mockInvoke.mockResolvedValue({
			config: {
				credit_usage_percent: 26,
				current_period: { period_type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-15", end: "2026-09-22" },
				on_demand_cap: { val: 10 },
				on_demand_used: { val: 2.5 },
				prepaid_balance: null,
				is_unified_billing_user: true,
				billing_period_start: "2026-09-15",
				billing_period_end: "2026-09-22",
			},
			on_demand_enabled: true,
			subscription_tier: "X Premium+",
		});
	});

	afterEach(() => vi.useRealTimers());

	it("renders provider usage and keeps missing amounts unavailable", async () => {
		const { container, unmount } = render(() => GrokUsageDashboard({}));
		await vi.advanceTimersByTimeAsync(0);

		expect(mockInvoke).toHaveBeenCalledWith("get_grok_usage_api");
		expect(container.textContent).toContain("26%");
		expect(container.textContent).toContain("X Premium+");
		expect(container.textContent).toContain("2.50");
		expect(container.textContent).toContain("--");
		unmount();
	});

	it("does not turn an absent amount into zero", () => {
		expect(formatMoney(null)).toBe("--");
		expect(formatMoney(0)).toBe("0.00");
	});
});
