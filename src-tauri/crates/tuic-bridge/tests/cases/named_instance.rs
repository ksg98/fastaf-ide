#![cfg(unix)]

use std::io::Write;
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

// Catches: bridge connecting/falling back to another instance instead of the selected socket.
#[test]
fn named_instance_bridge_reaches_its_socket_and_override_wins() {
    let root = tuic_test_support::short_socket_test_temp_root();
    let dir = tempfile::Builder::new()
        .prefix("ipc")
        .tempdir_in(root)
        .unwrap();
    for mode in ["flag", "env", "fallback", "override"] {
        let path = dir.path().join(match mode {
            "override" => "override.sock",
            "fallback" => "tuic-mcp-b199f45760a9ee6c-123.sock",
            _ => "tuic-mcp-b199f45760a9ee6c.sock",
        });
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = stop.clone();
        let server = std::thread::spawn(move || {
            let mut seen = Vec::new();
            while !server_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let request = match tuic_test_support::read_http_request(&mut stream) {
                            Ok(request) => request,
                            Err(_) => continue,
                        };
                        seen.push(request.request_line);
                        let body = r#"{"jsonrpc":"2.0","id":0,"result":{}}"#;
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nMcp-Session-Id: NamedPeer\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(5))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
            seen
        });
        let mut command = Command::new(env!("CARGO_BIN_EXE_tuic-bridge"));
        command
            .env_remove("TUIC_SOCKET")
            .env_remove("TUIC_APP_INSTANCE")
            .env("TMPDIR", dir.path())
            .stdin(Stdio::null());
        if mode == "flag" {
            command.args(["--instance", "ipc-bridge-regression"]);
            command.env("TUIC_APP_INSTANCE", "INVALID");
        } else {
            command.env("TUIC_APP_INSTANCE", "ipc-bridge-regression");
        }
        if mode == "override" {
            command.env("TUIC_SOCKET", &path);
        }
        let output = command.output().unwrap();
        stop.store(true, Ordering::Relaxed);
        let seen = server.join().unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(
            output.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("connected to TUIC"),
            "{mode}"
        );
        assert!(
            seen.iter().any(|line| line == "POST /mcp HTTP/1.1"),
            "{mode}: {seen:?}; binary: {}; stderr: {}",
            env!("CARGO_BIN_EXE_tuic-bridge"),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            seen.iter().any(|line| line == "DELETE /mcp HTTP/1.1"),
            "{mode}: {seen:?}; binary: {}; stderr: {}",
            env!("CARGO_BIN_EXE_tuic-bridge"),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
