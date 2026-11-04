use anyhow::{Context, Result, bail};
use bindgen::callbacks::{AttributeInfo, DeriveInfo, ParseCallbacks};
use std::{env, path::PathBuf, process::Command};

/// Name and minimum version of the library that we are binding to.
const LIB_NAME: &str = "webrtc-audio-processing-2";
#[cfg(not(feature = "bundled"))]
const LIB_MIN_VERSION: &str = "2.1";

const MACOSX_DEPLOYMENT_TARGET_VAR: &str = "MACOSX_DEPLOYMENT_TARGET";

fn out_dir() -> PathBuf {
    std::env::var("OUT_DIR")
        .expect("OUT_DIR environment var not set.")
        .into()
}

#[cfg(not(feature = "bundled"))]
mod webrtc {
    use super::*;

    pub(super) fn get_build_paths() -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
        let (pkgconfig_include_path, pkgconfig_lib_path) = find_pkgconfig_paths()?;

        let include_path = std::env::var("WEBRTC_AUDIO_PROCESSING_INCLUDE")
            .ok()
            .map(PathBuf::from)
            .or(pkgconfig_include_path);
        let lib_path = std::env::var("WEBRTC_AUDIO_PROCESSING_LIB")
            .ok()
            .map(PathBuf::from)
            .or(pkgconfig_lib_path);

        if include_path.is_none() || lib_path.is_none() {
            bail!(
                "Couldn't find {}. Please install it or set WEBRTC_AUDIO_PROCESSING_INCLUDE and WEBRTC_AUDIO_PROCESSING_LIB environment variables.",
                LIB_NAME
            );
        }

        Ok((vec![include_path.unwrap()], vec![lib_path.unwrap()]))
    }

    pub(super) fn build_if_necessary() -> Result<()> {
        Ok(())
    }

    fn find_pkgconfig_paths() -> Result<(Option<PathBuf>, Option<PathBuf>)> {
        let lib = match pkg_config::Config::new()
            .atleast_version(LIB_MIN_VERSION)
            .statik(false)
            .probe(LIB_NAME)
        {
            Ok(lib) => lib,
            Err(e) => {
                eprintln!("Couldn't find {LIB_NAME} with pkg-config:");
                eprintln!("{e}");
                return Ok((None, None));
            }
        };

        Ok((
            lib.include_paths.first().cloned(),
            lib.link_paths.first().cloned(),
        ))
    }
}

#[cfg(feature = "bundled")]
mod webrtc {
    use super::*;
    use std::path::Path;

    const BUNDLED_SOURCE_PATH: &str = "./webrtc-audio-processing";

    pub(super) fn get_build_paths() -> Result<(Vec<PathBuf>, Vec<PathBuf>)> {
        let mut include_paths = vec![
            out_dir().join("include"),
            out_dir().join("include").join(LIB_NAME),
            webrtc_source_dir(),
            webrtc_source_dir().join("webrtc"),
        ];
        // TODO(strohel): instead of hardcoding the paths, we should consult the pkgconfig file that
        // the bundled webrtc-audio-processing build produces.
        let mut lib_paths = vec![
            // MacOS, Arch Linux, baseline default
            out_dir().join("lib"),
            // Ubuntu Linux (our CI)
            out_dir().join("lib").join("x86_64-linux-gnu"),
            // Ubuntu Linux (Arm 64bit)
            out_dir().join("lib").join("aarch64-linux-gnu"),
            // Gentoo Linux (x86_64 multilib)
            out_dir().join("lib64"),
        ];

        // TUIC patch: upstream probed pkg-config here and preferred a system
        // abseil when it found one. Two reasons that is wrong for us, and they
        // are separate.
        //
        // It does not link. A Mac with `brew install abseil` supplies
        // 20260817, meson builds the WebRTC sources against its headers, and
        // the link then fails on `absl::lts_20260817::ThrowStdLengthError`
        // — measured here. The meson.build comment above the abseil dependency
        // says why: abseil demands a strict C++ standard match, and the
        // standard a distribution built its copy at is not ours to choose.
        //
        // And even where it does link, it is the wrong artifact. A dynamic
        // link to `/opt/homebrew/opt/abseil` is a link to a library that is
        // not on the machine we ship to. The bundled feature exists to make
        // this library travel with the binary.
        //
        // Paired with `--wrap-mode=forcefallback` in the meson invocation
        // below: meson must build the same abseil these paths point at, or the
        // mismatch simply moves.
        include_paths.push(
            webrtc_source_dir()
                .join("subprojects")
                .join("abseil-cpp-20240722.0"),
        );
        lib_paths.push(
            webrtc_build_dir()
                .join("subprojects")
                .join("abseil-cpp-20240722.0"),
        );

        Ok((include_paths, lib_paths))
    }

    pub(super) fn build_if_necessary() -> Result<()> {
        let bundled_source_path = Path::new(BUNDLED_SOURCE_PATH);
        if bundled_source_path.read_dir()?.next().is_none() {
            eprintln!("The webrtc-audio-processing source directory is empty.");
            eprintln!("See the crate README for installation instructions.");
            eprintln!("Remember to clone the repo recursively if building from source.");
            bail!("Aborting compilation because bundled source directory is empty.");
        }

        let webrtc_source_dir = webrtc_source_dir();
        let webrtc_build_dir = webrtc_build_dir();
        eprintln!(
            "Copying webrtc-audio-processing to {} and building it in {}",
            webrtc_source_dir.display(),
            webrtc_build_dir.display()
        );

        // Copy the sources to under out directory so that we can patch it without consequences.
        //
        // TUIC patch: upstream shells out to `cp -a`, which Windows does not
        // have — the build failed with "program not found" before meson ever
        // ran. `fs_extra` is already a build dependency of this crate and does
        // the same job in process. `content_only` is the trailing-dot trick
        // upstream described: without it a second invocation would nest
        // `webrtc-audio-processing/webrtc-audio-processing`.
        std::fs::create_dir_all(&webrtc_source_dir)
            .with_context(|| format!("creating {}", webrtc_source_dir.display()))?;
        fs_extra::dir::copy(
            bundled_source_path,
            &webrtc_source_dir,
            &fs_extra::dir::CopyOptions::new()
                .overwrite(true)
                .content_only(true),
        )
        .with_context(|| {
            format!(
                "copying {} to {}",
                bundled_source_path.display(),
                webrtc_source_dir.display()
            )
        })?;

        #[cfg(feature = "experimental-unlink-ns")]
        apply_patch("unlink-multichannel-noise-suppression-filters.patch")?;

        let mut meson = Command::new("meson");
        meson
            .arg("setup")
            .arg("--prefix")
            .arg(out_dir().as_os_str());
        // TUIC patch: build the vendored abseil rather than any the machine
        // happens to have. See the long note in `find_include_and_lib_paths`
        // — the two changes are one change. `abseil-cpp.wrap` is the only wrap
        // in this source, so this forces exactly one subproject.
        meson.arg("--wrap-mode=forcefallback");

        // TUIC patch: MSVC targets must not pick MinGW just because cc/c++
        // is on PATH. Meson activates Visual Studio for each subcommand;
        // compile/install below must run through Meson to retain that setup.
        if env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
            meson.arg("--vsenv");
            // Reconfigure preserves the previous compiler. A restored CI
            // build directory may still contain the MinGW configuration.
            meson.arg("--wipe");
        } else {
            meson.arg("--reconfigure");
        }

        if cfg!(target_os = "macos") {
            let link_args = "['-framework', 'CoreFoundation', '-framework', 'Foundation']";
            meson.arg(format!("-Dc_link_args={}", link_args));
            meson.arg(format!("-Dcpp_link_args={}", link_args));
        }

        let status = meson
            .arg("-Ddefault_library=static")
            .arg(webrtc_build_dir.as_os_str())
            .arg(webrtc_source_dir.as_os_str())
            .status()
            .context("Failed to execute meson. Do you have it installed?")?;
        assert!(status.success(), "Command failed: {:?}", &meson);

        let mut compile = Command::new("meson");
        let status = compile
            .arg("compile")
            .arg("-C")
            .arg(&webrtc_build_dir)
            .status()
            .context("Failed to execute meson compile")?;
        assert!(status.success(), "Command failed: {:?}", &compile);

        let mut install = Command::new("meson");
        let status = install
            .arg("install")
            .arg("-C")
            .arg(&webrtc_build_dir)
            .status()
            .context("Failed to execute meson install")?;
        assert!(status.success(), "Command failed: {:?}", &install);

        Ok(())
    }

    // Patch with `patch`.
    #[cfg(feature = "experimental-unlink-ns")]
    fn apply_patch(patch_name: &str) -> Result<()> {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let patch = manifest.join("patches").join(patch_name);

        let status = Command::new("patch")
            .args(["-p1", "--forward"])
            .arg("-i")
            .arg(&patch)
            .current_dir(webrtc_source_dir())
            .status()
            .context("Failed to execute patch")?;

        anyhow::ensure!(
            status.success(),
            "Patch '{}' failed with status: {}",
            patch_name,
            status
        );
        Ok(())
    }

    fn webrtc_source_dir() -> PathBuf {
        out_dir().join("webrtc-audio-processing")
    }

    fn webrtc_build_dir() -> PathBuf {
        out_dir().join("webrtc-audio-processing-build")
    }
}

#[derive(Debug)]
struct CustomDeriveCallbacks;

impl ParseCallbacks for CustomDeriveCallbacks {
    fn add_derives(&self, info: &DeriveInfo) -> Vec<String> {
        // Matches EchoCanceller3Config, EchoCanceller3Config_Suppressor etc
        if info.name.starts_with("EchoCanceller3Config") && cfg!(feature = "serde") {
            vec!["serde::Deserialize".into(), "serde::Serialize".into()]
        // Matches AudioProcessing_Config, AudioProcessing_Config_EchoCanceller etc
        } else if info.name.starts_with("AudioProcessing_Config") {
            // Only derive Default for AudioProcessing_Config and its inner structs. bindgen Default
            // implementation ignores C/C++ struct default values and thus misleading to enable
            // globally. Note that we don't expose these defaults on `webrtc-audio-processing`
            // level: they are needed only by the code that converts from prettified Rust config
            // structs into their FFI variants to construct disabled/dummy values.
            vec!["Default".into()]
        } else {
            vec![]
        }
    }

    fn add_attributes(&self, info: &AttributeInfo<'_>) -> Vec<String> {
        if info.name.starts_with("EchoCanceller3Config") {
            // Prohibit construction of ffi EchoCanceller3Config and its children structs.
            // The only allowed API is through the wrapper struct in the webrtc_audio_processing crate.
            vec!["#[non_exhaustive]".into()]
        } else {
            vec![]
        }
    }
}

fn main() -> Result<()> {
    webrtc::build_if_necessary()?;
    let (include_dirs, lib_dirs) = webrtc::get_build_paths()?;

    // TUIC patch: upstream renamed every symbol in the built WebRTC archive to
    // `v2_*`, and then renamed the wrapper's references to match, so that two
    // major versions of this crate could be linked into one binary. We link
    // one, so all it bought us was three external tools — `nm`, `rust-objcopy`,
    // and a naming assumption — and it did not survive Windows: cc-rs emits
    // `webrtc_audio_processing_wrapper.lib` under MSVC, not `lib….a`, so the
    // wrapper half silently did nothing while the library half succeeded. The
    // link then failed on twelve `webrtc::` symbols that existed under another
    // name. Removing the whole mechanism is the fix; re-adding it means making
    // both halves agree on every platform, for a capability we do not use.
    for dir in &lib_dirs {
        println!("cargo:rustc-link-search=native={}", dir.display());
    }

    if cfg!(target_os = "macos") {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }

    // TUIC patch: `rtc::SystemTimeNanos` calls `timeGetTime`, which lives in
    // the Windows multimedia library. Upstream never emits this because
    // upstream never links on Windows; without it the build gets all the way
    // to the final link and dies on one unresolved `__imp_timeGetTime`.
    if cfg!(target_os = "windows") {
        println!("cargo:rustc-link-lib=dylib=winmm");
    }

    let mut cc_build = cc::Build::new();

    if cfg!(feature = "experimental-aec3-config") {
        cc_build.define("WEBRTC_AEC3_CONFIG", None);
    }

    // Set macos minimum version
    if cfg!(target_os = "macos") {
        let min_version = match env::var(MACOSX_DEPLOYMENT_TARGET_VAR) {
            Ok(ver) => ver,
            Err(_) => {
                String::from(
                    match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
                        "x86_64" => "10.10", // Using what I found here https://github.com/webrtc-uwp/chromium-build/blob/master/config/mac/mac_sdk.gni#L17
                        "aarch64" => "11.0", // Apple silicon started here.
                        arch => panic!("unknown arch: {}", arch),
                    },
                )
            }
        };

        // `cc` doesn't try to pick up on this automatically, but `clang` needs it to
        // generate a "correct" Objective-C symbol table which better matches XCode.
        // See https://github.com/h4llow3En/mac-notification-sys/issues/45.
        cc_build.flag(format!("-mmacos-version-min={}", min_version));
    }

    // This automatically emits "cargo:rustc-link-lib=static=webrtc_audio_processing_wrapper".
    // The wrapper library should be linked before webrtc-audio-processing-2, otherwise strict
    // linkers (like when passing -Wl,--as-needed) may discard the c++ library (automatically
    // added by cc) from the linking list, resulting in build failure.
    // The linking order should respect the dependency graph, i.e. wrapper -> webrtc-2.
    // TUIC patch: upstream spelled both of these as raw GCC flags, and `cl`
    // rejects them — `-std=c++17` and `-Wno-unused-parameter` both come back as
    // "D8021 invalid numeric argument". `.std()` lets cc-rs pick the separator
    // (`-std=` for gcc and clang, `-std:` for MSVC), and the warning is silenced
    // by its MSVC number instead.
    //
    // c++20, not the c++17 upstream used: this wrapper calls into the WebRTC
    // library, which meson.build now builds at c++20 for the reason recorded
    // there. The two must agree.
    cc_build
        .cpp(true)
        .file("src/wrapper.cpp")
        .includes(&include_dirs)
        .std("c++20")
        .out_dir(out_dir());

    if cc_build.get_compiler().is_like_msvc() {
        cc_build.flag("/wd4100"); // unreferenced formal parameter
    } else {
        cc_build.flag("-Wno-unused-parameter");
    }

    // Inform wrapper code that headers for internal classes (ResidualEchoDetector) are available.
    #[cfg(feature = "bundled")]
    cc_build.define("WEBRTC_HAS_INTERNAL_HEADERS", None);

    cc_build.compile("webrtc_audio_processing_wrapper");

    // The the cc and bindgen commands emit `cargo:rerun-if-env-changed=...`, and these deactivate
    // the default behavior to rerun if _any_ source file changes. So state these explicitly.
    // build.rs is always included and doesn't have to be specified.
    println!("cargo:rerun-if-changed=src/wrapper.hpp");
    println!("cargo:rerun-if-changed=src/wrapper.cpp");

    if cfg!(feature = "bundled") {
        println!("cargo:rustc-link-lib=static={LIB_NAME}");
        println!("cargo:rustc-link-lib=absl_strings");
    } else {
        println!("cargo:rustc-link-lib=dylib={LIB_NAME}");
    }

    let binding_file = out_dir().join("bindings.rs");
    let mut builder = bindgen::Builder::default()
        .header("src/wrapper.hpp")
        .clang_args(&["-x", "c++", "-std=c++17", "-fparse-all-comments"])
        .generate_comments(true)
        .enable_cxx_namespaces();

    builder = builder
        // Transitive dependencies are automatically included.
        .allowlist_function("webrtc_audio_processing_wrapper::.*")
        .opaque_type("std::.*")
        .parse_callbacks(Box::new(CustomDeriveCallbacks))
        .derive_debug(true)
        // The default implementation ignores C++11's brace-or-equal-initializers,
        // and thus misleading to enable. See also CustomDeriveCallbacks.
        .derive_default(false)
        .derive_partialeq(true);
    for dir in &include_dirs {
        builder = builder.clang_arg(format!("-I{}", dir.display()));
    }
    builder
        .generate()
        .expect("Unable to generate bindings")
        .write_to_file(&binding_file)
        .expect("Couldn't write bindings!");

    Ok(())
}
