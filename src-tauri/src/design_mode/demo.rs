//! Opt-in end-to-end pilot demo: real extension -> native host -> idle gate -> PTY receiver.
use crate::state::PtySession;
use std::sync::{Arc, atomic::AtomicBool};

// Catches: the sidebar/native/queue path looking successful while no bytes reach a PTY.
#[tokio::test]
#[ignore = "requires an owned CFT profile, fixture server and TUIC_DESIGN_DEMO_DIR/TUIC_DESIGN_BRIDGE"]
async fn two_commented_picks_reach_a_test_agent_pty() {
    let output = std::path::PathBuf::from(
        std::env::var_os("TUIC_DESIGN_DEMO_DIR").expect("demo output directory"),
    );
    assert!(output.is_absolute());
    std::fs::create_dir_all(&output).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let scratch = tempfile::Builder::new()
        .prefix("dm2-")
        .tempdir_in(crate::test_support::short_socket_test_temp_root())
        .unwrap();
    let socket = scratch.path().join("s");
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    *state.bound_socket_path.write() = socket.clone();
    let sid = "design-demo-agent";
    let pair = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let receipt = output.join("test-agent-pty.txt");
    let ready = scratch.path().join("ready");
    let mut command = portable_pty::CommandBuilder::new("/usr/bin/python3");
    command.args([
        "-c",
        r#"import os,sys,tty,pathlib
try:
 tty.setraw(0)
 pathlib.Path(sys.argv[2]).write_text('ready')
 data=b''
 while b'\r' not in data:
  data+=os.read(0,4096)
 pathlib.Path(sys.argv[1]).write_bytes(data.lstrip(b'\x15').split(b'\r')[0])
 print('TEST AGENT RECEIVED FEEDBACK',flush=True)
except Exception as error:
 print(error,flush=True)
 raise
"#,
    ]);
    command.arg(&receipt);
    command.arg(&ready);
    command.cwd(root);
    let child = pair.slave.spawn_command(command).unwrap();
    let writer = pair.master.take_writer().unwrap();
    state.session_maps.sessions.insert(
        sid.into(),
        parking_lot::Mutex::new(PtySession {
            launch_receipt: None,
            writer: Arc::new(parking_lot::Mutex::new(writer)),
            master: pair.master,
            _child: child,
            paused: Arc::new(AtomicBool::new(false)),
            worktree: None,
            initial_cwd: Some(root.to_string_lossy().into_owned()),
            cwd: Some(root.to_string_lossy().into_owned()),
            display_name: Some("Design Mode test agent (PTY receiver)".into()),
            display_name_is_custom: true,
            display_name_from_spawn: false,
            is_remote: false,
            shell: "/usr/bin/python3".into(),
        }),
    );
    crate::test_support::agent_session(&state, sid, crate::pty::SHELL_IDLE);
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let app = crate::mcp_http::build_router(state.clone(), false, true);
    let server = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service())
            .await
            .unwrap();
    });
    while !ready.exists() {
        tokio::task::yield_now().await;
    }
    let result = tokio::process::Command::new(crate::cli::resolve_cli("node"))
        .arg(root.join("scripts/design-mode-demo.mjs"))
        .arg(&socket)
        .arg(root)
        .arg(&output)
        .env("TUIC_DESIGN_DEMO_SESSION", sid)
        .output()
        .await
        .unwrap();
    server.abort();
    if let Some((_, session)) = state.session_maps.sessions.remove(sid) {
        let _ = session.lock()._child.kill();
    }
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let text = std::fs::read_to_string(receipt).unwrap();
    assert!(text.contains("Give this button more breathing room"));
    assert!(text.contains("Make the heading easier to scan"));
    assert!(output.join("two-commented-picks.png").exists());
}
