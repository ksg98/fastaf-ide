//! Typed GitHub owner actions. This adapter never edits account files or vault entries.
//! Transport publication, caller policy and the post-commit publisher belong to later steps.
use super::request::{Error, Failure};
use crate::{
    accounts::{AccountAction, AuthKind, NewAccount},
    state::AppState,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

#[path = "accounts_bindings.rs"]
mod bindings;
#[path = "accounts_login.rs"]
mod login;

pub(super) const ID: &str = "github_accounts";

// No Debug or Serialize: credentials are input-only, even in diagnostics.
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum GithubAction {
    /// Enumerate owner metadata and credential presence, never credential values.
    ListAccounts {},
    BeginCloudLogin {
        #[serde(default)]
        additional: bool,
    },
    CloudLoginStatus {
        flow_id: String,
    },
    CompleteCloudLogin {
        flow_id: String,
    },
    AddEnterprise {
        host: String,
        label: String,
        #[schemars(extend("writeOnly" = true, "x-sensitivity" = "secret"))]
        token: String,
    },
    RemoveAccount {
        id: String,
    },
    SetLabel {
        id: String,
        label: String,
    },
    SetSecret {
        id: String,
        #[schemars(extend("writeOnly" = true, "x-sensitivity" = "secret"))]
        token: String,
    },
    ClearSecret {
        id: String,
    },
    BindRepo {
        repo_path: String,
        account_id: String,
        remote_name: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: String,
    },
    UnbindRepo {
        repo_path: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: String,
    },
}

pub struct GithubSettings {
    state: std::sync::Weak<AppState>,
    login: login::Logins,
}

impl GithubSettings {
    pub(crate) fn new(state: Arc<AppState>) -> Self {
        Self {
            state: Arc::downgrade(&state),
            login: login::Logins::default(),
        }
    }

    /// Generated action schema for transport registration; no stored values or I/O.
    pub fn action_schema() -> Value {
        super::catalogue::schema::<GithubAction>()
    }

    /// Credential presence is projected by the owner, never persisted in account metadata.
    pub fn catalogue_schema() -> Value {
        let mut schema = super::catalogue::schema::<crate::github_account::GitHubAccountRegistry>();
        schema["properties"]["accounts"]["items"]["properties"]["credential"] = json!({
            "type": "string",
            "enum": ["set", "unset", "unavailable"],
            "x-setting": {
                "sensitivity": "secret", "apply": "live",
                "effect": "Reads credential presence. Use typed account actions for cloud device login, enterprise verification, token rotation and removal.",
                "operations": ["get", "set_secret", "clear_secret"],
                "confirmationClass": "ordinary"
            }
        });
        let mut source = super::catalogue::schema::<crate::github_auth::TokenSource>();
        source["x-setting"] = json!({
            "sensitivity":"public", "apply":"live",
            "effect":"Reports the runtime GitHub credential source without revealing credentials.",
            "operations":["get"], "confirmationClass":"ordinary"
        });
        // Only provenance is public here: never register the sibling auth.secret projection.
        schema["properties"]["auth"] = json!({
            "type":"object", "properties":{"source":source}, "required":["source"]
        });
        schema
    }

    /// No network refresh and no ambient token resolution: show the runtime owner's provenance.
    pub async fn read(&self) -> Result<Value, Failure> {
        let mut accounts = crate::accounts::execute(
            &self
                .state
                .upgrade()
                .ok_or_else(|| Error::new(ID, "unavailable"))?,
            AccountAction::List {
                provider: Some("github".into()),
            },
        )
        .await
        .map_err(|_| Error::new(ID, "store_failed"))?;
        if let Some(rows) = accounts.as_array_mut() {
            for row in rows {
                row["credential"] = row["secret"]["status"].clone();
            }
        }
        let bindings = tokio::task::spawn_blocking(bindings::read)
            .await
            .map_err(|_| Error::new(ID, "store_failed"))??;
        let mut snapshot = json!({
            "accounts": accounts,
            "bindings": bindings.0,
            "bindingsRevision": bindings.1,
            "auth": {
                "source": *self.state.upgrade().ok_or_else(|| Error::new(ID, "unavailable"))?.github.token_source.read(),
                "secret": {"status": if self.state.upgrade().ok_or_else(|| Error::new(ID, "unavailable"))?.github.token.read().is_some() { "set" } else { "unset" }},
            },
        });
        let revision = super::transaction::revision(&snapshot)?;
        snapshot["revision"] = json!(revision);
        Ok(snapshot)
    }

    async fn require_github(&self, id: &str) -> Result<(), Failure> {
        let rows = crate::accounts::execute(
            &self
                .state
                .upgrade()
                .ok_or_else(|| Error::new(ID, "unavailable"))?,
            AccountAction::List {
                provider: Some("github".into()),
            },
        )
        .await
        .map_err(|_| Error::new(ID, "store_failed"))?;
        if rows
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["id"] == id))
        {
            Ok(())
        } else {
            Err(Error::new(ID, "not_found"))
        }
    }

    pub async fn perform(&self, action: GithubAction) -> Result<Value, Failure> {
        let owner_action = match action {
            GithubAction::ListAccounts {} => {
                let snapshot = self.read().await?;
                return Ok(
                    json!({"accounts":snapshot["accounts"], "revision":snapshot["revision"], "persisted":false}),
                );
            }
            GithubAction::BeginCloudLogin { additional } => {
                return self
                    .login
                    .begin(
                        &self
                            .state
                            .upgrade()
                            .ok_or_else(|| Error::new(ID, "unavailable"))?,
                        additional,
                    )
                    .await;
            }
            GithubAction::CloudLoginStatus { flow_id } => return self.login.status(&flow_id),
            GithubAction::CompleteCloudLogin { flow_id } => {
                let status = self
                    .login
                    .complete(
                        &self
                            .state
                            .upgrade()
                            .ok_or_else(|| Error::new(ID, "unavailable"))?,
                        &flow_id,
                    )
                    .await?;
                return if status["status"] == "success" && status["persisted"] == true {
                    self.committed(status, true).await
                } else {
                    Ok(status)
                };
            }
            GithubAction::AddEnterprise { host, label, token } => {
                // Delegate metadata/auth validation and the /user identity check to accounts.
                // Cloud is refused before network or credential access, including canonical aliases.
                let cloud = url::Url::parse(&host)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_owned))
                    .and_then(|host| crate::github_account::GitHubHost::new(&host))
                    .is_some_and(|host| host.is_cloud());
                if cloud {
                    return Err(Error::new(ID, "auth_required"));
                }
                AccountAction::Add {
                    account: NewAccount {
                        provider: "github".into(),
                        host,
                        kind: AuthKind::Bearer,
                        label,
                        username: None,
                    },
                    token,
                }
            }
            GithubAction::RemoveAccount { id } => {
                self.require_github(&id).await?;
                AccountAction::Remove { id }
            }
            GithubAction::SetLabel { id, label } => {
                self.require_github(&id).await?;
                AccountAction::SetLabel { id, label }
            }
            GithubAction::SetSecret { id, token } => {
                self.require_github(&id).await?;
                // The owner forbids PAT replacement for cloud/OAuth/ambient accounts.
                if self.cloud_account(&id).await? {
                    return Err(Error::new(ID, "auth_required"));
                }
                AccountAction::SetSecret { id, token }
            }
            GithubAction::ClearSecret { id } => {
                self.require_github(&id).await?;
                AccountAction::ClearSecret { id }
            }
            GithubAction::BindRepo {
                repo_path,
                account_id,
                remote_name,
                expected_revision,
            } => {
                let result = tokio::task::spawn_blocking(move || {
                    bindings::change(
                        &repo_path,
                        Some((&account_id, &remote_name)),
                        &expected_revision,
                    )
                })
                .await
                .map_err(|_| Error::new(ID, "store_failed"))??;
                return self.committed(json!({"changed":result}), result).await;
            }
            GithubAction::UnbindRepo {
                repo_path,
                expected_revision,
            } => {
                let result = tokio::task::spawn_blocking(move || {
                    bindings::change(&repo_path, None, &expected_revision)
                })
                .await
                .map_err(|_| Error::new(ID, "store_failed"))??;
                return self.committed(json!({"changed":result}), result).await;
            }
        };
        let before = self.read().await?;
        let credential_edit = matches!(
            owner_action,
            AccountAction::SetSecret { .. } | AccountAction::ClearSecret { .. }
        );
        let result = crate::accounts::execute(
            &self
                .state
                .upgrade()
                .ok_or_else(|| Error::new(ID, "unavailable"))?,
            owner_action,
        )
        .await
        .map_err(|message| Error::new(ID, owner_code(&message)));
        let snapshot = self.read().await.map_err(|mut error| {
            // An owner action may already have committed a file/vault phase.
            error.persisted = true;
            error.next_action = "get".into();
            error
        })?;
        let changed = before["revision"] != snapshot["revision"];
        match result {
            Ok(result) => Ok(Self::reply(result, snapshot, changed || credential_edit)),
            Err(mut error) => {
                error.persisted = changed;
                error.next_action = "get".into();
                error.revision = snapshot["revision"].as_str().map(str::to_owned);
                Err(error)
            }
        }
    }

    async fn cloud_account(&self, id: &str) -> Result<bool, Failure> {
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || {
            let accounts =
                crate::accounts::github_accounts().map_err(|_| Error::new(ID, "store_failed"))?;
            Ok(id == crate::github_account::GitHubAccount::GITHUB_COM_ID
                || accounts
                    .iter()
                    .any(|account| account.id == id && account.host.is_cloud()))
        })
        .await
        .map_err(|_| Error::new(ID, "store_failed"))?
    }

    async fn committed(&self, result: Value, persisted: bool) -> Result<Value, Failure> {
        let snapshot = self.read().await.map_err(|mut error| {
            error.persisted = true;
            error.next_action = "get".into();
            error
        })?;
        Ok(Self::reply(result, snapshot, persisted))
    }

    fn reply(result: Value, snapshot: Value, persisted: bool) -> Value {
        json!({"persisted":persisted,"applied":true,"revision":snapshot["revision"],
            "changedIds": if persisted { vec!["github_accounts", "github_bindings"] } else { vec![] },
            "effects":[],"restart":[],"result":result,"snapshot":snapshot})
    }
}

const INPUT_CAUSES: [&str; 4] = ["must contain", "require", "too long", "Invalid"];

/// The owner reports refusals as text; only the cause class leaves, never the message.
fn owner_code(message: &str) -> &'static str {
    if message.contains("device-flow login") || message.contains("core GitHub login flow") {
        "auth_required"
    } else if message.contains("cannot be removed") {
        "not_allowed"
    } else if message.contains("already") || message.contains("changed during") {
        "conflict"
    } else if message.contains("not found") || message.contains("was removed during") {
        "not_found"
    } else if message.starts_with("Account verification") {
        "verification_failed"
    } else if INPUT_CAUSES.iter().any(|cause| message.contains(cause)) {
        "out_of_range"
    } else {
        "store_failed"
    }
}
