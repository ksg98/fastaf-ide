#![cfg(unix)]

use std::path::{Path, PathBuf};

fn checkout(parent: &Path, name: &str) -> PathBuf {
    let root = parent.join(name);
    std::fs::create_dir_all(root.join(".git")).expect("git marker");
    std::fs::create_dir_all(root.join("src-tauri")).expect("Cargo directory");
    std::fs::write(root.join("src-tauri/Cargo.toml"), "[workspace]\n").expect("Cargo marker");
    root
}

#[test]
fn socket_root_is_stable_and_distinct_for_long_checkout_paths() {
    let sandbox = tempfile::tempdir_in(tuic_test_support::test_temp_root()).expect("sandbox");
    let original_dir = std::env::current_dir().expect("working directory");
    let original_root = std::env::var_os("TUIC_TEST_TMP_ROOT");
    let requested = sandbox
        .path()
        .join("a-long-test-root-that-needs-a-short-unix-socket-path");
    // This test binary is run one test per process by Nextest.
    unsafe { std::env::set_var("TUIC_TEST_TMP_ROOT", &requested) };

    // Catches: fallback assuming a Gits ancestor exists or is short enough.
    for parent_name in ["Gits", "checkout-without-gits"] {
        let parent = sandbox.path().join(parent_name);
        let first_checkout = checkout(&parent, "first-checkout");
        let second_checkout = checkout(&parent, "second-checkout");
        std::env::set_current_dir(&first_checkout).expect("first checkout");
        let first = tuic_test_support::short_socket_test_temp_root();
        assert_eq!(first, tuic_test_support::short_socket_test_temp_root());

        std::env::set_current_dir(&second_checkout).expect("second checkout");
        let second = tuic_test_support::short_socket_test_temp_root();
        assert_ne!(
            first, second,
            "parallel checkouts must not share socket scratch"
        );
        for root in [&first, &second] {
            assert!(root.is_dir());
            assert!(root.as_os_str().len() < requested.as_os_str().len());
            let daemon_socket = root.join("sXXXXXX/.mdkb/daemon-hook.sock.4294967295.tmp");
            assert!(daemon_socket.as_os_str().len() + 8 < 104);
            let dir = tempfile::Builder::new()
                .prefix("s")
                .tempdir_in(root)
                .expect("socket directory");
            let socket = dir.path().join(".mdkb/daemon-hook.sock.4294967295.tmp");
            std::fs::create_dir_all(socket.parent().unwrap()).expect("mdkb directory");
            let listener = std::os::unix::net::UnixListener::bind(&socket)
                .expect("bind full mdkb socket path");
            drop(listener);
            drop(dir);
            std::fs::remove_dir(root).expect("remove fake-checkout socket root");
        }
    }

    std::env::set_current_dir(original_dir).expect("restore checkout");
    if let Some(root) = original_root {
        unsafe { std::env::set_var("TUIC_TEST_TMP_ROOT", root) };
    } else {
        unsafe { std::env::remove_var("TUIC_TEST_TMP_ROOT") };
    }
}

#[test]
fn socket_root_leaves_room_for_mdkb_socket_with_longer_home() {
    let root = tuic_test_support::short_socket_test_temp_root();
    let daemon_socket = root.join("sXXXXXX/.mdkb/daemon-hook.sock.4294967295.tmp");
    assert!(
        daemon_socket.as_os_str().len() + 8 < 104,
        "mdkb socket path needs eight bytes of HOME margin: {}",
        daemon_socket.display()
    );
}

// Catches: discarding an explicitly supplied root even when it fits the socket budget.
#[test]
fn socket_root_preserves_a_requested_root_that_fits() {
    let root = tuic_test_support::short_socket_test_temp_root();
    let original_root = std::env::var_os("TUIC_TEST_TMP_ROOT");
    // SAFETY: Nextest runs each test in this binary in a separate process.
    unsafe { std::env::set_var("TUIC_TEST_TMP_ROOT", &root) };
    assert_eq!(tuic_test_support::short_socket_test_temp_root(), root);
    if let Some(original) = original_root {
        unsafe { std::env::set_var("TUIC_TEST_TMP_ROOT", original) };
    } else {
        unsafe { std::env::remove_var("TUIC_TEST_TMP_ROOT") };
    }
}
