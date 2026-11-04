import { AGENT_USAGE_BLINK_THRESHOLD } from "./usageThresholds";

export interface GrokMoney {
	val: number;
}

export interface GrokUsagePeriod {
	period_type: string | null;
	start: string | null;
	end: string | null;
}

export interface GrokUsageApiResponse {
	config: {
		credit_usage_percent: number | null;
		current_period: GrokUsagePeriod | null;
		on_demand_cap: GrokMoney | null;
		on_demand_used: GrokMoney | null;
		prepaid_balance: GrokMoney | null;
		is_unified_billing_user: boolean | null;
		billing_period_start: string | null;
		billing_period_end: string | null;
	};
	on_demand_enabled: boolean | null;
	subscription_tier: string | null;
}

export function grokPeriodLabel(periodType: string | null | undefined): string {
	if (!periodType) return "usage";
	const match = periodType.match(/USAGE_PERIOD_TYPE_(.+)$/);
	return (match?.[1] ?? periodType).toLowerCase();
}

export function buildGrokTickerText(api: GrokUsageApiResponse): string {
	const used = api.config.credit_usage_percent;
	if (used === null || !Number.isFinite(used)) return "no data";
	return `${grokPeriodLabel(api.config.current_period?.period_type)}: ${Math.round(used)}%`;
}

export function getGrokTickerPriority(api: GrokUsageApiResponse): number {
	const used = api.config.credit_usage_percent;
	if (used !== null && used >= AGENT_USAGE_BLINK_THRESHOLD) return AGENT_USAGE_BLINK_THRESHOLD;
	if (used !== null && used >= 70) return 50;
	return 10;
}
