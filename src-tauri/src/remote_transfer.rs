//! Mac-to-daemon copies over the already authenticated remote HTTP connection.
//! Each top-level source is streamed as a bounded tar and atomically published.

use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use cap_std::fs::{Dir, OpenOptions};
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::fs::TransferResult;
use crate::state::AppState;

const MAX_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;
const UPLOAD_SIZE_ERROR: &str = "upload exceeds 256 MiB including archive headers";
const UPLOAD_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
// Bound progressing chunked senders without a throughput meter. At the 256 MiB
// cap, a link below roughly 2 Mbit/s cannot complete within this receive budget.
const UPLOAD_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(17 * 60);
const MAX_ENTRIES: usize = 10_000;
const CHUNK_BYTES: usize = 64 * 1024;
// At most two staged copies (including archive + extracted tree) at once.
static UPLOAD_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteTransferRequest {
    connection_id: String,
    dest_dir: String,
    paths: Vec<String>,
    allow_recursive: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadQuery {
    dest_dir: String,
    name: String,
    directory: bool,
}

fn result() -> TransferResult {
    TransferResult {
        moved: 0,
        skipped: 0,
        errors: Vec::new(),
        needs_confirm: false,
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn fs_transfer_remote_paths(
    state: tauri::State<'_, Arc<AppState>>,
    connection_id: String,
    dest_dir: String,
    paths: Vec<String>,
    allow_recursive: bool,
) -> Result<TransferResult, String> {
    transfer_remote(
        &state,
        RemoteTransferRequest {
            connection_id,
            dest_dir,
            paths,
            allow_recursive,
        },
    )
    .await
}

pub(crate) async fn transfer_remote(
    state: &AppState,
    req: RemoteTransferRequest,
) -> Result<TransferResult, String> {
    let endpoint = state.remote.base_url(&req.connection_id).ok_or_else(|| {
        format!(
            "Remote {} {}: connection is not connected",
            req.connection_id, req.dest_dir
        )
    })?;
    let host = reqwest::Url::parse(&endpoint)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| req.connection_id.clone());
    let context = format!("Remote {} ({host}) {}", req.connection_id, req.dest_dir);
    let mut answer = send_copies(
        state.remote.http_client(),
        &endpoint,
        state.remote.token(&req.connection_id).as_deref(),
        &req.dest_dir,
        req.paths,
        req.allow_recursive,
    )
    .await
    .map_err(|e| format!("{context}: {e}"))?;
    for error in &mut answer.errors {
        *error = format!("{context}: {error}");
    }
    Ok(answer)
}

/// Sources are enumerated once, before touching the destination. Symlinks and
/// special files are rejected rather than creating an unbounded/cyclic walk.
fn source_entries(source: &Path) -> io::Result<Vec<(PathBuf, PathBuf)>> {
    let name = source
        .file_name()
        .ok_or_else(|| io::Error::other("source has no filename"))?;
    let mut pending = vec![(source.to_owned(), PathBuf::from(name))];
    let mut entries = Vec::new();
    let mut bytes = 1024u64; // tar end-of-archive blocks
    while let Some((path, relative)) = pending.pop() {
        let meta = std::fs::symlink_metadata(&path)?;
        if !meta.is_dir() && !meta.is_file() {
            return Err(io::Error::other(
                "source symlinks and special files are not supported",
            ));
        }
        // GNU paths longer than the normal header carry an extra header and
        // a NUL-terminated padded name. Sparse encoding is disabled below.
        let name_bytes = relative.as_os_str().as_encoded_bytes().len() as u64;
        let mut header = tar::Header::new_gnu();
        let long_name_bytes = if header.set_path(&relative).is_err() {
            512 + (name_bytes + 1).div_ceil(512) * 512
        } else {
            0
        };
        let content = if meta.is_file() { meta.len() } else { 0 };
        bytes = bytes
            .checked_add(512 + long_name_bytes)
            .and_then(|n| {
                content
                    .checked_add(511)
                    .and_then(|v| n.checked_add(v / 512 * 512))
            })
            .ok_or_else(|| io::Error::other(UPLOAD_SIZE_ERROR))?;
        if bytes > MAX_UPLOAD_BYTES {
            return Err(io::Error::other(UPLOAD_SIZE_ERROR));
        }
        if entries.len() + pending.len() >= MAX_ENTRIES {
            return Err(io::Error::other("too many upload entries"));
        }
        if meta.is_dir() {
            for child in std::fs::read_dir(&path)? {
                let child = child?;
                if entries.len() + pending.len() >= MAX_ENTRIES {
                    return Err(io::Error::other("too many upload entries"));
                }
                pending.push((child.path(), relative.join(child.file_name())));
            }
        }
        entries.push((path, relative));
    }
    Ok(entries)
}

struct ChunkWriter {
    sender: tokio::sync::mpsc::Sender<io::Result<Vec<u8>>>,
    bytes: u64,
}
impl Write for ChunkWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let len = bytes.len().min(CHUNK_BYTES);
        self.bytes += len as u64;
        if self.bytes > MAX_UPLOAD_BYTES {
            return Err(io::Error::other(UPLOAD_SIZE_ERROR));
        }
        self.sender
            .blocking_send(Ok(bytes[..len].to_vec()))
            .map_err(|_| io::Error::other("upload disconnected"))?;
        Ok(len)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) async fn send_copies(
    client: reqwest::Client,
    endpoint: &str,
    token: Option<&str>,
    dest: &str,
    paths: Vec<String>,
    allow_recursive: bool,
) -> Result<TransferResult, String> {
    if paths.len() > MAX_ENTRIES {
        return Err("too many sources".into());
    }
    if !allow_recursive {
        for path in &paths {
            if tokio::fs::metadata(path)
                .await
                .map_err(|e| e.to_string())?
                .is_dir()
            {
                let mut answer = result();
                answer.needs_confirm = true;
                return Ok(answer);
            }
        }
    }
    let mut answer = result();
    for path in paths {
        let source = PathBuf::from(&path);
        let prepared = tokio::task::spawn_blocking(move || source_entries(&source))
            .await
            .map_err(|e| e.to_string())?;
        let entries = match prepared {
            Ok(e) => e,
            Err(e) => {
                answer.errors.push(format!("{path}: {e}"));
                continue;
            }
        };
        let name = entries[0]
            .1
            .to_str()
            .ok_or("source filename is not UTF-8")?
            .to_owned();
        let directory = tokio::fs::metadata(&path)
            .await
            .map_err(|e| e.to_string())?
            .is_dir();
        let mut url = reqwest::Url::parse(endpoint).map_err(|e| e.to_string())?;
        url.set_path("/fs/upload-copy");
        url.set_query(None);
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("destDir", dest)
                .append_pair("name", &name)
                .append_pair("directory", if directory { "true" } else { "false" });
        }
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        let failure_sender = sender.clone();
        let producer = tokio::task::spawn_blocking(move || {
            let outcome = (|| {
                let mut tar = tar::Builder::new(ChunkWriter { sender, bytes: 0 });
                tar.sparse(false);
                for (path, relative) in entries {
                    // Recheck types after the bounded source enumeration.
                    let meta = std::fs::symlink_metadata(&path)?;
                    if meta.is_dir() {
                        tar.append_dir(&relative, &path)?;
                    } else if meta.is_file() {
                        tar.append_file(&relative, &mut std::fs::File::open(&path)?)?;
                    } else {
                        return Err(io::Error::other("source changed to a link or special file"));
                    }
                }
                tar.finish()
            })();
            if let Err(e) = outcome {
                let _ = failure_sender.blocking_send(Err(e));
            }
        });
        let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
            receiver.recv().await.map(|chunk| (chunk, receiver))
        });
        let mut request = client
            .post(url)
            .header("Content-Type", "application/x-tar")
            .body(reqwest::Body::wrap_stream(stream));
        if let Some(token) = token {
            request = request.header(
                reqwest::header::COOKIE,
                format!("{}={token}", crate::mcp_http::auth::SESSION_COOKIE),
            );
        }
        let response = request.send().await;
        producer.await.map_err(|e| e.to_string())?;
        match response {
            Ok(response) if response.status().is_success() => {
                let transferred: TransferResultWire = response
                    .json()
                    .await
                    .map_err(|e| e.without_url().to_string())?;
                answer.moved += transferred.moved;
                answer.skipped += transferred.skipped;
            }
            Ok(response) => answer
                .errors
                .push(format!("{path}: upload rejected ({})", response.status())),
            Err(e) => answer
                .errors
                .push(format!("{path}: upload failed: {}", e.without_url())),
        }
    }
    Ok(answer)
}

#[derive(Deserialize)]
struct TransferResultWire {
    moved: u32,
    skipped: u32,
}

fn safe_relative(path: &Path) -> io::Result<()> {
    let value = path
        .to_str()
        .ok_or_else(|| io::Error::other("path is not UTF-8"))?;
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || path.is_absolute()
        || cfg!(windows) && value.contains(['\\', ':'])
        || path
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(io::Error::other("invalid upload path"));
    }
    Ok(())
}

fn destination(query: &UploadQuery, roots: &[String]) -> io::Result<Dir> {
    safe_relative(Path::new(&query.name))?;
    if Path::new(&query.name).components().count() != 1 {
        return Err(io::Error::other("invalid target name"));
    }
    let path = Path::new(&query.dest_dir);
    if !path.is_absolute()
        || query.dest_dir.contains('\0')
        || path.components().any(|p| p == Component::ParentDir)
    {
        return Err(io::Error::other("invalid destination"));
    }
    for root in roots {
        if let Ok(relative) = path.strip_prefix(root) {
            let dir = Dir::open_ambient_dir(root, cap_std::ambient_authority())?;
            // cap-std resolves every component within this root, including links,
            // and holds the resulting directory handle across the whole upload.
            return dir.open_dir(if relative.as_os_str().is_empty() {
                Path::new(".")
            } else {
                relative
            });
        }
    }
    Err(io::Error::other(
        "destination is outside registered repositories",
    ))
}

struct Staging {
    parent: Dir,
    dir: Option<Dir>,
}
impl Staging {
    fn dir(&self) -> &Dir {
        self.dir
            .as_ref()
            .expect("staging directory is open until drop")
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        // Windows directory handles deny deletion. Consume our handle before
        // removing the tree; deleting through the parent keeps it open.
        if let Some(dir) = self.dir.take()
            && let Err(e) = dir.remove_open_dir_all()
        {
            tracing::warn!(source = "remote-transfer", error = %e, "Remote upload staging cleanup failed");
        }
    }
}

pub(crate) async fn receive_copy(
    query: UploadQuery,
    roots: &[String],
    body: Body,
) -> Result<TransferResult, String> {
    receive_copy_with_extractor(query, roots, body, extract_and_publish).await
}

// Keep receive/worker ownership identical for production and cancellation tests.
async fn receive_copy_with_extractor(
    query: UploadQuery,
    roots: &[String],
    body: Body,
    extract: impl FnOnce(Staging, UploadQuery) -> io::Result<TransferResult> + Send + 'static,
) -> Result<TransferResult, String> {
    // Refuse excess concurrency rather than buffering bodies in a queue.
    let _slot = UPLOAD_SLOTS
        .try_acquire()
        .map_err(|_| "remote upload slots are busy".to_string())?;
    let dest = destination(&query, roots).map_err(|e| e.to_string())?;
    match dest.symlink_metadata(&query.name) {
        Ok(meta) if meta.is_symlink() => return Err("upload target is a symlink".into()),
        Ok(_) => {
            // Consume the bounded request before returning headers: otherwise a
            // streaming sender can see a reset instead of this skipped result.
            tokio::time::timeout(UPLOAD_TOTAL_TIMEOUT, receive_body(body, None))
                .await
                .map_err(|_| "remote upload total timeout".to_string())??;
            let mut answer = result();
            answer.skipped = 1;
            return Ok(answer);
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let name = format!(".tuic-upload-{}", uuid::Uuid::new_v4());
    let staging_options = cap_std::fs::DirBuilder::new();
    #[cfg(unix)]
    let staging_options = {
        use cap_std::fs::DirBuilderExt;
        let mut options = staging_options;
        options.mode(0o700);
        options
    };
    dest.create_dir_with(&name, &staging_options)
        .map_err(|e| e.to_string())?;
    let staging_dir = dest.open_dir(&name).map_err(|e| e.to_string())?;
    let stage = Staging {
        parent: dest,
        dir: Some(staging_dir),
    };
    let archive = stage
        .dir()
        .open_with("archive", OpenOptions::new().write(true).create_new(true))
        .map_err(|e| e.to_string())?;
    let mut archive = tokio::fs::File::from_std(archive.into_std());
    tokio::time::timeout(UPLOAD_TOTAL_TIMEOUT, receive_body(body, Some(&mut archive)))
        .await
        .map_err(|_| "remote upload total timeout".to_string())??;
    archive.sync_all().await.map_err(|e| e.to_string())?;
    drop(archive);
    tokio::task::spawn_blocking(move || {
        // A cancelled handler cannot release a slot while extraction still runs.
        let _slot = _slot;
        extract(stage, query)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

async fn receive_body(body: Body, mut archive: Option<&mut tokio::fs::File>) -> Result<(), String> {
    let mut stream = body.into_data_stream();
    let mut size = 0u64;
    loop {
        let chunk = tokio::time::timeout(UPLOAD_IDLE_TIMEOUT, stream.next())
            .await
            .map_err(|_| "remote upload idle timeout".to_string())?;
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|e| e.to_string())?;
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or(UPLOAD_SIZE_ERROR)?;
        if size > MAX_UPLOAD_BYTES {
            return Err(UPLOAD_SIZE_ERROR.into());
        }
        if let Some(file) = archive.as_mut() {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn create_upload_dirs(data: &Dir, path: &Path) -> io::Result<()> {
    let mut builder = cap_std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use cap_std::fs::DirBuilderExt;
        builder.mode(0o755);
    }
    data.create_dir_with(path, &builder)
}

fn extract_and_publish(stage: Staging, query: UploadQuery) -> io::Result<TransferResult> {
    stage.dir().create_dir("data")?;
    let data = stage.dir().open_dir("data")?;
    let mut tar = tar::Archive::new(stage.dir().open("archive")?.into_std());
    let mut bytes = 0u64;
    #[cfg(unix)]
    let mut directory_modes = Vec::new();
    for (index, entry) in tar.entries()?.enumerate() {
        if index >= MAX_ENTRIES {
            return Err(io::Error::other("too many upload entries"));
        }
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        safe_relative(&path)?;
        if path.components().next() != Path::new(&query.name).components().next()
            || (!query.directory && path != Path::new(&query.name))
        {
            return Err(io::Error::other(
                "archive path does not match upload target",
            ));
        }
        let kind = entry.header().entry_type();
        if kind.is_dir() && query.directory {
            create_upload_dirs(&data, &path)?;
            #[cfg(unix)]
            {
                use cap_std::fs::PermissionsExt;
                let allowed =
                    data.metadata(&path)?.permissions().mode() & entry.header().mode()? & 0o755;
                directory_modes.push((path.clone(), allowed));
            }
        } else if kind.is_file() {
            bytes = bytes
                .checked_add(entry.size())
                .ok_or_else(|| io::Error::other("extracted size overflow"))?;
            if bytes > MAX_UPLOAD_BYTES {
                return Err(io::Error::other("extracted upload exceeds 256 MiB"));
            }
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                create_upload_dirs(&data, parent)?;
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use cap_std::fs::OpenOptionsExt;
                let mode = entry.header().mode()?;
                options.mode(mode & if mode & 0o111 != 0 { 0o755 } else { 0o644 });
            }
            let mut file = data.open_with(&path, &options)?.into_std();
            let copied = io::copy(&mut entry, &mut file)?;
            if copied != entry.size() {
                return Err(io::Error::other("truncated upload entry"));
            }
            file.sync_all()?;
        } else {
            return Err(io::Error::other(
                "archive links and special files are forbidden",
            ));
        }
    }
    let meta = data.symlink_metadata(&query.name)?;
    if meta.is_dir() != query.directory {
        return Err(io::Error::other("upload type does not match target"));
    }
    #[cfg(unix)]
    let published_dir = if query.directory {
        Some(data.open_dir(&query.name)?)
    } else {
        None
    };
    let mut answer = result();
    match publish(&data, &stage.parent, &query.name) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use cap_std::fs::PermissionsExt;
                // Rename needs writable directories; reduce modes only after publication.
                // Held handles keep chmod on our tree if a destination name is replaced.
                directory_modes
                    .sort_by_key(|(path, _)| std::cmp::Reverse(path.components().count()));
                if let Some(dir) = published_dir {
                    for (path, mode) in directory_modes {
                        let relative = path.strip_prefix(&query.name).map_err(io::Error::other)?;
                        let relative = if relative.as_os_str().is_empty() {
                            Path::new(".")
                        } else {
                            relative
                        };
                        if let Err(e) =
                            dir.set_permissions(relative, cap_std::fs::Permissions::from_mode(mode))
                        {
                            // Publication already succeeded; a retry would only skip this copy.
                            tracing::warn!(source = "remote-transfer", path = ?path, error = %e,
                                "Published remote copy directory permissions could not be applied");
                        }
                    }
                }
            }
            answer.moved = 1;
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => answer.skipped = 1,
        Err(e) => return Err(e),
    }
    Ok(answer)
}

/// Both paths are single leaf names relative to held directory handles.
/// No-replace is atomic, so a conflicting file created during upload is skipped.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn publish(source: &Dir, dest: &Dir, name: &str) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let name = std::ffi::CString::new(name)?;
    // SAFETY: valid directory fds and NUL-terminated single-component names.
    #[cfg(target_os = "linux")]
    let rc = unsafe {
        libc::renameat2(
            source.as_raw_fd(),
            name.as_ptr(),
            dest.as_raw_fd(),
            name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let rc = unsafe {
        libc::renameatx_np(
            source.as_raw_fd(),
            name.as_ptr(),
            dest.as_raw_fd(),
            name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
fn publish(source: &Dir, dest: &Dir, name: &str) -> io::Result<()> {
    use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
    use cap_std::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Wdk::Storage::FileSystem::{
        FILE_RENAME_INFORMATION, FileRenameInformation, NtSetInformationFile,
    };
    use windows_sys::Win32::Foundation::{RtlNtStatusToDosError, STATUS_OBJECT_NAME_COLLISION};
    use windows_sys::Win32::Storage::FileSystem::{DELETE, SYNCHRONIZE};
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    let mut options = OpenOptions::new();
    options
        .access_mode(DELETE | SYNCHRONIZE)
        .maybe_dir(true)
        .follow(FollowSymlinks::No);
    let file = source.open_with(name, &options)?;
    let wide: Vec<u16> = name.encode_utf16().collect();
    let offset = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);
    // Windows requires at least the fixed structure size, including tail padding.
    let length = (offset + wide.len() * 2).max(std::mem::size_of::<FILE_RENAME_INFORMATION>());
    // A word-aligned allocation holds the variable-length native structure.
    let mut buffer = vec![0usize; length.div_ceil(std::mem::size_of::<usize>())];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: buffer is aligned and large enough; both directory and source
    // handles remain live. ReplaceIfExists stays false. The leaf name is relative
    // to the held target directory, so no ambient/symlink target is followed.
    let outcome = unsafe {
        (*info).RootDirectory = dest.as_raw_handle();
        (*info).FileNameLength = (wide.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            wide.as_ptr(),
            buffer.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
            wide.len(),
        );
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut status,
            info.cast(),
            length as u32,
            FileRenameInformation,
        )
    };
    if outcome >= 0 {
        Ok(())
    } else if outcome == STATUS_OBJECT_NAME_COLLISION {
        Err(io::ErrorKind::AlreadyExists.into())
    } else {
        Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(outcome) } as i32,
        ))
    }
}

#[cfg(test)]
#[path = "remote_transfer_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "remote_transfer_critic_tests.rs"]
mod critic_tests;
