use serde::{Deserialize, Serialize};

/// Response from `POST https://github.com/login/device/code`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Result of a single poll attempt to `POST https://github.com/login/oauth/access_token`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum PollResult {
    /// User hasn't authorized yet — keep polling.
    #[serde(rename = "pending")]
    Pending,
    /// Polling too fast — increase interval by 5 seconds.
    #[serde(rename = "slow_down")]
    SlowDown,
    /// User authorized — token received.
    #[serde(rename = "success")]
    Success {
        #[serde(skip_serializing, default)]
        access_token: String,
        scope: String,
    },
    /// Device code expired (15 min) — must restart flow.
    #[serde(rename = "expired")]
    Expired,
    /// User denied access.
    #[serde(rename = "access_denied")]
    AccessDenied,
}

impl std::fmt::Debug for PollResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match serde_json::to_value(self) {
            Ok(value) => write!(f, "{value}"),
            Err(_) => f.write_str("GitHub poll status unavailable"),
        }
    }
}

/// Where the active GitHub token came from.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum TokenSource {
    /// GH_TOKEN or GITHUB_TOKEN environment variable
    Env,
    /// OAuth Device Flow token stored in OS keyring
    #[serde(rename = "oauth")]
    OAuth,
    /// Personal Access Token pasted for a GitHub Enterprise Server account
    Pat,
    /// No token available
    #[default]
    None,
}

/// Authentication status returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub login: Option<String>,
    pub avatar_url: Option<String>,
    pub source: TokenSource,
    pub scopes: Option<String>,
    /// Human-readable error when the token exists but validation failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Catches: Serde spelling OAuth as o_auth hides Logout in both transports.
    #[test]
    fn oauth_status_uses_the_frontend_source_spelling() {
        let status = AuthStatus {
            authenticated: true,
            login: Some("octocat".into()),
            avatar_url: None,
            source: TokenSource::OAuth,
            scopes: Some("read:org, repo".into()),
            error: None,
        };
        assert_eq!(serde_json::to_value(status).unwrap()["source"], "oauth");
        for (source, wire) in [
            (TokenSource::Env, "env"),
            (TokenSource::OAuth, "oauth"),
            (TokenSource::Pat, "pat"),
            (TokenSource::None, "none"),
        ] {
            assert_eq!(serde_json::to_value(source).unwrap(), wire);
            assert_eq!(
                serde_json::from_value::<TokenSource>(serde_json::json!(wire)).unwrap(),
                source
            );
        }
    }
}
