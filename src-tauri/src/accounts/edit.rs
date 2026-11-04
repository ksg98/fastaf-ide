//! Shared account actions for native IPC, HTTP and later Settings owner adapters.
use super::model::{
    Account, AccountView, AuthKind, NewAccount, SecretPresence, SecretStatus, Site,
};
use super::{providers, store, verify};
use crate::credentials::Credential;
use crate::state::AppState;

/// Checks that need no credential, so a caller can refuse before asking for one.
fn validate_metadata(input: &NewAccount) -> Result<String, String> {
    let provider = providers::descriptor(&input.provider)?;
    if !provider.kinds.contains(&input.kind)
        || matches!(input.kind, AuthKind::Ambient | AuthKind::OauthDevice)
    {
        return Err("This authentication kind requires the core GitHub login flow".into());
    }
    if input.label.trim().is_empty() || input.label.len() > 256 {
        return Err("Account label must contain 1–256 bytes".into());
    }
    if input.kind == AuthKind::Basic
        && !input.username.as_ref().is_some_and(|name| {
            !name.trim().is_empty() && name.len() <= 512 && !name.contains([':', '\r', '\n', '\0'])
        })
    {
        return Err("Basic authentication requires a valid username".into());
    }
    let host = providers::canonical_host(&input.host)?;
    if input.provider == "github" {
        let github = host
            .strip_prefix("https://")
            .and_then(crate::github_account::GitHubHost::new)
            .ok_or("GitHub requires a canonical HTTPS hostname")?;
        if github.is_cloud() {
            return Err("github.com uses device-flow login, not a PAT".into());
        }
    }
    Ok(host)
}

fn account_id(input: &NewAccount, host: &str) -> String {
    if input.provider == "github" {
        host.trim_start_matches("https://").to_string()
    } else {
        uuid::Uuid::new_v4().to_string()
    }
}

const EXISTS: &str = "Account already exists; remove it before adding a replacement";

/// Refuses a new account for a non-secret cause before any credential is requested.
pub(crate) fn precheck_new(input: &NewAccount) -> Result<(), String> {
    let host = validate_metadata(input)?;
    if input.provider == "github"
        && store::snapshot()?
            .accounts
            .contains_key(&account_id(input, &host))
    {
        return Err(EXISTS.into());
    }
    Ok(())
}

fn validate_new(input: &NewAccount, token: &str) -> Result<String, String> {
    if token.trim().is_empty() || token.len() > 16 * 1024 || token.contains(['\r', '\n', '\0']) {
        return Err("A non-empty account token without line breaks is required".into());
    }
    validate_metadata(input)
}

pub(crate) async fn add_account(input: NewAccount, token: String) -> Result<AccountView, String> {
    let host = validate_new(&input, &token)?;
    let mut record = Account {
        id: account_id(&input, &host),
        provider: input.provider,
        site_id: String::new(),
        host,
        kind: input.kind,
        label: input.label.trim().into(),
        login: None,
        username: input.username,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock precedes the epoch")?
            .as_millis()
            .try_into()
            .map_err(|_| "Account timestamp is out of range")?,
        auth_source: None,
    };
    record.login = Some(verify::verify(&record, token.trim()).await?);
    if record.provider == "github" {
        record.auth_source = Some("pat".into());
    }
    let account = tokio::task::spawn_blocking(move || {
        store::with_registry(|registry| {
            if registry.accounts.contains_key(&record.id) {
                return Err(EXISTS.into());
            }
            let site = store::ensure_site(registry, &record.provider, &record.host, &record.label);
            record.site_id = site.id;
            crate::credentials::set(Credential::AccountToken(&record.id), token.trim())
                .map_err(|_| "Account credential storage failed")?;
            registry.accounts.insert(record.id.clone(), record.clone());
            Ok((record, true))
        })
    })
    .await
    .map_err(|_| "Account storage task failed")??;
    Ok(AccountView {
        account,
        secret: SecretPresence {
            status: SecretStatus::Set,
        },
    })
}

pub(crate) fn list_accounts(
    provider: Option<&str>,
    state: Option<&AppState>,
) -> Result<Vec<AccountView>, String> {
    Ok(store::snapshot()?
        .accounts
        .into_values()
        .filter(|account| provider.is_none_or(|id| account.provider == id))
        .map(|account| {
            let status = if account.kind == AuthKind::Ambient
                && let Some(state) = state
            {
                if state.github.token.read().is_some() {
                    SecretStatus::Set
                } else {
                    SecretStatus::Unset
                }
            } else {
                match store::read_token(&account.id) {
                    Ok(Some(_)) => SecretStatus::Set,
                    Ok(None) => SecretStatus::Unset,
                    Err(_) => SecretStatus::Unavailable,
                }
            };
            AccountView {
                account,
                secret: SecretPresence { status },
            }
        })
        .collect())
}

pub(crate) fn list_sites(provider: Option<&str>) -> Result<Vec<Site>, String> {
    Ok(store::snapshot()?
        .sites
        .into_values()
        .filter(|site| provider.is_none_or(|id| site.provider == id))
        .collect())
}

pub(crate) fn add_site(provider: &str, host: &str, label: &str) -> Result<Site, String> {
    providers::descriptor(provider)?;
    let host = providers::canonical_host(host)?;
    if label.trim().is_empty() || label.len() > 256 {
        return Err("Site label must contain 1–256 bytes".into());
    }
    if provider == "github"
        && host
            .strip_prefix("https://")
            .and_then(crate::github_account::GitHubHost::new)
            .is_none()
    {
        return Err("GitHub requires a canonical HTTPS hostname".into());
    }
    store::with_registry(|registry| {
        let before = registry.sites.len();
        let site = store::ensure_site(registry, provider, &host, label.trim());
        Ok((site, before != registry.sites.len()))
    })
}

/// Replace a token through verification; OAuth-device credentials keep their own flow.
pub(crate) async fn set_secret(id: String, token: String) -> Result<AccountView, String> {
    let id_for_load = id.clone();
    let mut record = tokio::task::spawn_blocking(move || {
        store::snapshot()?
            .accounts
            .remove(&id_for_load)
            .ok_or_else(|| "Account not found".to_string())
    })
    .await
    .map_err(|_| "Account storage task failed")??;
    let input = NewAccount {
        provider: record.provider.clone(),
        host: record.host.clone(),
        kind: record.kind,
        label: record.label.clone(),
        username: record.username.clone(),
    };
    validate_new(&input, &token)?;
    let before = record.clone();
    record.login = Some(verify::verify(&record, token.trim()).await?);
    let account = tokio::task::spawn_blocking(move || {
        store::with_registry(|registry| {
            if registry.accounts.get(&id) != Some(&before) {
                return Err(
                    "Account changed during verification; retry the token replacement".into(),
                );
            }
            crate::credentials::set(Credential::AccountToken(&id), token.trim())
                .map_err(|_| "Account credential storage failed")?;
            registry.accounts.insert(id, record.clone());
            Ok((record, true))
        })
    })
    .await
    .map_err(|_| "Account storage task failed")??;
    Ok(AccountView {
        account,
        secret: SecretPresence {
            status: SecretStatus::Set,
        },
    })
}
