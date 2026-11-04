//! Explicit, bounded production-client experiment. No live GitHub or credentials.
//!
//! The API replies are controlled protocol fixtures, not captured account data.
//! The request trace is recorded from real reqwest sends received by loopback TLS.
//! PR-open calls replay the two sends observed by the production frontend fixture.

use super::*;
use axum::{Json, Router, body::to_bytes, extract::Request, http::StatusCode, routing::any};
use std::sync::atomic::{AtomicU16, Ordering};

#[derive(Clone)]
struct Receiver {
    started: Instant,
    trace: Arc<parking_lot::Mutex<Vec<serde_json::Value>>>,
    next_status: Arc<AtomicU16>,
}

impl Receiver {
    fn counts(&self) -> serde_json::Value {
        let trace = self.trace.lock();
        serde_json::json!({
            "rest": trace.iter().filter(|row| row["kind"] == "REST").count(),
            "graphql": trace.iter().filter(|row| row["kind"] == "GraphQL").count(),
        })
    }

    async fn receive(
        self,
        request: Request,
    ) -> (StatusCode, [(String, String); 2], Json<serde_json::Value>) {
        let method = request.method().to_string();
        let path = request.uri().path().to_string();
        let bytes = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
        let query = body["query"].as_str().unwrap_or_default();
        let status = self.next_status.swap(200, Ordering::Relaxed);
        self.trace.lock().push(serde_json::json!({
            "elapsed_seconds": self.started.elapsed().as_secs_f64(),
            "method": method,
            "path": path,
            "kind": if path == "/graphql" { "GraphQL" } else { "REST" },
            "query": query,
            "status": status,
        }));
        let response = if status != 200 {
            serde_json::json!({"message": "Controlled rate-limit response"})
        } else if query.contains("viewer { login }") {
            serde_json::json!({"data": {"viewer": {"login": "fixture"}}})
        } else if query.contains("query PRChecks") {
            serde_json::json!({"data": {"repository": {"pullRequest": {"commits": {"nodes": [
                {"commit": {"statusCheckRollup": {"contexts": {"nodes": [
                    {"__typename": "CheckRun", "name": "fixture-check", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": ""}
                ]}}}}
            ]}}}}})
        } else {
            serde_json::json!({"data": {
                "r0": {
                    "mergeCommitAllowed": true, "squashMergeAllowed": true, "rebaseMergeAllowed": true,
                    "pullRequests": {"nodes": [{
                        "number": 42, "title": "Controlled fixture", "state": "OPEN",
                        "url": "https://github.com/fixture/repository/pull/42",
                        "headRefName": "feature", "headRefOid": "a".repeat(40), "baseRefName": "main",
                        "isDraft": false, "author": {"login": "fixture"}, "labels": {"nodes": []},
                        "additions": 1, "deletions": 0, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                        "createdAt": "2026-10-18T00:00:00Z", "updatedAt": "2026-10-18T00:00:00Z",
                        "commits": {"totalCount": 1, "nodes": []},
                        "reviewThreads": {"nodes": [], "pageInfo": {"hasNextPage": false}}
                    }]},
                    "issues": {"nodes": []}
                },
                "rateLimit": {"cost": 1, "remaining": 4990, "resetAt": "2099-01-01T00:00:00Z"}
            }})
        };
        (
            StatusCode::from_u16(status).unwrap(),
            [
                (
                    "x-ratelimit-remaining".into(),
                    if status == 200 { "4990" } else { "0" }.into(),
                ),
                ("retry-after".into(), "1".into()),
            ],
            Json(response),
        )
    }
}

// Catches: an open breaker still sends HTTP requests, or never permits sends after reset.
// Explicitly ignored because two real poll intervals are a measurement, not a routine gate.
#[tokio::test]
#[ignore = "1995 bounded production-client volume experiment; requires two real poll intervals"]
async fn measure_github_client_fixture_1995() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .unwrap_or_else(|_| assert!(rustls::crypto::CryptoProvider::get_default().is_some()));
    // Recorded by openssl req -x509 with a test-only api.github.com SAN.
    let cert = include_bytes!("fixtures/github_volume/cert.pem");
    let key = include_bytes!("fixtures/github_volume/key.pem");
    let tls = axum_server::tls_rustls::RustlsConfig::from_pem(cert.to_vec(), key.to_vec())
        .await
        .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let receiver = Receiver {
        started: Instant::now(),
        trace: Arc::default(),
        next_status: Arc::new(AtomicU16::new(200)),
    };
    let endpoint = receiver.clone();
    let router = Router::new().fallback(any(move |request| endpoint.clone().receive(request)));
    let server_handle = axum_server::Handle::new();
    let server = tokio::spawn(
        axum_server::from_tcp_rustls(listener, tls)
            .unwrap()
            .handle(server_handle.clone())
            .serve(router.into_make_service()),
    );
    let scratch = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(scratch.path().join("config"));
    let repo_dir = scratch.path().join("repo");
    std::fs::create_dir(&repo_dir).unwrap();
    for args in [
        vec!["init", "--quiet"],
        vec![
            "remote",
            "add",
            "origin",
            "https://github.com/fixture/repository.git",
        ],
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(&repo_dir)
            .output()
            .expect("Git CLI is required for this explicitly selected experiment");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let repo_path = repo_dir.to_string_lossy().into_owned();
    let mut state = crate::state::tests_support::make_test_app_state();
    state.http_client = reqwest::Client::builder()
        .no_proxy()
        .tls_certs_only([reqwest::Certificate::from_pem(cert).unwrap()])
        // Only the socket target changes. Production URLs, methods, auth headers,
        // query generation, parsing, caching and breaker paths remain unchanged.
        .resolve("api.github.com", address)
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    *state.github.token.write() = Some("fixture-not-a-real-token".into());
    state.github.disconnected.store(false, Ordering::Relaxed);
    // Controlled workload: one active repository, visible app, one account.
    // This is not a claim about any live session's active-repository membership.
    state.hot_repo_paths.write().insert(repo_path.clone());
    let state = Arc::new(state);
    let mut events = state.event_bus.subscribe();
    let experiment = async {
        ensure_polling(&state, vec![repo_path.clone()], "all".into(), false);
        // No setup-speed assertion: the outer experiment bound catches a hang.
        loop {
            if let AppEvent::GitHubPrUpdate { statuses, .. } = events.recv().await.unwrap() {
                assert_eq!(
                    statuses.len(),
                    1,
                    "fixture PR must reach the poller consumer"
                );
                break;
            }
        }
        let cold = receiver.counts();
        let idle_start = receiver.counts();
        let idle_clock = Instant::now();
        tokio::time::sleep(BASE_INTERVAL + Duration::from_millis(200)).await;
        let idle_end = receiver.counts();
        let idle_seconds = idle_clock.elapsed().as_secs_f64();
        let open_start = receiver.counts();
        let open_clock = Instant::now();
        // The real frontend trace has one get_ci_checks on open, none for ten
        // identical snapshots or a stable mounted panel, then one on reopen.
        let checks = crate::github::get_ci_checks_impl(&repo_path, 42, &state).await;
        assert_eq!(checks.len(), 1, "fixture check must reach the PR consumer");
        tokio::time::sleep(BASE_INTERVAL + Duration::from_millis(200)).await;
        let open_end = receiver.counts();
        let open_seconds = open_clock.elapsed().as_secs_f64();
        let reopen_start = receiver.counts();
        crate::github::get_ci_checks_impl(&repo_path, 42, &state).await;
        let reopen_end = receiver.counts();
        stop_poller(&state).await.unwrap();
        let account = crate::github::github_com_account(&state);
        let mut backoff = Vec::new();
        for status in [403, 429] {
            for graphql in [false, true] {
                receiver.next_status.store(status, Ordering::Relaxed);
                let call = || async {
                    if graphql {
                        crate::github::graphql_with_retry(
                            &state,
                            &account,
                            "query { viewer { login } }",
                            serde_json::Value::Null,
                            None,
                        )
                        .await
                        .map(|_| ())
                    } else {
                        crate::github::send_rest_with_breaker(
                            &state,
                            &account,
                            state.http_client.get("https://api.github.com/fixture/rest"),
                        )
                        .await
                        .map(|_| ())
                    }
                };
                assert!(call().await.unwrap_err().starts_with("rate-limit:"));
                let before = receiver.trace.lock().len();
                assert!(call().await.unwrap_err().starts_with("rate-limit:"));
                assert_eq!(
                    receiver.trace.lock().len(),
                    before,
                    "backoff must stop the send"
                );
                tokio::time::sleep(Duration::from_millis(1100)).await;
                call()
                    .await
                    .expect("send resumes after the fixture retry-after expires");
                assert_eq!(receiver.trace.lock().len(), before + 1);
                backoff.push(serde_json::json!({"status":status,"kind":if graphql {"GraphQL"}else{"REST"},"blocked_sends":0,"post_reset_sends":1}));
            }
        }
        println!(
            "GITHUB_VOLUME_1995 {}",
            serde_json::json!({
                "cold_start":cold,
                "idle":{"seconds":idle_seconds,"before":idle_start,"after":idle_end},
                "one_pr_open":{"seconds":open_seconds,"before":open_start,"after":open_end},
                "reopen":{"before":reopen_start,"after":reopen_end},
                "backoff":backoff,
                "trace":receiver.trace.lock().clone(),
                "scope":"production Rust poller and client, controlled loopback TLS API; frontend open/reopen workload replayed from recorded client trace"
            })
        );
    };
    let result = tokio::time::timeout(Duration::from_secs(300), experiment).await;
    server_handle.shutdown();
    server.await.unwrap().unwrap();
    result.expect("outer experiment hang bound exceeded");
}
