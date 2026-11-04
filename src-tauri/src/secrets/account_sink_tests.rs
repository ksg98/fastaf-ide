//! Account-entry invariants at the native/store and HTTP boundaries.
use super::*;
use crate::accounts::{self, AuthKind, NewAccount, ProviderDescriptor, VerifyRequest};
use std::sync::Arc;
fn isolated_config() -> (tempfile::TempDir, impl Drop) {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    (dir, guard)
}

fn input(provider: &str, host: &str) -> NewAccount {
    NewAccount {
        provider: provider.into(),
        host: host.into(),
        kind: AuthKind::Bearer,
        label: "Private account".into(),
        username: None,
    }
}

fn open(store: &SecretStore, request: account_sink::Request) -> Form {
    let form = store
        .open_with_sink(account_sink::form().unwrap(), Some(request))
        .unwrap();
    // Production forms::ask_with_sink registers this label before creating the
    // window; Tauri supplies the actual caller label to secret_form_submit.
    *store.window.lock() = Some(format!("secret-{}", form.id));
    form
}

fn submission(form: &Form, token: &str) -> Submission {
    Submission {
        nonce: form.nonce.clone(),
        status: "stored".into(),
        values: BTreeMap::from([("TOKEN".into(), token.into())]),
        template: None,
    }
}

async fn provider(id: &str) -> (String, tokio::task::JoinHandle<()>) {
    accounts::register_provider(
        id,
        ProviderDescriptor {
            id: id.into(),
            label: "Owned account entry test protocol".into(),
            kinds: vec![AuthKind::Bearer],
            verify: VerifyRequest {
                path: "/identity".into(),
                login_pointer: "/name".into(),
            },
        },
    )
    .unwrap();
    // This is our generic descriptor protocol, not an invented Jira/GitLab fixture.
    let app = axum::Router::new().route(
        "/identity",
        axum::routing::get(|headers: axum::http::HeaderMap| async move {
            assert!(
                headers["authorization"]
                    .to_str()
                    .unwrap()
                    .starts_with("Bearer ")
            );
            axum::Json(serde_json::json!({"name":"verified-entry-user"}))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (host, server)
}

// Catches: token returned in an IPC/HTTP response or retained for secret.run.
#[tokio::test]
async fn account_secret_never_crosses_ipc_to_webview() {
    let (_dir, _guard) = isolated_config();
    let (host, server) = provider("a2c-non-echo").await;
    let state = crate::state::tests_support::make_test_app_state();
    let store = &state.secrets;
    let form = open(
        store,
        account_sink::Request::Add {
            account: input("a2c-non-echo", &host),
        },
    );
    assert!(form.mobile_url.is_none());
    let (tx, rx) = tokio::sync::oneshot::channel();
    store.inner.lock().pending.as_mut().unwrap().response = Some(tx);
    let reply = account_sink::submit_native(
        &state,
        &format!("secret-{}", form.id),
        submission(&form, "a2c-secret-sentinel"),
    )
    .await
    .unwrap();
    assert_eq!(reply.status, "stored");
    let launched = rx.await.unwrap();
    let rows = accounts::list_accounts(Some("a2c-non-echo"), None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].account.login.as_deref(),
        Some("verified-entry-user")
    );
    assert_eq!(
        crate::credentials::get(crate::credentials::Credential::AccountToken(
            &rows[0].account.id
        ))
        .unwrap()
        .as_deref(),
        Some("a2c-secret-sentinel")
    );
    for json in [
        serde_json::to_string(&reply).unwrap(),
        serde_json::to_string(&launched).unwrap(),
        serde_json::to_string(&rows).unwrap(),
        serde_json::to_string(&form).unwrap(),
    ] {
        assert!(!json.contains("a2c-secret-sentinel"));
    }
    assert!(store.environment(&["TOKEN".into()]).is_err());
    assert!(
        account_sink::submit_native(
            &state,
            &format!("secret-{}", form.id),
            submission(&form, "replay")
        )
        .await
        .is_err()
    );
    // Rotation uses the same owner service and does not create another account.
    *store.window.lock() = None;
    let rotated = open(
        store,
        account_sink::Request::Rotate {
            id: rows[0].account.id.clone(),
        },
    );
    account_sink::submit_native(
        &state,
        &format!("secret-{}", rotated.id),
        submission(&rotated, "a2c-rotated-sentinel"),
    )
    .await
    .unwrap();
    assert_eq!(
        accounts::list_accounts(Some("a2c-non-echo"), None)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        crate::credentials::get(crate::credentials::Credential::AccountToken(
            &rows[0].account.id
        ))
        .unwrap()
        .as_deref(),
        Some("a2c-rotated-sentinel")
    );
    assert!(store.environment(&["TOKEN".into()]).is_err());
    assert!(
        store.tools_blocked(),
        "inspection remains blocked until native destruction"
    );
    server.abort();
    accounts::unregister_providers("a2c-non-echo");
}

// Catches: any webview or a browser knowing the nonce submitting into the vault.
#[tokio::test]
async fn secret_form_rejects_foreign_window_label() {
    use axum::{body::Body, extract::ConnectInfo, http::Request};
    use tower::ServiceExt;
    let (_dir, _guard) = isolated_config();
    let (host, server) = provider("a2c-native").await;
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let form = open(
        &state.secrets,
        account_sink::Request::Add {
            account: input("a2c-native", &host),
        },
    );
    for label in ["main", "panel-foreign", "secret-foreign"] {
        let error =
            account_sink::submit_native(&state, label, submission(&form, "a2c-native-token"))
                .await
                .err()
                .unwrap();
        assert!(error.contains("private native window"));
    }
    let router = crate::mcp_http::build_router(state.clone(), false, true).layer(axum::Extension(
        ConnectInfo("127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap()),
    ));
    for (method, path, body, expected) in [
        ("GET", format!("/secrets/forms/{}", form.nonce), String::new(), 404),
        ("POST", "/secrets/forms/submit".into(), serde_json::json!({"nonce":form.nonce,"status":"stored","values":{"TOKEN":"a2c-native-token"},"template":null}).to_string(), 400),
    ] {
        let response = router.clone().oneshot(Request::builder().method(method).uri(path).header("content-type", "application/json").body(Body::from(body)).unwrap()).await.unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let bytes = axum::body::to_bytes(response.into_body(), 8192).await.unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("a2c-native-token"));
    }
    assert!(
        accounts::list_accounts(Some("a2c-native"), None)
            .unwrap()
            .is_empty()
    );
    // Rejections do not consume the legitimate request.
    account_sink::submit_native(
        &state,
        &format!("secret-{}", form.id),
        submission(&form, "a2c-native-token"),
    )
    .await
    .unwrap();
    assert_eq!(
        accounts::list_accounts(Some("a2c-native"), None)
            .unwrap()
            .len(),
        1
    );
    server.abort();
    accounts::unregister_providers("a2c-native");
}

// Catches: partial account with empty secret after decline, close, or invalid input.
#[tokio::test]
async fn cancelled_form_writes_nothing() {
    let (dir, _guard) = isolated_config();
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let request = || account_sink::Request::Add {
        account: input("github", "https://cancelled.example.test"),
    };
    let form = open(&state.secrets, request());
    assert!(
        account_sink::submit_native(
            &state,
            &format!("secret-{}", form.id),
            submission(&form, "")
        )
        .await
        .is_err()
    );
    let mut decline = Submission::declined();
    decline.nonce = form.nonce.clone();
    let reply = account_sink::submit_native(&state, &format!("secret-{}", form.id), decline)
        .await
        .unwrap();
    assert_eq!(reply.status, "declined");
    *state.secrets.window.lock() = None;
    let closed = open(&state.secrets, request());
    forms::cancel(&state, &closed.id);
    assert!(
        account_sink::submit_native(
            &state,
            &format!("secret-{}", closed.id),
            submission(&closed, "never-persist")
        )
        .await
        .is_err()
    );
    assert!(!dir.path().join("accounts.json").exists());
    assert_eq!(
        crate::credentials::get(crate::credentials::Credential::AccountToken(
            "cancelled.example.test"
        ))
        .unwrap(),
        None
    );
    assert!(state.secrets.environment(&["TOKEN".into()]).is_err());
}

// Catches: a provider validation error consuming the reply but leaving a partial account.
#[tokio::test]
async fn invalid_account_notifies_launcher_without_writing() {
    let (dir, _guard) = isolated_config();
    let state = crate::state::tests_support::make_test_app_state();
    let store = &state.secrets;
    let form = open(
        store,
        account_sink::Request::Add {
            account: input("github", "https://github.com"),
        },
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    store.inner.lock().pending.as_mut().unwrap().response = Some(tx);
    let error = account_sink::submit_native(
        &state,
        &format!("secret-{}", form.id),
        submission(&form, "a2c-rejected-token"),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error, "Account verification or storage failed");
    assert_eq!(rx.await.unwrap().status, "failed");
    assert!(!dir.path().join("accounts.json").exists());
}

// Catches: a metadata-only refusal surfacing as a generic failure after the user typed a token.
#[tokio::test]
async fn request_refuses_invalid_account_with_cause_and_opens_no_form() {
    let (_dir, _guard) = isolated_config();
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let error = account_sink::request(
        &state,
        account_sink::Request::Add {
            account: input("github", "https://github.com"),
        },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error, "github.com uses device-flow login, not a PAT");
    assert!(state.secrets.inner.lock().pending.is_none());
}
