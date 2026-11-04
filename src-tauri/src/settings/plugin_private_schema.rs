//! Typed build-cleaner and Telegram notifier configuration; no runtime/statistics fields.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct BuildCleaner {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub per_artifact_warn_bytes: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub total_warn_bytes: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub total_critical_bytes: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub hot_window_secs: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub poll_interval_ms: u64,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    #[schemars(length(min = 1, max = 128))]
    pub enabled_kinds: Vec<ArtifactKind>,
}
impl Default for BuildCleaner {
    fn default() -> Self {
        Self {
            per_artifact_warn_bytes: 5 * 1024 * 1024 * 1024,
            total_warn_bytes: 50 * 1024 * 1024 * 1024,
            total_critical_bytes: 150 * 1024 * 1024 * 1024,
            hot_window_secs: 86400,
            poll_interval_ms: 3600000,
            enabled_kinds: vec![
                ArtifactKind::Rust,
                ArtifactKind::Maven,
                ArtifactKind::Node,
                ArtifactKind::Jscache,
                ArtifactKind::Python,
                ArtifactKind::Dotnet,
                ArtifactKind::Gradle,
                ArtifactKind::Cmake,
                ArtifactKind::Swift,
                ArtifactKind::Flutter,
                ArtifactKind::Terraform,
                ArtifactKind::Elixir,
                ArtifactKind::Zig,
                ArtifactKind::Haskell,
                ArtifactKind::Php,
            ],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum ArtifactKind {
    Rust,
    Maven,
    Node,
    Jscache,
    Python,
    Dotnet,
    Gradle,
    Cmake,
    Swift,
    Flutter,
    Terraform,
    Elixir,
    Zig,
    Haskell,
    Php,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct TelegramNotifier {
    #[schemars(extend("x-setting" = {"sensitivity":"secret","apply":"service_restart","effect":"Reloads the notifier with the committed bot credential.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    #[schemars(length(max = 4096))]
    pub bot_token: String,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    #[schemars(length(max = 128))]
    pub chat_id: String,
    pub events: TelegramEvents,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields, rename_all = "kebab-case")]
pub(super) struct TelegramEvents {
    pub question: TelegramEvent,
    pub rate_limit: TelegramEvent,
    pub usage_limit: TelegramEvent,
    pub ci_failure: TelegramEvent,
    pub agent_stopped: TelegramEvent,
    pub pr_url: TelegramEvent,
}
impl Default for TelegramEvents {
    fn default() -> Self {
        Self {
            question: TelegramEvent {
                enabled: true,
                silent: false,
            },
            rate_limit: TelegramEvent {
                enabled: true,
                silent: false,
            },
            usage_limit: TelegramEvent {
                enabled: true,
                silent: true,
            },
            ci_failure: TelegramEvent {
                enabled: true,
                silent: false,
            },
            agent_stopped: TelegramEvent {
                enabled: true,
                silent: false,
            },
            pr_url: TelegramEvent {
                enabled: true,
                silent: true,
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct TelegramEvent {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub enabled: bool,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"service_restart","effect":"Reloads the plugin after its settings commit.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub silent: bool,
}
