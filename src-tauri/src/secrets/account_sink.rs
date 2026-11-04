//! Native-only account entry. Credentials go straight to the account owner service.
#[cfg(any(feature = "desktop", test))]
use super::Submission;
use super::{Field, FieldKind, Form, Status, forms};
use crate::{AppState, accounts};
use serde::Deserialize;
use std::sync::Arc;
#[cfg(any(feature = "desktop", test))]
use zeroize::Zeroizing;

/// The launching Settings webview sends metadata only, never a credential or nonce.
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Request {
    Add { account: accounts::NewAccount },
    Rotate { id: String },
}

pub(super) fn form() -> Result<Form, String> {
    Form::request(
        vec![Field {
            name: "TOKEN".into(),
            kind: FieldKind::Password,
            display: None,
        }],
        "Store the account credential in the private vault.".into(),
    )
}

pub(crate) async fn request(state: &Arc<AppState>, mut request: Request) -> Result<Status, String> {
    let mut form = form()?;
    form.reason = match &mut request {
        Request::Add { account } => {
            // The existing Enterprise UI accepts a bare hostname; URL construction
            // belongs in Rust, using the same canonical host type as core GitHub.
            if account.provider == "github" && !account.host.contains("://") {
                let host = crate::github_account::GitHubHost::new(&account.host)
                    .ok_or("Invalid GitHub Enterprise hostname")?;
                account.host = format!("https://{}", host.as_str());
            }
            // Refuse for any non-secret cause before the user types a token.
            accounts::precheck_new(account)?;
            format!(
                "Store a {} credential for {} at {}.",
                account.provider, account.label, account.host
            )
        }
        Request::Rotate { id } => format!("Replace the credential for account {id}."),
    };
    if form.reason.len() > 4096 {
        return Err("Account entry metadata is too long".into());
    }
    forms::ask_with_sink(state, form, Some(request)).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn account_secret_form(
    state: tauri::State<'_, Arc<AppState>>,
    request: Request,
) -> Result<Status, String> {
    self::request(state.inner(), request).await
}

/// Shared native boundary for ordinary forms and the account sink. Only the
/// caller identity supplied by Tauri can enter this path; HTTP calls submit().
#[cfg(any(feature = "desktop", test))]
pub(super) async fn submit_native(
    state: &AppState,
    label: &str,
    mut submission: Submission,
) -> Result<Status, String> {
    let store = &state.secrets;
    let pending = {
        let mut inner = store.inner.lock();
        let pending = inner
            .pending
            .as_ref()
            .ok_or("Unknown or expired secret form")?;
        if label != format!("secret-{}", pending.form.id) || !store.has_window(label) {
            return Err("Secret submit requires the private native window".into());
        }
        if pending.form.nonce != submission.nonce {
            return Err("Unknown or expired secret form".into());
        }
        if pending.sink.is_none() {
            drop(inner);
            let nonce = Zeroizing::new(submission.nonce.clone());
            return store.submit(&nonce, submission);
        }
        match submission.status.as_str() {
            "declined" if submission.values.is_empty() && submission.template.is_none() => {}
            "stored"
                if submission.template.is_none()
                    && submission.values.len() == 1
                    && submission
                        .values
                        .get("TOKEN")
                        .is_some_and(|v| super::valid_secret_value(v)) => {}
            _ => return Err("Invalid account secret submission".into()),
        }
        // Consume the nonce before awaiting verification. Replays cannot rotate
        // credentials, and account values never enter SecretStore's environment.
        inner
            .pending
            .take()
            .ok_or("Unknown or expired secret form")?
    };
    let mut pending = pending;
    let sink = pending.sink.take().ok_or("Missing account sink")?;
    let result = if submission.status == "declined" {
        Ok(())
    } else {
        let token = submission
            .values
            .remove("TOKEN")
            .ok_or("Missing account credential")?;
        match sink {
            Request::Add { account } => accounts::add_account(account, token).await.map(|_| ()),
            Request::Rotate { id } => {
                let result = accounts::set_secret(id.clone(), token).await;
                if result.is_ok() {
                    state.github.ghe_state.remove(&id);
                }
                result.map(|_| ())
            }
        }
    };
    let status = Status {
        names: Vec::new(),
        status: if result.is_err() {
            "failed".into()
        } else {
            submission.status.clone()
        },
    };
    if let Some(tx) = pending.response.take() {
        let _ = tx.send(status.clone());
    }
    // Provider/storage errors are intentionally not reflected to either webview.
    result.map_err(|_| "Account verification or storage failed".to_string())?;
    Ok(status)
}
