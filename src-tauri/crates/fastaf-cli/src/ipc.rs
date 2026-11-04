//! HTTP-over-IPC client for communicating with a running FastAF instance.
//!
//! Unix: connects via Unix domain socket at `<config_dir>/mcp.sock`
//! Windows: connects via named pipe at `\\.\pipe\tuicommander-mcp`

use std::io::{self, Read, Write};
use tuic_ipc::app_instance::current_app_instance;

pub(crate) fn config_dir() -> std::path::PathBuf {
    current_app_instance().config_dir_from(
        dirs::config_dir().as_deref(),
        &dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")),
    )
}

#[cfg(unix)]
fn socket_path() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("TUIC_SOCKET") {
        return std::path::PathBuf::from(path);
    }
    tuic_ipc::socket_path(current_app_instance(), &config_dir(), &std::env::temp_dir())
}

#[cfg(unix)]
fn connect() -> io::Result<std::os::unix::net::UnixStream> {
    let path = socket_path();
    std::os::unix::net::UnixStream::connect(&path).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("Cannot connect to FastAF at {}: {e}", path.display()),
        )
    })
}

#[cfg(windows)]
fn connect() -> io::Result<std::fs::File> {
    let path = tuic_ipc::PIPE_NAME;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| io::Error::new(e.kind(), format!("Cannot connect to FastAF at {path}: {e}")))
}

/// HTTP response parsed by the shared IPC framing module.
pub struct Response(tuic_ipc::http::Response);

impl From<tuic_ipc::http::Response> for Response {
    fn from(response: tuic_ipc::http::Response) -> Self {
        Self(response)
    }
}

impl std::ops::Deref for Response {
    type Target = tuic_ipc::http::Response;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Response {
    pub fn json(&self) -> serde_json::Result<serde_json::Value> {
        serde_json::from_str(&self.body)
    }
}

/// Send an HTTP request over the IPC socket and return the response.
pub fn request(method: &str, path: &str, body: Option<&str>) -> io::Result<Response> {
    request_with_headers(method, path, body, &[])
}

/// Same as [`request`], with caller-supplied extra request headers.
pub fn request_with_headers(
    method: &str,
    path: &str,
    body: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> io::Result<Response> {
    request_with_headers_and_timeout(method, path, body, extra_headers, None)
}

pub fn request_with_headers_and_timeout(
    method: &str,
    path: &str,
    body: Option<&str>,
    extra_headers: &[(&str, &str)],
    read_timeout: Option<std::time::Duration>,
) -> io::Result<Response> {
    let mut stream = connect()?;
    #[cfg(unix)]
    {
        let timeout = Some(read_timeout.unwrap_or(std::time::Duration::from_secs(3)));
        stream.set_read_timeout(timeout)?;
        stream.set_write_timeout(Some(std::time::Duration::from_secs(3)))?;
    }
    #[cfg(windows)]
    let _ = read_timeout;

    stream.write_all(&tuic_ipc::http::request(method, path, body, extra_headers))?;
    stream.flush()?;
    let mut decoder = tuic_ipc::http::ResponseDecoder::default();
    let mut bytes = [0; 4096];
    loop {
        let count = stream.read(&mut bytes)?;
        decoder.push(&bytes[..count]);
        if let Some(response) = decoder.response(count == 0)? {
            return Ok(Response::from(response));
        }
    }
}

/// Convenience: GET request
pub fn get(path: &str) -> io::Result<Response> {
    request("GET", path, None)
}

/// Convenience: POST request with JSON body
pub fn post(path: &str, body: &str) -> io::Result<Response> {
    request("POST", path, Some(body))
}

/// Convenience: PUT request with JSON body
pub fn put(path: &str, body: &str) -> io::Result<Response> {
    request("PUT", path, Some(body))
}

/// Convenience: DELETE request
pub fn delete(path: &str) -> io::Result<Response> {
    request("DELETE", path, None)
}

/// Check if FastAF is running
pub fn is_running() -> bool {
    get("/health").is_ok()
}

/// Try to launch FastAF if not running
pub fn ensure_running() -> io::Result<()> {
    if is_running() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-a")
            .arg("FastAF")
            .spawn()
            .map_err(|e| io::Error::new(e.kind(), format!("Failed to launch FastAF: {e}")))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try desktop entry first, fall back to direct binary
        let result = std::process::Command::new("xdg-open")
            .arg("tuic://")
            .spawn();
        if result.is_err() {
            std::process::Command::new("tuicommander")
                .spawn()
                .map_err(|e| io::Error::new(e.kind(), format!("Failed to launch FastAF: {e}")))?;
        }
    }

    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        std::process::Command::new(format!("{local_app_data}\\FastAF\\FastAF.exe"))
            .spawn()
            .map_err(|e| io::Error::new(e.kind(), format!("Failed to launch FastAF: {e}")))?;
    }

    // Wait for socket to become available (up to 10s)
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if is_running() {
            return Ok(());
        }
    }

    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "FastAF did not start within 10 seconds",
    ))
}
