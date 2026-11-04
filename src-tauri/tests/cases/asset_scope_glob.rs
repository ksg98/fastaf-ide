//! Asset-protocol scope semantics, replayed with the same glob options tauri 2.11.5 uses
//! on Unix (`scope/fs.rs`: require_literal_separator + require_literal_leading_dot).
use glob::{MatchOptions, Pattern};

const HOME: &str = "/Users/u";

fn allowed(path: &str) -> bool {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
        .expect("tauri.conf.json parses");
    let scope = conf["app"]["security"]["assetProtocol"]["scope"]
        .as_array()
        .expect("scope is the plain allow-list form (default leading-dot rule)");
    let opts = MatchOptions {
        require_literal_separator: true,
        require_literal_leading_dot: true,
        ..Default::default()
    };
    scope.iter().filter_map(|p| p.as_str()).any(|p| {
        Pattern::new(&p.replace("$HOME", HOME))
            .expect("scope pattern compiles")
            .matches_with(path, opts)
    })
}

#[test]
fn gits_tmp_images_are_served() {
    // Catches: the dot-dir exception not matching the very directory the story needs.
    for p in [
        "/Users/u/Gits/.tmp/boss/a.png",
        "/Users/u/Gits/proj/.tmp/boss/img/a.png",
        "/Users/u/Gits/personal/tuicommander__wt/x/.tmp/a.png",
    ] {
        assert!(allowed(p), "{p} must be served");
    }
}

#[test]
fn other_dot_paths_stay_out_of_scope() {
    // Catches: the new `**/.tmp/**` pattern (or a leading-dot override) exposing credentials.
    for p in [
        "/Users/u/.ssh/id_rsa",
        "/Users/u/.aws/credentials",
        "/Users/u/.claude-private/.credentials.json",
        "/Users/u/Gits/proj/.env",
        "/Users/u/Gits/proj/.git/config",
        "/Users/u/Gits/proj/.git/.tmp/x",
        "/Users/u/Gits/proj/.tmp/.env",
        "/Users/u/Gits/proj/.tmp/.git/config",
        "/Users/u/.tmp/x.png",
        "/Users/u/Library/.tmp/x.png",
    ] {
        assert!(!allowed(p), "{p} must NOT be served");
    }
}
