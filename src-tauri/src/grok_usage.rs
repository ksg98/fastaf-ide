//! Grok account usage through Grok Build's documented ACP billing extension.
//!
//! The short-lived ACP process is telemetry-only. Normal Grok tabs remain PTY
//! sessions; this module does not introduce ACP session routing or fallback.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cli_usage_rpc::{UsageCache, looks_like_auth_failure, looks_like_contract_failure};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GrokMoney {
    pub val: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GrokUsagePeriod {
    #[serde(alias = "type")]
    pub period_type: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GrokBillingConfig {
    #[serde(alias = "creditUsagePercent")]
    pub credit_usage_percent: Option<f64>,
    #[serde(alias = "currentPeriod")]
    pub current_period: Option<GrokUsagePeriod>,
    #[serde(alias = "onDemandCap")]
    pub on_demand_cap: Option<GrokMoney>,
    #[serde(alias = "onDemandUsed")]
    pub on_demand_used: Option<GrokMoney>,
    #[serde(alias = "prepaidBalance")]
    pub prepaid_balance: Option<GrokMoney>,
    #[serde(alias = "isUnifiedBillingUser")]
    pub is_unified_billing_user: Option<bool>,
    #[serde(alias = "billingPeriodStart")]
    pub billing_period_start: Option<String>,
    #[serde(alias = "billingPeriodEnd")]
    pub billing_period_end: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GrokUsageApiResponse {
    pub config: GrokBillingConfig,
    #[serde(alias = "onDemandEnabled")]
    pub on_demand_enabled: Option<bool>,
    #[serde(alias = "subscriptionTier")]
    pub subscription_tier: Option<String>,
}

static CACHE: UsageCache<GrokUsageApiResponse> = UsageCache::new();
static FETCH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn fetch_usage() -> Result<GrokUsageApiResponse, String> {
    let detection = crate::agent::detect_agent_binary("grok".to_string()).await;
    let binary = detection
        .path
        .ok_or_else(|| "Grok CLI not found".to_string())?;
    let messages = [
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false},
                "clientInfo": {"name": "fastaf", "version": env!("CARGO_PKG_VERSION")}
            }
        }),
        serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "_x.ai/billing", "params": {}}),
    ];
    let responses = crate::cli_usage_rpc::request_jsonl(
        Path::new(&binary),
        &["agent", "stdio"],
        &messages,
        &[1],
        Duration::from_secs(20),
    )
    .await?;
    crate::cli_usage_rpc::decode_result(&responses, 1, "Grok billing")
}

async fn cached_usage() -> Result<GrokUsageApiResponse, String> {
    if let Some(value) = CACHE.fresh() {
        return Ok(value);
    }
    let _guard = FETCH_LOCK.lock().await;
    if let Some(value) = CACHE.fresh() {
        return Ok(value);
    }
    match fetch_usage().await {
        Ok(value) => {
            CACHE.put(&value);
            Ok(value)
        }
        Err(message)
            if !looks_like_auth_failure(&message) && !looks_like_contract_failure(&message) =>
        {
            if let Some(value) = CACHE.stale() {
                tracing::info!(
                    source = "grok_usage",
                    "Returning stale cache after error: {message}"
                );
                Ok(value)
            } else {
                Err(message)
            }
        }
        Err(message) => Err(message),
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn get_grok_usage_api() -> Result<GrokUsageApiResponse, String> {
    cached_usage().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_current_camel_case_billing_shape() {
        let parsed: GrokUsageApiResponse = serde_json::from_value(serde_json::json!({
            "config": {
                "creditUsagePercent": 26,
                "currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "a", "end": "b"},
                "onDemandCap": {"val": 10},
                "onDemandUsed": {"val": 2.5},
                "prepaidBalance": {"val": 4},
                "isUnifiedBillingUser": true,
                "billingPeriodStart": "a",
                "billingPeriodEnd": "b"
            },
            "on_demand_enabled": true,
            "subscription_tier": "X Premium+"
        }))
        .unwrap();

        assert_eq!(parsed.config.credit_usage_percent, Some(26.0));
        assert_eq!(
            parsed
                .config
                .current_period
                .as_ref()
                .unwrap()
                .period_type
                .as_deref(),
            Some("USAGE_PERIOD_TYPE_WEEKLY")
        );
        let on_demand = parsed.config.on_demand_used.as_ref().unwrap().val;
        assert!(
            (on_demand - 2.5).abs() < f64::EPSILON,
            "on_demand_used.val was {on_demand}, expected 2.5"
        );
        assert_eq!(parsed.subscription_tier.as_deref(), Some("X Premium+"));
        let public = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            public["config"]["current_period"]["period_type"],
            "USAGE_PERIOD_TYPE_WEEKLY"
        );
        assert!(public["config"]["current_period"].get("type").is_none());
    }

    #[test]
    fn missing_usage_percent_stays_unknown() {
        let parsed: GrokUsageApiResponse = serde_json::from_value(serde_json::json!({
            "config": {}, "on_demand_enabled": null, "subscription_tier": null
        }))
        .unwrap();
        assert!(parsed.config.credit_usage_percent.is_none());
        assert!(parsed.on_demand_enabled.is_none());
    }

    #[test]
    fn schema_failures_are_not_hidden_by_stale_data() {
        assert!(looks_like_contract_failure(
            "Failed to parse Grok billing response: missing field"
        ));
        assert!(!looks_like_contract_failure("network connection reset"));
    }
}
