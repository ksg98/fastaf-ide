//! Rust schemas and migrations for the existing configurable external plugins.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Capacity {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub retry_delay_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub max_retries_per_window: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub window_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    #[schemars(length(min = 1, max = 4096))]
    pub retry_text: String,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub detect_debounce_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub ticker_interval_ms: u64,
}
impl Default for Capacity {
    fn default() -> Self {
        Self {
            retry_delay_ms: 60000,
            max_retries_per_window: 3,
            window_ms: 3600000,
            retry_text: "retry last request".into(),
            detect_debounce_ms: 20000,
            ticker_interval_ms: 5000,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Keepalive {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub ttl_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub margin_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub max_keepalives: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub check_interval_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    #[schemars(length(min = 1, max = 4096))]
    pub message: String,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub max_consecutive_misses: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub max_total_keepalives: u64,
}
impl Default for Keepalive {
    fn default() -> Self {
        Self {
            ttl_ms: 300000,
            margin_ms: 30000,
            max_keepalives: 3,
            check_interval_ms: 30000,
            message: "[noop]".into(),
            max_consecutive_misses: 2,
            max_total_keepalives: 9,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Wakeup {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub idle_threshold_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub max_wakes: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub max_wakes_ever: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub check_interval_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub min_busy_duration_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub question_stale_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub pending_timeout_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub done_max_busy_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub error_loop_threshold: u64,
}
impl Default for Wakeup {
    fn default() -> Self {
        Self {
            idle_threshold_ms: 20000,
            max_wakes: 3,
            max_wakes_ever: 12,
            check_interval_ms: 5000,
            min_busy_duration_ms: 1500,
            question_stale_ms: 1800000,
            pending_timeout_ms: 60000,
            done_max_busy_ms: 8000,
            error_loop_threshold: 3,
        }
    }
}
