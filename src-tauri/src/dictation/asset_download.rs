//! HTTP and Tokio adapter for staging pinned speech assets.

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use tuic_dictation::speech::SpeechCancel;
use tuic_dictation::speech::assets::{
    self, Asset, Fetch, InstallError, Payload, library_name, staging_dir,
};

pub async fn stage(
    asset: &Asset,
    cancel: &SpeechCancel,
    on_progress: impl Fn(u64, u64),
) -> Result<PathBuf, InstallError> {
    let staging = staging_dir(asset.id);
    assets::discard(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| InstallError::Disk(format!("{}: {e}", staging.display())))?;

    let result = fill(asset, &staging, cancel, on_progress).await;
    if result.is_err() {
        assets::discard(&staging);
    }
    result.map(|()| staging)
}

async fn fill(
    asset: &Asset,
    staging: &Path,
    cancel: &SpeechCancel,
    on_progress: impl Fn(u64, u64),
) -> Result<(), InstallError> {
    let total = asset.download_bytes();
    let mut done = 0u64;
    match &asset.payload {
        Payload::Files(files) => {
            for file in *files {
                let dest = staging.join(file.name);
                download(file, &dest, cancel, done, total, &on_progress).await?;
                done += file.size_bytes;
            }
        }
        Payload::Library(fetch) => {
            // The archive lands inside staging so a cancelled install has one
            // directory to delete, not a directory and a stray temp file. It
            // keeps its upstream file name because that is where the format
            // comes from: `.zip` on Windows, `.tgz` everywhere else.
            let archive = staging.join(fetch.name);
            download(fetch, &archive, cancel, done, total, &on_progress).await?;
            let member = staging.join(library_name());
            extract_library(archive, member).await?;
        }
    }
    Ok(())
}

async fn download(
    file: &Fetch,
    dest: &Path,
    cancel: &SpeechCancel,
    already: u64,
    total: u64,
    on_progress: &impl Fn(u64, u64),
) -> Result<(), InstallError> {
    if cancel.is_cancelled() {
        return Err(InstallError::Cancelled);
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InstallError::Disk(format!("{}: {e}", parent.display())))?;
    }

    let response = reqwest::Client::new()
        .get(file.url)
        .send()
        .await
        .map_err(|e| InstallError::Network(format!("{}: {e}", file.url)))?;
    if !response.status().is_success() {
        return Err(InstallError::Network(format!(
            "{} returned {}",
            file.url,
            response.status()
        )));
    }

    let mut handle = tokio::fs::File::create(dest)
        .await
        .map_err(|e| InstallError::Disk(format!("{}: {e}", dest.display())))?;
    // Hashed as it streams rather than by re-reading afterwards: the file is up
    // to 125 MB and the bytes are already in hand.
    let mut hasher = Sha256::new();
    let mut written = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.is_cancelled() {
            return Err(InstallError::Cancelled);
        }
        let chunk = chunk.map_err(|e| InstallError::Network(format!("{}: {e}", file.url)))?;
        hasher.update(&chunk);
        handle
            .write_all(&chunk)
            .await
            .map_err(|e| InstallError::Disk(format!("{}: {e}", dest.display())))?;
        written += chunk.len() as u64;
        on_progress(already + written, total);
    }
    handle
        .flush()
        .await
        .map_err(|e| InstallError::Disk(format!("{}: {e}", dest.display())))?;

    let got = hex(&hasher.finalize());
    if got != file.sha256 {
        return Err(InstallError::Corrupt {
            file: file.name.to_string(),
            expected: file.sha256.to_string(),
            got,
        });
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// Pull the one shared library out of an upstream SDK archive.
///
/// Blocking work — a 74 MB gunzip — so it runs off the async runtime rather
/// than holding a worker for the duration.
async fn extract_library(archive: PathBuf, dest: PathBuf) -> Result<(), InstallError> {
    tokio::task::spawn_blocking(move || {
        let result = if archive.extension().is_some_and(|e| e == "zip") {
            assets::extract_from_zip(&archive, &dest)
        } else {
            assets::extract_from_tar_gz(&archive, &dest)
        };
        // The archive is several times the size of what we kept; nothing reads
        // it again either way.
        let _ = std::fs::remove_file(&archive);
        result
    })
    .await
    .map_err(|e| InstallError::Disk(format!("extracting the runtime library: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tuic_dictation::speech::assets::{Kind, Status, promote, status};
    // -----------------------------------------------------------------
    // The download path, against a real server on loopback
    // -----------------------------------------------------------------
    //
    // A local axum server rather than a mocked client: the thing worth
    // proving is what `stage` does with bytes arriving over HTTP — where it
    // writes them, when it hashes them, and what it leaves behind when it
    // refuses them. A fake `reqwest` would assert against the fake.

    const BODY: &[u8] = b"a bundle, for the purposes of argument";
    /// sha256 of `BODY`.
    const BODY_SHA: &str = "1d93e7f8caaeaa212f2364b1dc5a9e85ad27cc33cb85bbafc361d7ea08eb0fb1";

    /// Serve `BODY` at one path, and hand back the URL. The server stops when
    /// the returned handle is dropped at the end of the test.
    async fn serve() -> (String, tokio::task::JoinHandle<()>) {
        let app = axum::Router::new().route("/f", axum::routing::get(|| async { BODY }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{address}/f"), server)
    }

    /// An asset pointing at the local server. Leaked because the catalogue is
    /// `&'static` by design — a test port cannot be known at compile time, and
    /// a leak that lives as long as the test process is the honest way to say
    /// so rather than loosening the lifetime everywhere else.
    fn test_asset(url: String, sha256: &'static str) -> Asset {
        Asset {
            id: "test-language",
            display_name: "Test",
            kind: Kind::Language {
                language: "test-language",
                code: "zz",
                voices: &[],
            },
            payload: Payload::Files(Box::leak(Box::new([Fetch {
                name: "bundle.json",
                url: Box::leak(url.into_boxed_str()),
                sha256,
                size_bytes: BODY.len() as u64,
            }]))),
        }
    }

    #[tokio::test]
    async fn a_verified_download_is_staged_first_and_installed_only_on_promote() {
        let root = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(root.path().to_path_buf());
        let (url, _server) = serve().await;
        let asset = test_asset(url, BODY_SHA);

        let staging = stage(&asset, &SpeechCancel::new(), |_, _| {})
            .await
            .unwrap();
        assert_eq!(std::fs::read(staging.join("bundle.json")).unwrap(), BODY);
        // The whole point of the split: nothing is live yet.
        assert_eq!(status(&asset), Status::Absent);

        promote(&asset, &staging).unwrap();
        assert_eq!(status(&asset), Status::Ready);
    }

    #[tokio::test]
    async fn a_file_whose_hash_is_wrong_never_reaches_the_install_directory() {
        // The criterion in one test: a corrupt download must not appear ready,
        // and must not leave a staging directory for the next attempt to find
        // half-full and skip.
        let root = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(root.path().to_path_buf());
        let (url, _server) = serve().await;
        // A hash the body cannot possibly have, which is what a substituted
        // file upstream would look like from here.
        let asset = test_asset(
            url,
            "0000000000000000000000000000000000000000000000000000000000000000",
        );

        let error = stage(&asset, &SpeechCancel::new(), |_, _| {})
            .await
            .unwrap_err();
        let InstallError::Corrupt { file, got, .. } = error else {
            panic!("a wrong hash was not reported as corruption: {error:?}");
        };
        assert_eq!(file, "bundle.json");
        assert_eq!(got, BODY_SHA, "the hash reported is not the one computed");
        assert_eq!(status(&asset), Status::Absent);
        assert!(
            !staging_dir(asset.id).exists(),
            "staging survived a refusal"
        );
    }

    #[tokio::test]
    async fn a_download_cancelled_before_it_starts_leaves_nothing_behind() {
        let root = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(root.path().to_path_buf());
        let (url, _server) = serve().await;
        let asset = test_asset(url, BODY_SHA);

        let cancel = SpeechCancel::new();
        cancel.cancel();
        assert_eq!(
            stage(&asset, &cancel, |_, _| {}).await.unwrap_err(),
            InstallError::Cancelled
        );
        assert_eq!(status(&asset), Status::Absent);
        assert!(!staging_dir(asset.id).exists());
    }

    #[tokio::test]
    async fn a_url_that_answers_404_is_a_network_error_not_a_corrupt_file() {
        // The two need different messages: one says try again, the other says
        // this download will never work. A 404 body hashed and compared would
        // have reported corruption.
        let root = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(root.path().to_path_buf());
        let (url, _server) = serve().await;
        let asset = test_asset(format!("{url}-does-not-exist"), BODY_SHA);

        let error = stage(&asset, &SpeechCancel::new(), |_, _| {})
            .await
            .unwrap_err();
        assert!(matches!(error, InstallError::Network(_)), "{error:?}");
    }

    #[tokio::test]
    async fn progress_reaches_the_declared_total() {
        // A bar fed a total it never reaches sits at 99% forever. The total is
        // the catalogue's, so this also checks the declared size is the real
        // one for at least one asset shape.
        let root = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(root.path().to_path_buf());
        let (url, _server) = serve().await;
        let asset = test_asset(url, BODY_SHA);

        let seen = std::sync::Mutex::new(Vec::new());
        stage(&asset, &SpeechCancel::new(), |done, total| {
            seen.lock().unwrap().push((done, total));
        })
        .await
        .unwrap();

        let seen = seen.into_inner().unwrap();
        assert!(!seen.is_empty(), "no progress was reported at all");
        let (done, total) = *seen.last().unwrap();
        assert_eq!(done, total);
        assert_eq!(total, asset.download_bytes());
    }

    #[test]
    fn hex_is_lowercase_and_zero_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }
}
