fn main() {
    // ggml-metal uses @available(), which needs this compiler runtime when
    // rustc links with -nodefaultlibs. The directive belongs to the crate
    // using Metal so standalone dictation tests receive it too.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && let Ok(out) = std::process::Command::new("xcrun")
            .args([
                "--sdk",
                "macosx",
                "clang",
                "--print-file-name",
                "libclang_rt.osx.a",
            ])
            .output()
    {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if let Some(dir) = std::path::Path::new(&path).parent() {
            println!("cargo:rustc-link-search=native={}", dir.display());
            println!("cargo:rustc-link-lib=static=clang_rt.osx");
        }
    }
}
