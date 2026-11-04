//! Remote listener bind tests: fail-closed address choice, the paused state the
//! status payload reports, and loopback rebinds. Kept out of `mod.rs` because
//! `api_prefixes_cover_every_registered_route` scans that file's non-test half
//! for routes, and these tests register a throwaway `/ping`.

use super::{RemoteBind, RemoteBindState, remote_bind, remote_bind_status, wait_for_address};
use crate::config::ServerConfig;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

fn server(bind_address: &str, ipv6_enabled: bool) -> ServerConfig {
    ServerConfig {
        enabled: true,
        bind_address: bind_address.to_string(),
        ipv6_enabled,
        ..ServerConfig::default()
    }
}

const ALL_V4: IpAddr = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
const LOOPBACK_V4: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const LOOPBACK_V6: IpAddr = IpAddr::V6(Ipv6Addr::LOCALHOST);

// Catches: remote access listening on every network the machine joins
// (café Wi-Fi included) after the user picked one interface.
#[test]
fn a_selected_interface_is_bound_with_loopback_beside_it() {
    let lan: IpAddr = "192.168.1.20".parse().unwrap();
    assert_eq!(
        remote_bind(&server("192.168.1.20", false), false, |_| true),
        RemoteBind {
            primary: lan,
            loopback: vec![LOOPBACK_V4],
            paused_for: None,
        }
    );
    assert_eq!(
        remote_bind(&server(" 192.168.1.20 ", true), false, |_| true).loopback,
        vec![LOOPBACK_V4, LOOPBACK_V6]
    );
}

// Catches: a picked Tailscale address that is not up yet (FastAF started
// before tailscaled) widening to 0.0.0.0, serving the terminals in plaintext
// on the network the user picked Tailscale to avoid.
#[test]
fn a_picked_address_this_machine_lacks_pauses_on_loopback() {
    assert_eq!(
        remote_bind(&server("100.101.102.103", false), false, |_| false),
        RemoteBind {
            primary: LOOPBACK_V4,
            loopback: Vec::new(),
            paused_for: Some("100.101.102.103".to_string()),
        }
    );
    let v6 = remote_bind(&server("fd7a:115c:a1e0::1", true), false, |_| false);
    assert_eq!(v6.primary, LOOPBACK_V4);
    assert_eq!(v6.loopback, vec![LOOPBACK_V6]);
    assert_eq!(v6.paused_for.as_deref(), Some("fd7a:115c:a1e0::1"));
}

// Catches: a hand-edited, unparseable address failing open.
#[test]
fn an_unparseable_address_pauses_rather_than_widening() {
    let bind = remote_bind(&server("not-an-ip", false), false, |_| true);
    assert_eq!(bind.primary, LOOPBACK_V4);
    assert_eq!(bind.paused_for.as_deref(), Some("not-an-ip"));
}

#[test]
fn unset_or_unspecified_keeps_every_interface() {
    for value in ["", "   ", "0.0.0.0"] {
        let bind = remote_bind(&server(value, false), false, |_| false);
        assert_eq!(bind.primary, ALL_V4, "{value:?}");
        assert_eq!(bind.loopback, Vec::<IpAddr>::new(), "{value:?}");
        assert_eq!(bind.paused_for, None, "{value:?}");
    }
    assert_eq!(
        remote_bind(&server("", true), false, |_| true).primary,
        IpAddr::V6(Ipv6Addr::UNSPECIFIED)
    );
}

#[test]
fn loopback_or_agent_test_needs_no_second_listener() {
    let only_loopback = RemoteBind {
        primary: LOOPBACK_V4,
        loopback: Vec::new(),
        paused_for: None,
    };
    assert_eq!(
        remote_bind(&server("127.0.0.1", false), false, |_| true),
        only_loopback
    );
    assert_eq!(
        remote_bind(&server("192.168.1.20", false), true, |_| false),
        only_loopback
    );
}

#[test]
fn the_probe_knows_loopback_is_local_and_a_documentation_address_is_not() {
    assert!(super::address_is_local(LOOPBACK_V4));
    assert!(!super::address_is_local("192.0.2.1".parse().unwrap()));
}

// Catches: a paused listener never rebinding once tailscaled (or a DHCP
// lease) brings the address up, because no other recheck restarts it.
#[tokio::test]
async fn a_paused_listener_wakes_when_its_address_appears() {
    let probes = std::sync::atomic::AtomicUsize::new(0);
    let ip: IpAddr = "100.101.102.103".parse().unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        wait_for_address(ip, std::time::Duration::from_millis(1), |asked| {
            assert_eq!(asked, ip);
            probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 3
        }),
    )
    .await
    .expect("returns once the address is local");
    assert_eq!(probes.load(std::sync::atomic::Ordering::SeqCst), 4);
}

// Catches: a rebind losing localhost access because the outgoing loopback
// task still held the port when the new one bound it once and gave up (R4).
#[tokio::test]
async fn loopback_is_still_served_after_rebinding_twice() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let local = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let svc = || {
        axum::Router::new()
            .route("/ping", axum::routing::get(|| async { "pong" }))
            .into_make_service_with_connect_info::<std::net::SocketAddr>()
    };
    let backoff = std::time::Duration::from_millis(50);
    let mut current = super::spawn_loopback_listener(local, svc(), 40, backoff)
        .await
        .expect("first bind");
    for rebind in 0..2 {
        // A restart aborts the old task and binds again straight away, while
        // the aborted task may not have dropped its socket yet.
        current.abort();
        current = super::spawn_loopback_listener(local, svc(), 40, backoff)
            .await
            .unwrap_or_else(|| panic!("rebind {rebind} lost loopback"));
        let mut stream = tokio::net::TcpStream::connect(local).await.unwrap();
        stream
            .write_all(b"GET /ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        assert!(
            response.starts_with("HTTP/1.1 200"),
            "rebind {rebind}: {response}"
        );
        assert!(response.ends_with("pong"), "rebind {rebind}: {response}");
    }
    current.abort();
}

// Catches: a busy port retried forever, or given up on without retrying.
#[tokio::test]
async fn bind_retrying_waits_for_a_busy_port_and_then_gives_up() {
    let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = held.local_addr().unwrap();
    let backoff = std::time::Duration::from_millis(20);
    assert!(super::bind_retrying(addr, 3, backoff).await.is_err());
    let release = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        drop(held);
    });
    super::bind_retrying(addr, 50, backoff)
        .await
        .expect("binds once the holder lets go");
    release.await.unwrap();
}

// Catches: the Remote Access panel unable to tell "paused" from "listening".
#[test]
fn the_status_payload_names_the_missing_address() {
    let state = crate::state::tests_support::make_test_app_state();
    assert_eq!(
        remote_bind_status(&state),
        serde_json::json!({"remote_bind_state": "off", "remote_bind_address": ""})
    );
    *state.remote_bind.write() =
        RemoteBindState::PausedAddressUnavailable("100.101.102.103".into());
    assert_eq!(
        remote_bind_status(&state),
        serde_json::json!({
            "remote_bind_state": "paused_address_unavailable",
            "remote_bind_address": "100.101.102.103",
        })
    );
    *state.remote_bind.write() = RemoteBindState::Listening;
    assert_eq!(remote_bind_status(&state)["remote_bind_state"], "listening");
}
