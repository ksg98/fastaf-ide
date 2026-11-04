use super::*;
use axum::{
    Router,
    extract::ws::WebSocketUpgrade,
    response::sse::{Event, Sse},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::{CertificateDer, pem::PemObject};

// Existing openssl-recorded PEM pair, also used by build_graph_tests.
const CERT: &[u8] = include_bytes!("fixtures/build_graph/cert.pem");
const KEY: &[u8] = include_bytes!("fixtures/build_graph/key.pem");

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .tls_certs_only([reqwest::Certificate::from_pem(CERT).unwrap()])
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap()
}

fn start(
    tls: Option<axum_server::tls_rustls::RustlsConfig>,
) -> (
    std::net::SocketAddr,
    Arc<AppState>,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let router = Router::new()
        .route("/", get(|| async { "headless HTTPS" }))
        .route(
            "/events",
            get(|| async {
                Sse::new(futures_util::stream::iter([Ok::<
                    _,
                    std::convert::Infallible,
                >(
                    Event::default().event("ready").data("headless SSE"),
                )]))
            }),
        )
        .route(
            "/ws",
            get(|upgrade: WebSocketUpgrade| async {
                upgrade.on_upgrade(|mut socket| async move {
                    if let Some(Ok(message)) = socket.recv().await {
                        socket.send(message).await.unwrap();
                    }
                })
            }),
        );
    let server = tokio::spawn(serve_remote_listener(listener, router, tls, state.clone()));
    (address, state, server)
}

// Catches: the headless daemon loads a TLS config but serves plaintext instead.
#[tokio::test]
async fn headless_tls_listener_completes_verified_handshake() {
    let tls = axum_server::tls_rustls::RustlsConfig::from_pem(CERT.to_vec(), KEY.to_vec())
        .await
        .unwrap();
    let (address, state, server) = start(Some(tls));
    let response = client().get(format!("https://{address}/")).send().await;
    let text = match response {
        Ok(response) => Ok(response.text().await.unwrap()),
        Err(error) => Err(error),
    };
    let active = state.tls_listener.read().strong_count() > 0;
    server.abort();
    let _ = server.await;
    assert_eq!(
        text.expect("headless TLS listener must complete a verified handshake"),
        "headless HTTPS"
    );
    assert!(active, "diagnostics must reflect the active TLS listener");
    assert_eq!(
        state.tls_listener.read().strong_count(),
        0,
        "stopped listener must not report active TLS"
    );
}

// Catches: TLS serves requests but loses streaming bodies or WebSocket upgrades.
#[tokio::test]
async fn headless_tls_streams_sse_and_websocket_with_legacy_http() {
    let tls = axum_server::tls_rustls::RustlsConfig::from_pem(CERT.to_vec(), KEY.to_vec())
        .await
        .unwrap();
    let (address, _, server) = start(Some(tls));
    let response = client()
        .get(format!("https://{address}/events"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let body = response.text().await.unwrap();
    assert!(body.contains("event: ready\n"), "{body}");
    assert!(body.contains("data: headless SSE\n"), "{body}");

    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(CERT).unwrap())
        .unwrap();
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let (mut socket, _) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio_tungstenite::connect_async_tls_with_config(
            format!("wss://{address}/ws"),
            None,
            false,
            Some(tokio_tungstenite::Connector::Rustls(Arc::new(tls))),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "headless WSS".into(),
        ))
        .await
        .unwrap();
    let message = tokio::time::timeout(std::time::Duration::from_secs(10), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(message.into_text().unwrap(), "headless WSS");
    let plain = client()
        .get(format!("http://{address}/"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        plain.text().await.unwrap(),
        "headless HTTPS",
        "relay and SSH HTTP clients must remain supported"
    );
    server.abort();
    let _ = server.await;
}

// Catches: selecting TLS off accidentally requires TLS or advertises HTTPS.
#[tokio::test]
async fn headless_tls_off_keeps_plain_http() {
    let tls = load_remote_tls(&config::TlsConfig::Off).await.unwrap();
    assert!(tls.is_none());
    let (address, state, server) = start(tls);
    let response = client()
        .get(format!("http://{address}/"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "headless HTTPS");
    assert_eq!(state.tls_listener.read().strong_count(), 0);
    server.abort();
    let _ = server.await;
}

// Catches: malformed or absent PEM is converted to TLS off instead of failing startup.
#[tokio::test]
async fn headless_tls_invalid_pem_fails_configuration() {
    let temp = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let cert = temp.path().join("cert.pem");
    let key = temp.path().join("key.pem");
    std::fs::write(&cert, b"not a certificate").unwrap();
    std::fs::write(&key, KEY).unwrap();
    let config = config::TlsConfig::Manual {
        cert_path: cert.to_string_lossy().into_owned(),
        key_path: key.to_string_lossy().into_owned(),
    };
    let error = load_remote_tls(&config)
        .await
        .expect_err("invalid PEM must fail");
    assert!(
        error.to_string().contains("Invalid TLS cert/key"),
        "{error}"
    );
    std::fs::remove_file(&cert).unwrap();
    let error = load_remote_tls(&config)
        .await
        .expect_err("missing PEM must fail");
    assert!(
        error.to_string().contains("Failed to read TLS cert"),
        "{error}"
    );
}
