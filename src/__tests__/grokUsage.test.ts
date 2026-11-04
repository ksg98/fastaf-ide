import { describe, expect, it } from "vitest";
import {
	buildGrokTickerText,
	type GrokUsageApiResponse,
	getGrokTickerPriority,
	grokPeriodLabel,
} from "../features/grokUsage";

const usage = (percent: number | null): GrokUsageApiResponse => ({
	config: {
		credit_usage_percent: percent,
		current_period: { period_type: "USAGE_PERIOD_TYPE_WEEKLY", start: null, end: null },
		on_demand_cap: null,
		on_demand_used: null,
		prepaid_balance: null,
		is_unified_billing_user: true,
		billing_period_start: null,
		billing_period_end: null,
	},
	on_demand_enabled: null,
	subscription_tier: "X Premium+",
});

describe("Grok usage", () => {
	it("formats the provider period without inventing a window", () => {
		expect(grokPeriodLabel("USAGE_PERIOD_TYPE_WEEKLY")).toBe("weekly");
		expect(buildGrokTickerText(usage(26))).toBe("weekly: 26%");
		expect(buildGrokTickerText(usage(null))).toBe("no data");
	});

	it("uses the shared blink boundary, catching premature critical priority", () => {
		expect(getGrokTickerPriority(usage(69))).toBe(10);
		expect(getGrokTickerPriority(usage(70))).toBe(50);
		expect(getGrokTickerPriority(usage(90))).toBe(50);
		expect(getGrokTickerPriority(usage(95))).toBe(50);
		expect(getGrokTickerPriority(usage(95.9))).toBe(50);
		expect(getGrokTickerPriority(usage(96))).toBe(96);
	});
});
