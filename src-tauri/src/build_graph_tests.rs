//! Real local TLS handshakes catch provider/transport regressions after feature trimming.

use axum::{Router, extract::ws::WebSocketUpgrade, routing::get};
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::{CertificateDer, pem::PemObject};
use std::sync::Arc;

// Catches: disabling AWS-LC also disables TLS or leaves clients without a provider.
#[tokio::test]
async fn ring_only_build_keeps_https_and_wss_working() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .unwrap_or_else(|_| assert!(rustls::crypto::CryptoProvider::get_default().is_some()));
    // Recorded from openssl req -x509, not a hand-written external-system fixture.
    let cert = include_bytes!("fixtures/build_graph/cert.pem");
    let key = include_bytes!("fixtures/build_graph/key.pem");
    let tls = axum_server::tls_rustls::RustlsConfig::from_pem(cert.to_vec(), key.to_vec())
        .await
        .expect("recorded test certificate");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let routes = Router::new()
        .route("/", get(|| async { "ring HTTPS" }))
        .route(
            "/ws",
            get(|upgrade: WebSocketUpgrade| async {
                upgrade.on_upgrade(|mut socket| async move {
                    if let Some(Ok(message)) = socket.recv().await {
                        socket.send(message).await.expect("echo frame");
                    }
                })
            }),
        );
    let handle = axum_server::Handle::new();
    let server = tokio::spawn(
        axum_server::from_tcp_rustls(listener, tls)
            .unwrap()
            .handle(handle.clone())
            .serve(routes.into_make_service()),
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .tls_certs_only([reqwest::Certificate::from_pem(cert).unwrap()])
        .build()
        .unwrap();
    let text = client
        .get(format!("https://{address}/"))
        .send()
        .await
        .expect("HTTPS handshake")
        .text()
        .await
        .unwrap();
    assert_eq!(text, "ring HTTPS");

    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(cert).unwrap())
        .unwrap();
    let client_tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let (mut socket, _) = tokio_tungstenite::connect_async_tls_with_config(
        format!("wss://{address}/ws"),
        None,
        false,
        Some(tokio_tungstenite::Connector::Rustls(Arc::new(client_tls))),
    )
    .await
    .expect("WSS handshake");
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "ring WSS".into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap().into_text().unwrap(),
        "ring WSS"
    );
    handle.shutdown();
    server.await.unwrap().unwrap();
}
