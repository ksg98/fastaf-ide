#[allow(dead_code)]
mod build_sidecars;

fn main() {
    // Tauri's generate_context! writes assets into OUT_DIR during macro
    // expansion, and the OUT_DIR that mbx shares is read-only. Keep Cargo's
    // OUT_DIR for this crate only; the environment beats .mbx.toml.
    println!("cargo:rustc-env=MBX_SHARE_OUT_DIR=0");
    if cfg!(feature = "desktop") && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/native_notification.m")
            .flag("-fobjc-arc")
            .flag("-Wno-deprecated-declarations")
            .compile("tuic_native_notification");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rerun-if-changed=src/native_notification.m");
    }
    // Expose git commit hash as BUILD_GIT_HASH for version checks (PWA update detection).
    let hash = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    println!("cargo:rustc-env=BUILD_GIT_HASH={}", hash.trim());

    // Expose target triple for sidecar path resolution at runtime
    println!(
        "cargo:rustc-env=TUIC_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );

    #[cfg(feature = "desktop")]
    {
        // One Windows manifest for every artifact we link, ours instead of the
        // tauri one. tauri_build embeds its copy through
        // `cargo:rustc-link-arg-bins`, which reaches binaries and not the unit
        // tests of the lib. Those test binaries then bind comctl32 5.82 from
        // System32, which does not export TaskDialogIndirect, and the loader
        // kills them with STATUS_ENTRYPOINT_NOT_FOUND before a test runs.
        //
        // Only `cargo:rustc-link-arg` without a suffix reaches the lib test
        // binary: `-tests` covers the `tests/` targets alone (measured). That
        // directive also reaches the binaries, and a second RT_MANIFEST there
        // is a duplicate resource the linker rejects, so the tauri manifest has
        // to go. Its content is this file, so the binaries keep what they had.
        let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
        // Sidecars only flow out of Cargo's target directory. Tauri's build
        // helper otherwise copies staged (possibly stale) binaries over the
        // workspace executables that Cargo just built.
        let config = std::env::var("TAURI_CONFIG").ok();
        let patch = build_sidecars::without_sidecar_copy(config.as_deref())
            .expect("invalid TAURI_CONFIG sidecar build override");
        // SAFETY: this build script is single-threaded at this point.
        unsafe { std::env::set_var("TAURI_CONFIG", patch) };
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("failed to run tauri-build");

        if windows {
            let manifest =
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app.manifest");
            println!("cargo:rerun-if-changed={}", manifest.display());
            println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        }
    }
}
