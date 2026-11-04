#![cfg(unix)]

use std::io::Write;
use std::os::unix::net::UnixListener;
use std::process::Command;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

// Catches: CLI --instance/env routing to the default socket, or ignoring TUIC_SOCKET.
#[test]
fn named_instance_cli_reaches_its_socket_and_override_wins() {
    let root = tuic_test_support::short_socket_test_temp_root();
    let dir = tempfile::Builder::new()
        .prefix("ipc")
        .tempdir_in(root)
        .unwrap();
    let named = dir.path().join("tuic-mcp-1953e60b4e4d5340.sock");
    let explicit = dir.path().join("override.sock");
    for mode in ["flag", "env", "override"] {
        let path = if mode == "override" {
            &explicit
        } else {
            &named
        };
        let listener = UnixListener::bind(path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = stop.clone();
        let server = std::thread::spawn(move || {
            let mut seen = Vec::new();
            while !server_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let request = tuic_test_support::read_http_request(&mut stream).unwrap();
                        seen.push(request.request_line);
                        let body = r#"[{"marker":"named-instance"}]"#;
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        )
                        .unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(5))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
            seen
        });
        let mut command = Command::new(env!("CARGO_BIN_EXE_fastaf-cli"));
        command
            .env_remove("TUIC_SOCKET")
            .env_remove("TUIC_APP_INSTANCE")
            .env("TMPDIR", dir.path());
        if mode == "flag" {
            command.args(["--instance", "ipc-cli-regression"]);
            // Explicit selection must override even an invalid inherited env.
            command.env("TUIC_APP_INSTANCE", "INVALID");
        } else {
            command.env("TUIC_APP_INSTANCE", "ipc-cli-regression");
        }
        if mode == "override" {
            command.env("TUIC_SOCKET", path);
        }
        let output = command.args(["ls", "--json"]).output().unwrap();
        stop.store(true, Ordering::Relaxed);
        let seen = server.join().unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(
            output.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("named-instance"),
            "{mode}"
        );
        assert!(
            seen.iter().any(|line| line == "GET /sessions HTTP/1.1"),
            "{mode}: {seen:?}"
        );
    }
}

// Catches: invalid instance silently falling back to Boss's default namespace.
#[test]
fn named_instance_cli_rejects_invalid_selection_before_connecting() {
    let output = Command::new(env!("CARGO_BIN_EXE_fastaf-cli"))
        .args(["--instance", "../escape", "ls", "--json"])
        .env_remove("TUIC_APP_INSTANCE")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Invalid application instance"));
}
