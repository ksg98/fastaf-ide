#![cfg(unix)]
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Command, Stdio};

fn install(dir: &Path) -> std::path::PathBuf {
    let repo = dir.join("repo");
    std::fs::create_dir(&repo).unwrap();
    assert!(
        Command::new("git")
            .arg("init")
            .arg(&repo)
            .output()
            .unwrap()
            .status
            .success()
    );
    let socket = dir.join("s");
    let listener = UnixListener::bind(&socket).unwrap();
    let health = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        let n = stream.read(&mut request).unwrap();
        assert!(String::from_utf8_lossy(&request[..n]).starts_with("GET /health "));
        let body = r#"{"instance_id":"design-test"}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });
    let profile = dir.join("profile");
    let result = Command::new(env!("CARGO_BIN_EXE_tuic-bridge"))
        .arg("--design-install")
        .arg(&profile)
        .arg(&repo)
        .arg(&socket)
        .arg("launching-session")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    health.join().unwrap();
    profile
}
fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(tuic_test_support::short_socket_test_temp_root()).unwrap()
}
// Catches: installer omitting the manifest, admitting another origin, or naming an absent executable.
#[test]
fn design_mode_installs_a_manifest_pinned_to_its_extension_and_executable() {
    let dir = scratch();
    let profile = install(dir.path());
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(profile.join("NativeMessagingHosts/com.tuic.design_mode.json")).unwrap(),
    )
    .unwrap();
    let host = profile.join("tuic-design-host/tuic-design-host");
    assert_eq!(manifest["path"], json!(host));
    assert!(host.is_file());
    assert_eq!(manifest["type"], "stdio");
    assert_eq!(
        manifest["allowed_origins"],
        json!(["chrome-extension://eefbgjmmpaimpeaflioojmdipmfchefo/"])
    );
    let binding: Value = serde_json::from_slice(
        &std::fs::read(profile.join("tuic-design-extension/binding.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(binding["sessionId"], "launching-session");
}
// Catches: the host loop bypassing version validation and relaying an incompatible request.
#[test]
fn design_mode_native_host_replies_to_a_framed_version_mismatch() {
    let dir = scratch();
    let profile = install(dir.path());
    // Installation's health listener is gone; a bypass would return an IPC failure instead.
    let mut host = Command::new(profile.join("tuic-design-host/tuic-design-host"))
        .arg("chrome-extension://eefbgjmmpaimpeaflioojmdipmfchefo/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let request =
        serde_json::to_vec(&json!({"id":"old-client","version":"1.0.0","action":"hello"})).unwrap();
    let mut input = host.stdin.take().unwrap();
    input
        .write_all(&(request.len() as u32).to_ne_bytes())
        .unwrap();
    input.write_all(&request).unwrap();
    drop(input);
    let output = host.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let length = u32::from_ne_bytes(output.stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(output.stdout.len(), length + 4);
    let reply: Value = serde_json::from_slice(&output.stdout[4..]).unwrap();
    assert_eq!(reply["id"], "old-client");
    assert_eq!(reply["ok"], false);
    assert_eq!(
        reply["error"],
        "Design Mode version mismatch; reinstall the extension"
    );
}

fn native_send(input: &mut impl Write, body: Value) {
    let bytes = serde_json::to_vec(&body).unwrap();
    input
        .write_all(&(bytes.len() as u32).to_ne_bytes())
        .unwrap();
    input.write_all(&bytes).unwrap();
    input.flush().unwrap();
}
fn native_read(output: &mut impl Read) -> Value {
    let mut size = [0; 4];
    output.read_exact(&mut size).unwrap();
    let mut bytes = vec![0; u32::from_ne_bytes(size) as usize];
    output.read_exact(&mut bytes).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
fn ipc_request(stream: &mut std::os::unix::net::UnixStream) -> (String, Value) {
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(20)))
        .unwrap();
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let n = stream.read(&mut chunk).unwrap();
        assert!(n > 0);
        bytes.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&bytes);
        if let Some((header, body)) = text.split_once("\r\n\r\n") {
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|v| v.parse::<usize>().ok())
                })
                .unwrap_or(0);
            if body.len() >= length {
                return (
                    header.lines().next().unwrap().into(),
                    if length == 0 {
                        Value::Null
                    } else {
                        serde_json::from_str(body).unwrap()
                    },
                );
            }
        }
    }
}
fn ipc_reply(stream: &mut impl Write, result: Value) {
    let text = result.to_string();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{text}",
        text.len()
    )
    .unwrap();
}

// Catches: command_next serializing the native port so a correlated command_reply never reaches IPC.
#[test]
fn design_mode_real_native_port_preserves_command_reply_correlation_and_disconnect() {
    let dir = scratch();
    let profile = install(dir.path());
    // The installer listener has closed, but Unix socket names persist until unlinked.
    std::fs::remove_file(dir.path().join("s")).unwrap();
    let listener = UnixListener::bind(dir.path().join("s")).unwrap();
    let repo = dir.path().join("repo").canonicalize().unwrap();
    let expected_repo = repo.clone();
    let server = std::thread::spawn(move || {
        let mut requests = 0;
        while requests < 3 {
            let (mut stream, _) = listener.accept().unwrap();
            let (path, body) = ipc_request(&mut stream);
            if path.starts_with("GET /health ") {
                ipc_reply(&mut stream, json!({"instance_id":"design-test"}));
                continue;
            }
            assert!(path.starts_with("POST /design-mode/extension "));
            assert_eq!(body["repoPath"], json!(expected_repo));
            match body["action"].as_str().unwrap() {
                "command_next" => ipc_reply(
                    &mut stream,
                    json!({"ok":true,"result":{"kind":"browser_command","requestId":"browser-42","action":"navigate","sessionId":"agent","args":{"url":"http://localhost:5173/fixture"}}}),
                ),
                "command_reply" => {
                    assert_eq!(body["requestId"], "browser-42");
                    assert_eq!(
                        body["reply"],
                        json!({"ok":true,"result":{"url":"http://localhost:5173/fixture"}})
                    );
                    ipc_reply(&mut stream, json!({"ok":true,"result":{"accepted":true}}));
                }
                "command_disconnect" => ipc_reply(&mut stream, json!({"ok":true,"result":null})),
                action => panic!("unexpected {action}"),
            }
            requests += 1;
        }
    });
    let mut host = Command::new(profile.join("tuic-design-host/tuic-design-host"))
        .arg("chrome-extension://eefbgjmmpaimpeaflioojmdipmfchefo/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = host.stdin.take().unwrap();
    let mut output = host.stdout.take().unwrap();
    native_send(
        &mut input,
        json!({"id":"receive-1","version":"2.0.0","repoPath":repo,"action":"command_next"}),
    );
    let command = native_read(&mut output);
    assert_eq!(command["id"], "receive-1");
    assert_eq!(command["result"]["requestId"], "browser-42");
    assert_eq!(command["result"]["action"], "navigate");
    native_send(
        &mut input,
        json!({"id":"reply-1","version":"2.0.0","repoPath":repo,"action":"command_reply","requestId":command["result"]["requestId"],"reply":{"ok":true,"result":{"url":"http://localhost:5173/fixture"}}}),
    );
    let reply = native_read(&mut output);
    assert_eq!(reply["id"], "reply-1");
    assert_eq!(reply["result"]["accepted"], true);
    drop(input);
    assert!(host.wait_with_output().unwrap().status.success());
    server.join().unwrap();
}

// Catches: a silent native IPC peer preventing a framed request from returning its bounded error.
#[test]
fn design_mode_real_native_port_times_out_a_mute_ipc_reply() {
    let dir = scratch();
    let profile = install(dir.path());
    // The installer listener has closed, but Unix socket names persist until unlinked.
    std::fs::remove_file(dir.path().join("s")).unwrap();
    let listener = UnixListener::bind(dir.path().join("s")).unwrap();
    let repo = dir.path().join("repo").canonicalize().unwrap();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        assert!(ipc_request(&mut stream).0.starts_with("GET /health "));
        ipc_reply(&mut stream, json!({"instance_id":"design-test"}));
        let (mut stream, _) = listener.accept().unwrap();
        let (_, body) = ipc_request(&mut stream);
        assert_eq!(body["action"], "command_next");
        // Setup has succeeded; the production IPC deadline is the bound under test.
        stop_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap();
    });
    let mut host = Command::new(profile.join("tuic-design-host/tuic-design-host"))
        .arg("chrome-extension://eefbgjmmpaimpeaflioojmdipmfchefo/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = host.stdin.take().unwrap();
    let mut output = host.stdout.take().unwrap();
    native_send(
        &mut input,
        json!({"id":"mute-1","version":"2.0.0","repoPath":repo,"action":"command_next"}),
    );
    let reply = native_read(&mut output);
    assert_eq!(reply["id"], "mute-1");
    assert_eq!(reply["ok"], false);
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("timed out requesting /design-mode/extension")
    );
    stop_tx.send(()).unwrap();
    server.join().unwrap();
    drop(input);
    assert!(host.wait_with_output().unwrap().status.success());
}
