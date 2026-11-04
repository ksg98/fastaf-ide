import { expect, it } from "vitest";
import { formatQuotaWindow, formatUsageTime } from "../utils/sessionUsageFormatting";

// Catches: account percentages rendered without a provider, plan or window.
it("names provider, plan and quota window instead of raw account quota labels", () => {
	expect(
		formatQuotaWindow({
			provider: "Claude",
			plan: "Max",
			window_seconds: 18000,
			window_name: "primary",
			used_percent: 2,
			resets_at: null,
		}),
	).toBe("Claude Max plan, 5-hour window: 2% used");
	expect(
		formatQuotaWindow({
			provider: "Codex",
			plan: null,
			window_seconds: 604800,
			window_name: "secondary",
			used_percent: 46,
			resets_at: null,
		}),
	).toBe("Codex plan, 7-day window: 46% used");
	expect(
		formatQuotaWindow({
			provider: "Codex",
			plan: null,
			window_seconds: null,
			window_name: "primary",
			used_percent: 0,
			resets_at: null,
		}),
	).toBe("Codex plan, primary window: 0% used");
});

// Catches: reset timestamps leaking ISO bytes or a daemon timezone into client text.
it("formats reset instants in the client timezone and omits invalid dates", () => {
	// October 26 is UTC+1 in Rome (not UTC+2 after the DST boundary).
	expect(formatUsageTime("2026-10-26T11:20:00.093350+00:00", "Europe/Rome")).toContain("12:20");
	expect(formatUsageTime("invalid")).toBeNull();
	const text = formatQuotaWindow(
		{
			provider: "Claude",
			plan: null,
			window_seconds: 18000,
			window_name: "primary",
			used_percent: 2,
			resets_at: "2026-10-26T11:20:00.093350+00:00",
		},
		"Europe/Rome",
	);
	expect(text).toContain("resets");
	expect(text).toContain("12:20 local");
	expect(text).not.toContain("2026-10-26T");
});
