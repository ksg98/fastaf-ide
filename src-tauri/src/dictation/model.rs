use std::path::PathBuf;

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// Supported Whisper GGML model variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhisperModel {
    Small,
    SmallEn,
    LargeV2,
    LargeV3Turbo,
}

impl WhisperModel {
    /// All available model variants.
    pub const ALL: [WhisperModel; 4] = [
        Self::Small,
        Self::SmallEn,
        Self::LargeV2,
        Self::LargeV3Turbo,
    ];

    pub const fn filename(&self) -> &'static str {
        match self {
            Self::Small => "ggml-small.bin",
            Self::SmallEn => "ggml-small.en.bin",
            Self::LargeV2 => "ggml-large-v2.bin",
            Self::LargeV3Turbo => "ggml-large-v3-turbo.bin",
        }
    }

    pub fn download_url(&self) -> String {
        format!("{}/{}", MODEL_BASE_URL, self.filename())
    }

    pub const fn display_name(&self) -> &'static str {
        match self {
            Self::Small => "Whisper Small",
            Self::SmallEn => "Whisper Small (English)",
            Self::LargeV2 => "Whisper Large V2",
            Self::LargeV3Turbo => "Whisper Large V3 Turbo",
        }
    }

    pub const fn size_hint_mb(&self) -> u64 {
        match self {
            Self::Small => 488,
            Self::SmallEn => 488,
            Self::LargeV2 => 3090,
            Self::LargeV3Turbo => 1620,
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "small" => Some(Self::Small),
            "small-en" | "small.en" => Some(Self::SmallEn),
            "large-v2" => Some(Self::LargeV2),
            "large-v3-turbo" => Some(Self::LargeV3Turbo),
            _ => None,
        }
    }

    pub const fn name(&self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::SmallEn => "small-en",
            Self::LargeV2 => "large-v2",
            Self::LargeV3Turbo => "large-v3-turbo",
        }
    }
}

/// Model storage directory: <config_dir>/models/
pub fn models_dir() -> PathBuf {
    crate::config::config_dir().join("models")
}

/// Full path to a model file.
pub fn model_path(model: WhisperModel) -> PathBuf {
    models_dir().join(model.filename())
}

/// Check if a model is already downloaded.
pub fn model_exists(model: WhisperModel) -> bool {
    let path = model_path(model);
    path.exists()
        && path
            .metadata()
            .map(|m| m.len() > 1_000_000)
            .unwrap_or(false)
}

/// Get model file size on disk (0 if not present).
pub fn model_size_bytes(model: WhisperModel) -> u64 {
    model_path(model).metadata().map(|m| m.len()).unwrap_or(0)
}

/// Delete a downloaded model file.
pub fn delete_model(model: WhisperModel) -> Result<(), String> {
    let path = model_path(model);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete model {}: {e}", model.filename()))?;
    }
    Ok(())
}

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
    let total_size = content_range_total(&resp).unwrap_or_else(|| {
        resp.content_length().map_or(0, |len| len + offset)
    });

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

    #[test]
    fn test_all_models_have_unique_names() {
        let names: Vec<&str> = WhisperModel::ALL.iter().map(|m| m.name()).collect();
        let mut dedup = names.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(names.len(), dedup.len());
    }

    #[test]
    fn test_all_models_have_unique_filenames() {
        let filenames: Vec<&str> = WhisperModel::ALL.iter().map(|m| m.filename()).collect();
        let mut dedup = filenames.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(filenames.len(), dedup.len());
    }

    #[test]
    fn test_from_name_roundtrip() {
        for model in &WhisperModel::ALL {
            let name = model.name();
            let parsed = WhisperModel::from_name(name);
            assert_eq!(parsed, Some(*model), "roundtrip failed for {name}");
        }
    }

    #[test]
    fn test_from_name_unknown() {
        assert_eq!(WhisperModel::from_name("unknown"), None);
        assert_eq!(WhisperModel::from_name("base"), None);
    }

    #[test]
    fn test_from_name_small_en_alias() {
        assert_eq!(
            WhisperModel::from_name("small.en"),
            Some(WhisperModel::SmallEn)
        );
        assert_eq!(
            WhisperModel::from_name("small-en"),
            Some(WhisperModel::SmallEn)
        );
    }

    #[test]
    fn test_filenames() {
        assert_eq!(WhisperModel::Small.filename(), "ggml-small.bin");
        assert_eq!(WhisperModel::SmallEn.filename(), "ggml-small.en.bin");
        assert_eq!(WhisperModel::LargeV2.filename(), "ggml-large-v2.bin");
        assert_eq!(
            WhisperModel::LargeV3Turbo.filename(),
            "ggml-large-v3-turbo.bin"
        );
    }

    #[test]
    fn test_size_hints() {
        assert_eq!(WhisperModel::Small.size_hint_mb(), 488);
        assert_eq!(WhisperModel::SmallEn.size_hint_mb(), 488);
        assert_eq!(WhisperModel::LargeV2.size_hint_mb(), 3090);
        assert_eq!(WhisperModel::LargeV3Turbo.size_hint_mb(), 1620);
    }

    #[test]
    fn test_download_urls() {
        for model in &WhisperModel::ALL {
            let url = model.download_url();
            assert!(
                url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-")
            );
            assert!(url.ends_with(".bin"));
        }
    }

    #[test]
    fn test_delete_nonexistent_model_is_ok() {
        // Deleting a model that doesn't exist should be a no-op
        let result = delete_model(WhisperModel::Small);
        assert!(result.is_ok());
    }

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
        download_file(&format!("{}/m.bin", server.url()), dest.clone(), move |d, t| {
            seen_cb.lock().unwrap().push((d, t));
        })
        .await
        .unwrap();

        mock.assert_async().await;
        assert_eq!(std::fs::read(&dest).unwrap(), data, "partial + remainder = original");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.first(), Some(&(cut as u64, data.len() as u64)), "progress starts at the partial size");
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

        assert_eq!(std::fs::read(&dest).unwrap(), data, "not appended onto the partial");
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
