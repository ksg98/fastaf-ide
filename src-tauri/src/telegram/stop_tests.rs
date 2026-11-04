//! Stop payloads model the published Bot API schema, not captured Telegram traffic.
//! Native input state is derived through the production bookkeeping entry point.
use super::*;
use crate::telegram::{runtime::Runtime, tool::Input};

struct Session(Arc<crate::state::AppState>);
impl Drop for Session {
    fn drop(&mut self) {
        if let Some((_, session)) = self.0.session_maps.sessions.remove(PEER) {
            let mut session = session.lock();
            session._child.kill().unwrap();
            session._child.wait().unwrap();
        }
    }
}

async fn bound(paths: Paths, server: &FakeServer) -> (Runtime, Session, Arc<Mutex<Vec<u8>>>, i64) {
    let mut runtime = outbound_tests::runtime(paths, server.address).await;
    let bytes = crate::test_support::insert_recording_session(&runtime.state, PEER);
    crate::test_support::agent_session(&runtime.state, PEER, crate::pty::SHELL_BUSY);
    crate::pty::note_submitted_input(&runtime.state, PEER);
    runtime
        .track(
            PendingMail {
                id: "request".into(),
                recipient: PEER.into(),
                content: json!({"chat_id":"1111111"}).to_string(),
            },
            super::streaming::Recipient::capture(&runtime.state, PEER),
        )
        .unwrap();
    let draft = runtime
        .tool(
            PEER,
            "target-mcp",
            Input::Begin {
                request_id: "request".into(),
            },
        )
        .await
        .unwrap()["draft_id"]
        .as_i64()
        .unwrap();
    let session = Session(runtime.state.clone());
    (runtime, session, bytes, draft)
}

fn stop(chat: i64, draft: i64) -> Value {
    json!({"stopped_message_generation":{"chat":{"id":chat,"type":"private"},"draft_id":draft}})
}

// Catches: a wrong chat/draft or duplicate Stop interrupts another message;
// feeding the valid Escape into the line editor swallows replacement text/CR.
#[tokio::test]
async fn stop_is_one_shot_for_the_bound_chat_draft_and_preserves_next_input() {
    let (_dir, paths) = setup();
    let server =
        FakeServer::start(vec![(StatusCode::OK, json!({"ok":true,"result":true})); 2]).await;
    let (mut runtime, _session, bytes, draft) = bound(paths.clone(), &server).await;
    write_private(&paths.file("allowed_chat_ids"), "1111111\n2222222\n");
    for invalid in [
        stop(2222222, draft),
        stop(1111111, draft + 1),
        json!({"stopped_message_generation":{"chat":{"id":1111111,"type":"group"},"draft_id":draft}}),
    ] {
        runtime.update(invalid).await.unwrap();
        assert!(bytes.lock().unwrap().is_empty());
        assert!(runtime.outbound.active.is_some());
    }
    let epoch = runtime
        .state
        .session_state_with_shell(PEER)
        .unwrap()
        .turn_epoch;
    runtime.update(stop(1111111, draft)).await.unwrap();
    assert_eq!(*bytes.lock().unwrap(), b"\x1b");
    assert!(runtime.outbound.active.is_none());
    crate::mcp_http::session::write_pty_input(&runtime.state, PEER, "replacement").unwrap();
    crate::mcp_http::session::write_pty_input(&runtime.state, PEER, "\r").unwrap();
    runtime.update(stop(1111111, draft)).await.unwrap();
    assert_eq!(*bytes.lock().unwrap(), b"\x1breplacement\r");
    assert_eq!(
        runtime
            .state
            .session_state_with_shell(PEER)
            .unwrap()
            .turn_epoch,
        epoch + 1
    );
    assert!(
        runtime
            .state
            .session_maps
            .input_buffers
            .get(PEER)
            .unwrap()
            .lock()
            .is_empty()
    );
    runtime
        .track(
            PendingMail {
                id: "next".into(),
                recipient: PEER.into(),
                content: json!({"chat_id":"1111111"}).to_string(),
            },
            super::streaming::Recipient::capture(&runtime.state, PEER),
        )
        .unwrap();
    let next = runtime
        .tool(
            PEER,
            "target-mcp",
            Input::Begin {
                request_id: "next".into(),
            },
        )
        .await
        .unwrap()["draft_id"]
        .as_i64()
        .unwrap();
    runtime.update(stop(1111111, draft)).await.unwrap();
    assert_eq!(*bytes.lock().unwrap(), b"\x1breplacement\r");
    assert_eq!(runtime.outbound.active.as_ref().unwrap().draft, next);
    runtime.update(stop(1111111, next)).await.unwrap();
    assert_eq!(*bytes.lock().unwrap(), b"\x1breplacement\r\x1b");
}

// Catches: the critic round-3 race appends old Escape after replacement bytes,
// before delayed bookkeeping, then misclassifies the replacement Enter.
#[tokio::test]
async fn stop_cannot_cross_native_replacement_before_delayed_bookkeeping() {
    for parts in [vec!["replacement\r"], vec!["replacement", "\r"]] {
        let (_dir, paths) = setup();
        let server =
            FakeServer::start(vec![(StatusCode::OK, json!({"ok":true,"result":true}))]).await;
        let (mut runtime, _session, bytes, draft) = bound(paths, &server).await;
        let epoch = runtime
            .state
            .session_state_with_shell(PEER)
            .unwrap()
            .turn_epoch;
        // Pause the native HTTP/IPC caller at its existing post-write boundary.
        // The split case delivers text first, leaving Enter for after Stop.
        runtime
            .state
            .write_pty_parts(PEER, &[parts[0].as_bytes()])
            .unwrap();
        runtime.update(stop(1111111, draft)).await.unwrap();
        assert_eq!(*bytes.lock().unwrap(), parts[0].as_bytes());
        crate::mcp_http::session::apply_input_bookkeeping(&runtime.state, PEER, parts[0]);
        if parts.len() == 2 {
            crate::mcp_http::session::write_pty_input(&runtime.state, PEER, parts[1]).unwrap();
        }
        assert_eq!(*bytes.lock().unwrap(), b"replacement\r");
        assert_eq!(
            runtime
                .state
                .session_state_with_shell(PEER)
                .unwrap()
                .turn_epoch,
            epoch + 1
        );
        assert!(
            runtime
                .state
                .session_maps
                .input_buffers
                .get(PEER)
                .unwrap()
                .lock()
                .is_empty()
        );
    }
}

// Catches: Stop validates ownership before waiting on a replacement writer,
// then writes an unfenced Escape after that writer has released its mutex.
#[tokio::test]
async fn stop_waiting_on_replacement_writer_cannot_append_escape() {
    struct PausedWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
        entered: Option<std::sync::mpsc::Sender<()>>,
        release: std::sync::mpsc::Receiver<()>,
    }
    impl std::io::Write for PausedWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(bytes);
            if let Some(entered) = self.entered.take() {
                entered.send(()).unwrap();
                self.release.recv().unwrap();
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let (_dir, paths) = setup();
    let server = FakeServer::start(vec![(StatusCode::OK, json!({"ok":true,"result":true}))]).await;
    let (mut runtime, _session, bytes, draft) = bound(paths, &server).await;
    let (entered, observe) = std::sync::mpsc::channel();
    let (release, resume) = std::sync::mpsc::channel();
    runtime
        .state
        .session_maps
        .sessions
        .get(PEER)
        .unwrap()
        .lock()
        .writer = Arc::new(parking_lot::Mutex::new(Box::new(PausedWriter {
        bytes: bytes.clone(),
        entered: Some(entered),
        release: resume,
    })));
    let state = runtime.state.clone();
    let replacement_state = state.clone();
    let replacement = std::thread::spawn(move || {
        replacement_state
            .write_pty_parts(PEER, &[b"replacement\r"])
            .unwrap();
    });
    observe.recv().unwrap();
    let (started, stopping) = std::sync::mpsc::channel();
    let interrupt = std::thread::spawn(move || {
        started.send(()).unwrap();
        runtime.stop(&stop(1111111, draft))
    });
    stopping.recv().unwrap();
    release.send(()).unwrap();
    replacement.join().unwrap();
    assert!(!interrupt.join().unwrap().unwrap());
    crate::mcp_http::session::apply_input_bookkeeping(&state, PEER, "replacement\r");
    assert_eq!(*bytes.lock().unwrap(), b"replacement\r");
}

// Catches: a completed/replaced epoch, revoked chat, lost registration or
// replaced live PTY keeps an old Stop capable of writing to the terminal.
#[tokio::test]
async fn stop_rejects_changed_native_ownership_and_revoked_authorization() {
    for changed in ["epoch", "idle", "registration", "revocation", "exit"] {
        let (_dir, paths) = setup();
        let server =
            FakeServer::start(vec![(StatusCode::OK, json!({"ok":true,"result":true}))]).await;
        let (mut runtime, _session, bytes, draft) = bound(paths.clone(), &server).await;
        match changed {
            "epoch" => crate::pty::note_submitted_input(&runtime.state, PEER),
            "idle" => runtime
                .state
                .session_maps
                .shell_states
                .get(PEER)
                .unwrap()
                .store(crate::pty::SHELL_IDLE, std::sync::atomic::Ordering::Release),
            "registration" => {
                runtime.state.mcp.to_session.remove("target-mcp");
            }
            "revocation" => write_private(&paths.file("allowed_chat_ids"), "2222222\n"),
            "exit" => {
                runtime.state.session_maps.exit_codes.insert(PEER.into(), 0);
            }
            _ => unreachable!(),
        }
        runtime.update(stop(1111111, draft)).await.unwrap();
        assert!(bytes.lock().unwrap().is_empty(), "{changed} Stop escaped");
    }
}

// Catches: paired HTTP input or managed submission omits writer retirement,
// so Stop appends old-turn Escape before replacement bookkeeping advances epoch.
#[tokio::test]
async fn stop_cannot_cross_pair_or_managed_write_before_bookkeeping() {
    struct EnterWriter {
        bytes: Arc<Mutex<Vec<u8>>>,
        entered: std::sync::mpsc::Sender<()>,
    }
    impl std::io::Write for EnterWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes.lock().unwrap().extend_from_slice(bytes);
            if bytes == b"\r" {
                self.entered.send(()).unwrap();
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    for managed in [false, true] {
        let (_dir, paths) = setup();
        let server =
            FakeServer::start(vec![(StatusCode::OK, json!({"ok":true,"result":true}))]).await;
        let (mut runtime, _session, bytes, draft) = bound(paths, &server).await;
        let epoch = runtime
            .state
            .session_state_with_shell(PEER)
            .unwrap()
            .turn_epoch;
        if managed {
            runtime
                .state
                .session_maps
                .shell_states
                .get(PEER)
                .unwrap()
                .store(crate::pty::SHELL_IDLE, std::sync::atomic::Ordering::Release);
            runtime
                .state
                .session_maps
                .silence_states
                .get(PEER)
                .unwrap()
                .lock()
                .confirm_idle();
            assert!(matches!(
                crate::pty::write_agent_submission_to_pty(&runtime.state, PEER, "replacement"),
                crate::pty::AgentSubmissionWrite::Complete { .. }
            ));
            // Ensure Stop cannot be rejected merely because submission started idle.
            runtime
                .state
                .session_maps
                .shell_states
                .get(PEER)
                .unwrap()
                .store(crate::pty::SHELL_BUSY, std::sync::atomic::Ordering::Release);
            runtime.update(stop(1111111, draft)).await.unwrap();
            assert_eq!(*bytes.lock().unwrap(), b"\x15replacement\r");
            crate::mcp_http::session::apply_input_bookkeeping(
                &runtime.state,
                PEER,
                "replacement\r",
            );
        } else {
            let (entered, observe) = std::sync::mpsc::channel();
            runtime
                .state
                .session_maps
                .sessions
                .get(PEER)
                .unwrap()
                .lock()
                .writer = Arc::new(parking_lot::Mutex::new(Box::new(EnterWriter {
                bytes: bytes.clone(),
                entered,
            })));
            let state = runtime.state.clone();
            // Hold the existing line buffer to pause the real pair caller after
            // its writer unlock, before either request can advance the epoch.
            let input = state
                .session_maps
                .input_buffers
                .entry(PEER.into())
                .or_insert_with(|| {
                    parking_lot::Mutex::new(crate::input_line_buffer::InputLineBuffer::new())
                });
            let buffer = input.lock();
            let replacement_state = state.clone();
            let replacement = std::thread::spawn(move || {
                crate::mcp_http::session::write_pty_input_pair(
                    &replacement_state,
                    PEER,
                    "replacement",
                    "\r",
                    Some("claude"),
                )
                .unwrap();
            });
            observe.recv().unwrap();
            // Enter has escaped; acquiring the same mutex proves the pair has
            // released its writer while bookkeeping is still blocked above.
            drop(state.pty_writer(PEER).unwrap().lock());
            assert_eq!(
                state.session_state_with_shell(PEER).unwrap().turn_epoch,
                epoch
            );
            assert!(!runtime.stop(&stop(1111111, draft)).unwrap());
            assert_eq!(*bytes.lock().unwrap(), b"replacement\r");
            drop(buffer);
            drop(input);
            replacement.join().unwrap();
        }
        assert_eq!(
            runtime
                .state
                .session_state_with_shell(PEER)
                .unwrap()
                .turn_epoch,
            epoch + 1
        );
    }
}

// Catches: getUpdates does not subscribe to Stop, or NativeMail silently drops
// the update before the bound runtime; a direct-runtime-only test misses both.
#[tokio::test]
async fn polled_stop_reaches_native_runtime_and_advances_the_cursor_once() {
    let (_dir, paths) = setup();
    write_private(&paths.file("next_offset"), "7\n");
    let server = FakeServer::start(vec![(StatusCode::OK, json!({"ok":true,"result":true}))]).await;
    let (runtime, _session, bytes, draft) = bound(paths.clone(), &server).await;
    let mut update = stop(1111111, draft);
    update["update_id"] = json!(7);
    server
        .state
        .lock()
        .unwrap()
        .responses
        .push_back((StatusCode::OK, json!({"ok":true,"result":[update]})));
    let (commands, receive) = tokio::sync::mpsc::channel(10);
    let port = crate::telegram::native::NativeMail::new(commands);
    let worker = tokio::spawn(runtime.run(receive));
    let mut poller =
        crate::telegram::inbound::Inbound::with_loopback(paths.clone(), server.address, port)
            .unwrap();
    let result = poller.poll().await;
    worker.abort();
    assert!(matches!(result.unwrap(), Poll::Accepted(0)));
    assert_eq!(*bytes.lock().unwrap(), b"\x1b");
    assert_eq!(
        std::fs::read_to_string(paths.file("next_offset"))
            .unwrap()
            .trim(),
        "8"
    );
    let requests = server.requests();
    assert_eq!(requests[0].1["can_stop"], true);
    assert!(
        requests[1].1["allowed_updates"]
            .as_array()
            .unwrap()
            .contains(&json!("stopped_message_generation"))
    );
}
