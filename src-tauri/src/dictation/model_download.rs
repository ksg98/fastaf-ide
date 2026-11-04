//! Downloads for the Whisper models in [`tuic_dictation::model`], and for any
//! other large file the app keeps under `models_dir()` (`voice::assets` uses
//! [`download_file`] for the Kokoro model and voices).
//!
//! Lives here rather than in the `tuic-dictation` crate because it is HTTP and
//! Tokio, which the crate deliberately does not depend on.

use std::path::PathBuf;
use tuic_dictation::model::{WhisperModel, model_path};

/// Download a model from HuggingFace with progress callback.
/// The callback receives (bytes_downloaded, total_bytes).
pub async fn download_model(
    model: WhisperModel,
    on_progress: impl Fn(u64, u64) + Send + 'static,
) -> Result<PathBuf, String> {
    download_file(&model.download_url(), model_path(model), on_progress).await
}

/// Stream `url` to `dest`, reporting (bytes_downloaded, total_bytes) as it goes.
///
/// Writes to a `.downloading` sibling and renames on success, so an interrupted
/// download never leaves a truncated file that `model_exists` would accept.
/// Shared by the whisper models above and the voice assets in `voice::assets`.
///
/// Interrupted downloads resume: a `.downloading` file left behind by a quit,
/// crash or update is continued with an HTTP `Range` request instead of being
/// thrown away. Models run to gigabytes, and restarting from zero every time
/// the app restarted meant a large model could effectively never finish.
pub async fn download_file(
    url: &str,
    dest: PathBuf,
    on_progress: impl Fn(u64, u64) + Send + 'static,
) -> Result<PathBuf, String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create models directory: {e}"))?;
    }

    let tmp_path = dest.with_extension("downloading");
    let partial = tokio::fs::metadata(&tmp_path).await.map_or(0, |m| m.len());
    let client = reqwest::Client::new();
    let (resp, offset) = open_download(&client, url, partial).await?;

    // With a resumed response the true size is the `/total` of Content-Range;
    // otherwise it is simply the body length.
    let total_size = content_range_total(&resp)
        .unwrap_or_else(|| resp.content_length().map_or(0, |len| len + offset));

    let mut file = if offset > 0 {
        tracing::info!(
            source = "dictation",
            path = %tmp_path.display(),
            offset,
            total_size,
            "Resuming download"
        );
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&tmp_path)
            .await
            .map_err(|e| format!("Failed to reopen partial download: {e}"))?
    } else {
        tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| format!("Failed to create temp file: {e}"))?
    };

    let mut downloaded = offset;
    on_progress(downloaded, total_size);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write chunk: {e}"))?;
        downloaded += chunk.len() as u64;
        on_progress(downloaded, total_size);
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {e}"))?;
    drop(file);

    // A connection that closes early ends the stream without an error. Keep
    // the partial file (the next attempt resumes it) rather than renaming a
    // truncated model into place.
    if total_size > 0 && downloaded != total_size {
        return Err(format!(
            "Download ended early ({downloaded} of {total_size} bytes). Try again to resume."
        ));
    }

    tokio::fs::rename(&tmp_path, &dest)
        .await
        .map_err(|e| format!("Failed to rename downloaded file: {e}"))?;

    Ok(dest)
}

/// Send the GET, asking to continue from `partial` bytes when there are any.
///
/// Returns the response and the offset its body starts at. Falls back to a
/// full download (offset 0) whenever the server cannot continue exactly where
/// the partial file ends: it ignored the Range (200), rejected it (416, e.g.
/// the partial is stale), or answered with a different range.
async fn open_download(
    client: &reqwest::Client,
    url: &str,
    partial: u64,
) -> Result<(reqwest::Response, u64), String> {
    use reqwest::StatusCode;

    let send = |range: Option<u64>| {
        let mut req = client.get(url);
        if let Some(from) = range {
            req = req.header(reqwest::header::RANGE, format!("bytes={from}-"));
        }
        req.send()
    };

    if partial > 0 {
        let resp = send(Some(partial))
            .await
            .map_err(|e| format!("Download request failed: {e}"))?;
        let expected = format!("bytes {partial}-");
        let resumes = resp.status() == StatusCode::PARTIAL_CONTENT
            && resp
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with(&expected));
        if resumes {
            return Ok((resp, partial));
        }
        if resp.status() == StatusCode::OK {
            // Server ignored the Range: this body is the whole file.
            return Ok((resp, 0));
        }
        if !resp.status().is_success() && resp.status() != StatusCode::RANGE_NOT_SATISFIABLE {
            return Err(format!("Download failed with status: {}", resp.status()));
        }
        // 416, or a 206 for some other range: start over below.
    }

    let resp = send(None)
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed with status: {}", resp.status()));
    }
    Ok((resp, 0))
}

/// The `total` of a `Content-Range: bytes start-end/total` header, if present.
fn content_range_total(resp: &reqwest::Response) -> Option<u64> {
    resp.headers()
        .get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?
        .rsplit('/')
        .next()?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Resumable downloads ─────────────────────────────────────────────────

    fn body() -> Vec<u8> {
        (0..10_000u32).map(|i| (i % 251) as u8).collect()
    }

    #[tokio::test]
    async fn download_writes_the_whole_file_and_removes_the_partial() {
        let mut server = mockito::Server::new_async().await;
        let data = body();
        server
            .mock("GET", "/m.bin")
            .match_header("range", mockito::Matcher::Missing)
            .with_status(200)
            .with_body(&data)
            .create_async()
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.bin");

        download_file(&format!("{}/m.bin", server.url()), dest.clone(), |_, _| {})
            .await
            .unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), data);
        assert!(!dest.with_extension("downloading").exists());
    }

    #[tokio::test]
    async fn download_resumes_from_a_partial_file() {
        let mut server = mockito::Server::new_async().await;
        let data = body();
        let cut = 4_000;
        let mock = server
            .mock("GET", "/m.bin")
            .match_header("range", format!("bytes={cut}-").as_str())
            .with_status(206)
            .with_header(
                "content-range",
                &format!("bytes {cut}-{}/{}", data.len() - 1, data.len()),
            )
            .with_body(&data[cut..])
            .create_async()
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.bin");
        std::fs::write(dest.with_extension("downloading"), &data[..cut]).unwrap();

        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_cb = seen.clone();
        download_file(
            &format!("{}/m.bin", server.url()),
            dest.clone(),
            move |d, t| {
                seen_cb.lock().unwrap().push((d, t));
            },
        )
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(
            std::fs::read(&dest).unwrap(),
            data,
            "partial + remainder = original"
        );
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.first(),
            Some(&(cut as u64, data.len() as u64)),
            "progress starts at the partial size"
        );
        assert_eq!(seen.last(), Some(&(data.len() as u64, data.len() as u64)));
    }

    #[tokio::test]
    async fn download_starts_over_when_the_server_ignores_the_range() {
        let mut server = mockito::Server::new_async().await;
        let data = body();
        server
            .mock("GET", "/m.bin")
            .with_status(200)
            .with_body(&data)
            .create_async()
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.bin");
        std::fs::write(dest.with_extension("downloading"), &data[..4_000]).unwrap();

        download_file(&format!("{}/m.bin", server.url()), dest.clone(), |_, _| {})
            .await
            .unwrap();

        assert_eq!(
            std::fs::read(&dest).unwrap(),
            data,
            "not appended onto the partial"
        );
    }

    #[tokio::test]
    async fn download_starts_over_when_the_range_is_rejected() {
        let mut server = mockito::Server::new_async().await;
        let data = body();
        server
            .mock("GET", "/m.bin")
            .match_header("range", mockito::Matcher::Any)
            .with_status(416)
            .create_async()
            .await;
        server
            .mock("GET", "/m.bin")
            .match_header("range", mockito::Matcher::Missing)
            .with_status(200)
            .with_body(&data)
            .create_async()
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("m.bin");
        std::fs::write(dest.with_extension("downloading"), vec![7u8; 20_000]).unwrap();

        download_file(&format!("{}/m.bin", server.url()), dest.clone(), |_, _| {})
            .await
            .unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }
}
