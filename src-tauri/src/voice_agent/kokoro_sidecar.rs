//! Local kokoro TTS via the mlx-audio Python sidecar (Apple Silicon only).
//! Port of `ttsHandler.js` + `kokoro_server.py` from ksg98/groq_local_stt.
//!
//! NDJSON protocol over stdio:
//!   stdin : {"cmd":"speak","id":1,"text":"...","voice":"af_heart","speed":1.0}
//!           {"cmd":"cancel"} {"cmd":"shutdown"}
//!   stdout: {"type":"status","state":"loading|ready|error|stopped",...}
//!           {"type":"audio","id":1,"sr":24000,"b64":"<le int16 PCM>"}
//!           {"type":"done","id":1} {"type":"error","id":1,"message":"..."}
//!           {"type":"cancelled"}
//!
//! The sidecar is spawned via uv (resolves mlx-audio + misaki on first run,
//! downloads the Kokoro-82M model from HF) and kept warm until app exit.

use base64::Engine;
use parking_lot::Mutex;
use serde::Serialize;
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const SIDECAR_SCRIPT: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/python/kokoro_server.py"));
const MLX_AUDIO_SPEC: &str = "mlx-audio==0.4.4";
/// First start may resolve Python deps + download the ~330 MB model.
const READY_TIMEOUT: Duration = Duration::from_secs(300);
/// Streamed audio arrives every ~0.5 s once synthesis is running.
const EVENT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Default)]
pub struct KokoroStatus {
    /// stopped | starting | loading | ready | error | unsupported
    pub state: String,
    /// Progress line while starting (uv resolve / HF download), from stderr.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub enum SidecarEvent {
    Audio { sample_rate: u32, samples: Vec<f32> },
    Done,
    Error(String),
}

pub struct KokoroSidecar {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    status: Mutex<KokoroStatus>,
    pending: Mutex<Option<mpsc::Sender<SidecarEvent>>>,
    next_id: AtomicU64,
}

static SIDECAR: LazyLock<KokoroSidecar> = LazyLock::new(|| KokoroSidecar {
    child: Mutex::new(None),
    stdin: Mutex::new(None),
    status: Mutex::new(KokoroStatus {
        state: "stopped".to_string(),
        ..Default::default()
    }),
    pending: Mutex::new(None),
    next_id: AtomicU64::new(1),
});

pub fn sidecar() -> &'static KokoroSidecar {
    &SIDECAR
}

/// Locate the uv binary (macOS install locations + PATH).
pub fn find_uv() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/uv"),
        PathBuf::from("/usr/local/bin/uv"),
        PathBuf::from("/usr/bin/uv"),
        home.join(".local/bin/uv"),
        home.join(".cargo/bin/uv"),
    ];
    for c in candidates {
        if c.exists() {
            return Some(c);
        }
    }
    let out = Command::new("which").arg("uv").output().ok()?;
    if out.status.success() {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() && PathBuf::from(&path).exists() {
            return Some(PathBuf::from(path));
        }
    }
    None
}

impl KokoroSidecar {
    pub fn status(&self) -> KokoroStatus {
        self.status.lock().clone()
    }

    pub fn is_running(&self) -> bool {
        self.child.lock().is_some()
    }

    fn set_status(&self, app: Option<&AppHandle>, status: KokoroStatus) {
        *self.status.lock() = status.clone();
        if let Some(app) = app {
            let _ = app.emit("voice-tts-status", &status);
        }
    }

    fn write_command(&self, value: &serde_json::Value) -> bool {
        let mut stdin = self.stdin.lock();
        if let Some(w) = stdin.as_mut() {
            let line = format!("{value}\n");
            if w.write_all(line.as_bytes()).and_then(|_| w.flush()).is_ok() {
                return true;
            }
        }
        false
    }

    /// Spawn the sidecar if it isn't running. Returns immediately; readiness is
    /// tracked via status ("ready") and awaited by `speak_blocking`.
    pub fn ensure_started(&self, app: &AppHandle) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        if !(cfg!(target_os = "macos") && cfg!(target_arch = "aarch64")) {
            self.set_status(Some(app), KokoroStatus { state: "unsupported".into(), ..Default::default() });
            return Err("Kokoro TTS requires Apple Silicon".to_string());
        }
        let Some(uv) = find_uv() else {
            self.set_status(Some(app), KokoroStatus { state: "unsupported".into(), ..Default::default() });
            return Err("Kokoro TTS requires uv (https://docs.astral.sh/uv) — falling back to cloud".to_string());
        };

        // Materialize the bundled script under the config dir so uv can run it
        // identically in dev and packaged builds.
        let script_dir = crate::config::config_dir().join("python");
        std::fs::create_dir_all(&script_dir).map_err(|e| format!("mkdir failed: {e}"))?;
        let script_path = script_dir.join("kokoro_server.py");
        std::fs::write(&script_path, SIDECAR_SCRIPT).map_err(|e| format!("script write failed: {e}"))?;

        self.set_status(Some(app), KokoroStatus { state: "starting".into(), ..Default::default() });

        let path_env = format!(
            "/opt/homebrew/bin:/usr/local/bin:{}",
            std::env::var("PATH").unwrap_or_default()
        );
        let mut child = Command::new(&uv)
            .args([
                "run", "--no-project", "--python", "3.12",
                "--with", MLX_AUDIO_SPEC, "--with", "misaki[en]",
                "python",
            ])
            .arg(&script_path)
            .env("PATH", path_env)
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                self.set_status(Some(app), KokoroStatus {
                    state: "error".into(),
                    message: Some(e.to_string()),
                    ..Default::default()
                });
                format!("Failed to spawn kokoro sidecar: {e}")
            })?;

        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("sidecar stderr unavailable")?;
        *self.stdin.lock() = child.stdin.take();
        *self.child.lock() = Some(child);

        // stdout reader: NDJSON protocol
        let app_out = app.clone();
        std::thread::Builder::new()
            .name("kokoro-stdout".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    sidecar().handle_protocol_line(&app_out, &msg);
                }
                // EOF: process exited
                sidecar().on_exit(&app_out);
            })
            .map_err(|e| format!("reader thread spawn failed: {e}"))?;

        // stderr reader: surface progress while loading (uv resolve / HF download)
        let app_err = app.clone();
        std::thread::Builder::new()
            .name("kokoro-stderr".into())
            .spawn(move || {
                let mut last_forward = Instant::now() - Duration::from_secs(1);
                for line in BufReader::new(stderr).lines() {
                    let Ok(line) = line else { break };
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    tracing::debug!(source = "voice_tts", "kokoro stderr: {}", &line[..line.len().min(400)]);
                    let s = sidecar();
                    let state = s.status.lock().state.clone();
                    if (state == "starting" || state == "loading")
                        && last_forward.elapsed() > Duration::from_millis(500)
                    {
                        last_forward = Instant::now();
                        let detail: String = line.chars().take(160).collect();
                        let mut status = s.status.lock().clone();
                        status.detail = Some(detail);
                        s.set_status(Some(&app_err), status);
                    }
                }
            })
            .map_err(|e| format!("stderr thread spawn failed: {e}"))?;

        Ok(())
    }

    fn handle_protocol_line(&self, app: &AppHandle, msg: &serde_json::Value) {
        match msg.get("type").and_then(|v| v.as_str()) {
            Some("status") => {
                self.set_status(Some(app), KokoroStatus {
                    state: msg.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    detail: None,
                    message: msg.get("message").and_then(|v| v.as_str()).map(String::from),
                });
            }
            Some("audio") => {
                let sr = msg.get("sr").and_then(|v| v.as_u64()).unwrap_or(24_000) as u32;
                let Some(b64) = msg.get("b64").and_then(|v| v.as_str()) else { return };
                let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
                    return;
                };
                let samples: Vec<f32> = bytes
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                    .collect();
                if let Some(tx) = self.pending.lock().as_ref() {
                    let _ = tx.send(SidecarEvent::Audio { sample_rate: sr, samples });
                }
            }
            Some("done") => {
                if let Some(tx) = self.pending.lock().as_ref() {
                    let _ = tx.send(SidecarEvent::Done);
                }
            }
            Some("error") => {
                let message = msg
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("kokoro error")
                    .to_string();
                if let Some(tx) = self.pending.lock().as_ref() {
                    let _ = tx.send(SidecarEvent::Error(message));
                }
            }
            // "cancelled" is informational; in-flight jobs still emit "done".
            _ => {}
        }
    }

    fn on_exit(&self, app: &AppHandle) {
        *self.stdin.lock() = None;
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.wait();
        }
        // A pending speak would otherwise block until timeout.
        if let Some(tx) = self.pending.lock().take() {
            let _ = tx.send(SidecarEvent::Error("kokoro sidecar exited".into()));
        }
        let state = self.status.lock().state.clone();
        if state != "error" {
            self.set_status(Some(app), KokoroStatus { state: "stopped".into(), ..Default::default() });
        }
    }

    /// Block until the model reports ready (or error/timeout).
    fn wait_ready(&self) -> Result<(), String> {
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            let status = self.status();
            match status.state.as_str() {
                "ready" => return Ok(()),
                "error" => {
                    return Err(status.message.unwrap_or_else(|| "kokoro failed to start".into()));
                }
                "stopped" | "unsupported" => {
                    return Err("kokoro sidecar is not running".to_string());
                }
                _ => {}
            }
            if Instant::now() > deadline {
                return Err("kokoro model load timed out".to_string());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Synthesize one sentence, invoking `on_audio` for each streamed PCM chunk.
    /// `on_audio` returns false to abort (stale generation) — a cancel is sent
    /// and remaining chunks are drained. Blocking; call from a worker thread.
    pub fn speak_blocking(
        &self,
        text: &str,
        voice: &str,
        speed: f32,
        on_audio: &mut dyn FnMut(u32, Vec<f32>) -> bool,
    ) -> Result<(), String> {
        self.wait_ready()?;

        let (tx, rx) = mpsc::channel();
        *self.pending.lock() = Some(tx);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let ok = self.write_command(&serde_json::json!({
            "cmd": "speak",
            "id": id,
            "text": text,
            "voice": voice,
            "speed": speed,
        }));
        if !ok {
            *self.pending.lock() = None;
            return Err("kokoro sidecar stdin closed".to_string());
        }

        let mut aborted = false;
        let result = loop {
            match rx.recv_timeout(EVENT_TIMEOUT) {
                Ok(SidecarEvent::Audio { sample_rate, samples }) => {
                    if !aborted && !on_audio(sample_rate, samples) {
                        aborted = true;
                        self.write_command(&serde_json::json!({"cmd": "cancel"}));
                    }
                }
                Ok(SidecarEvent::Done) => break Ok(()),
                Ok(SidecarEvent::Error(e)) => break Err(e),
                Err(_) => break Err("kokoro synthesis timed out".to_string()),
            }
        };
        *self.pending.lock() = None;
        result
    }

    /// Drop queued + in-flight synthesis (barge-in).
    pub fn cancel(&self) {
        if self.is_running() {
            self.write_command(&serde_json::json!({"cmd": "cancel"}));
        }
    }

    /// Graceful shutdown: ask the sidecar to exit, then escalate.
    pub fn shutdown(&self) {
        let had_child = self.child.lock().is_some();
        if !had_child {
            return;
        }
        self.write_command(&serde_json::json!({"cmd": "shutdown"}));
        *self.stdin.lock() = None; // EOF nudges the stdin loop too
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            {
                let mut guard = self.child.lock();
                match guard.as_mut().map(|c| c.try_wait()) {
                    None => break, // reader thread reaped it
                    Some(Ok(Some(_))) => {
                        guard.take();
                        break;
                    }
                    Some(Ok(None)) => {}
                    Some(Err(_)) => {
                        guard.take();
                        break;
                    }
                }
                if Instant::now() > deadline {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        *self.status.lock() = KokoroStatus { state: "stopped".into(), ..Default::default() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_script_speaks_the_protocol() {
        // Guard against the vendored script drifting from what this module expects.
        assert!(SIDECAR_SCRIPT.contains("\"cmd\""));
        assert!(SIDECAR_SCRIPT.contains("mlx_audio"));
        for token in ["speak", "cancel", "shutdown", "audio", "done"] {
            assert!(SIDECAR_SCRIPT.contains(token), "missing protocol token: {token}");
        }
    }

    #[test]
    fn protocol_audio_line_decodes_to_samples() {
        // 4 samples: 0, +0.5, -0.5, max
        let pcm: Vec<u8> = [0i16, 16384, -16384, 32767]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&pcm);
        let msg = serde_json::json!({"type": "audio", "id": 1, "sr": 24000, "b64": b64});

        // Decode the same way handle_protocol_line does (unit-test the math,
        // not the AppHandle plumbing).
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(msg["b64"].as_str().unwrap())
            .unwrap();
        let samples: Vec<f32> = bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();
        assert_eq!(samples.len(), 4);
        assert!((samples[1] - 0.5).abs() < 0.001);
        assert!((samples[2] + 0.5).abs() < 0.001);
    }

    #[test]
    fn status_serializes_without_empty_fields() {
        let s = KokoroStatus { state: "ready".into(), ..Default::default() };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"state":"ready"}"#);
    }
}
