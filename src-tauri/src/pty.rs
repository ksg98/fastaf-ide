use parking_lot::Mutex;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::input_line_buffer::{InputAction, InputLineBuffer};
use crate::output_parser::{OutputParser, ParsedEvent};
use crate::state::{
    AppState, ChangedRow, EscapeAwareBuffer, KittyAction, KittyKeyboardState,
    MAX_CONCURRENT_SESSIONS, OUTPUT_RING_BUFFER_CAPACITY, OrchestratorStats, OutputRingBuffer,
    PtyConfig, PtyOutput, PtySession, Utf8ReadBuffer, VT_LOG_BUFFER_CAPACITY, VtLogBuffer,
    strip_kitty_sequences,
};
use crate::worktree::{
    WorktreeConfig, WorktreeResult, create_worktree_with_stale_recovery, remove_worktree_internal,
};

/// Get the platform-appropriate default shell when no override is configured.
pub(crate) fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Convert a Windows drive-letter path to a WSL `/mnt/` path.
/// E.g. `C:\Users\foo\repos` → `/mnt/c/Users/foo/repos`.
/// Returns the input unchanged if it's not a Windows drive-letter path.
pub(crate) fn windows_to_wsl_path(path: &str) -> String {
    let bytes = path.as_bytes();
    // Match "X:\" or "X:/" where X is an ASCII letter
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = &path[3..].replace('\\', "/");
        format!("/mnt/{drive}/{rest}")
    } else {
        path.to_string()
    }
}

/// Check whether a shell string targets WSL (e.g. `wsl.exe`, `wsl.exe -d Ubuntu`).
/// Handles both forward-slash and backslash path separators so it works
/// correctly regardless of compilation target (cross-compiled from macOS/Linux).
pub(crate) fn is_wsl_shell(shell: &str) -> bool {
    let exe = shell.split_whitespace().next().unwrap_or("");
    // Extract filename from the last path separator (either / or \)
    let filename = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    // Strip .exe extension if present
    let stem = filename
        .strip_suffix(".exe")
        .or_else(|| filename.strip_suffix(".EXE"))
        .unwrap_or(filename);
    stem.eq_ignore_ascii_case("wsl")
}

/// Remove parent-process preferences that must not become defaults for a new
/// independent PTY. Call this immediately after constructing the command so an
/// explicit per-agent environment may still restore the variable deliberately.
pub(crate) fn sanitize_pty_parent_env(cmd: &mut CommandBuilder) {
    // FastAF may itself be launched from Codex, whose NO_COLOR belongs
    // to that parent process. Do not leak the opt-out into independent PTY
    // sessions. Commands can still request monochrome output through their own
    // explicit CLI flags or per-command environment.
    cmd.env_remove("NO_COLOR");
}

/// Inject the Unix-style env vars that Claude Code / Ink need to detect
/// terminal capabilities (color, kitty keyboard protocol, etc.).
fn inject_unix_terminal_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Signal kitty keyboard protocol support so apps (e.g. Claude Code / Ink)
    // detect it via heuristic precheck and proceed to query confirmation.
    cmd.env("KITTY_WINDOW_ID", "1");
    // Announce as ghostty so Claude Code's terminal detection allow-list
    // enables kitty keyboard protocol. CC ≥v2.1.52 only recognizes
    // WezTerm, ghostty, and iTerm.app — "kitty" was removed from the list.
    // ghostty is chosen because it has no iTerm/WezTerm-specific side effects.
    // On macOS this also prevents /etc/zshrc sourcing zshrc_Apple_Terminal.
    cmd.env("TERM_PROGRAM", "ghostty");
    // iTerm2 feature-reporting protocol: advertise capabilities so tools
    // (cargo, uv, mise, etc.) can detect support without a TERM_PROGRAM whitelist.
    // T2=24-bit color, P=OSC 9;4 progress, H=OSC 8 hyperlinks, U=unicode,
    // B=bracketed paste, Sy=synchronized output, M=mouse, F=focus reporting.
    cmd.env("TERM_FEATURES", "T2PHUBSyMF");
    // CC also checks TERM_PROGRAM_VERSION — missing or matching /^[0-2]\./
    // causes rejection.  Use a value that passes the gate.
    cmd.env("TERM_PROGRAM_VERSION", "3.0.0");
    // Prevent nested-session detection when FastAF itself runs
    // inside a Claude Code session (CLAUDECODE env var would propagate).
    cmd.env_remove("CLAUDECODE");
    if let Ok(lang) = std::env::var("LANG") {
        cmd.env("LANG", lang);
    } else {
        // Fallback: ensure UTF-8 is available even when LANG is completely unset
        cmd.env("LANG", "en_US.UTF-8");
    }
    // Agent Teams: always inject feature flag so CC unlocks team tools
    cmd.env("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1");
}

/// Build a CommandBuilder for the given shell with platform-appropriate flags.
///
/// The `shell` string may contain arguments (e.g. `wsl.exe -d Ubuntu`).
/// The first whitespace-delimited token is the executable; the rest are args.
pub(crate) fn build_shell_command(shell: &str) -> CommandBuilder {
    let mut parts = shell.split_whitespace();
    let exe = parts.next().unwrap_or(shell);
    #[allow(unused_mut)]
    let mut cmd = CommandBuilder::new(exe);
    sanitize_pty_parent_env(&mut cmd);
    for arg in parts {
        cmd.arg(arg);
    }

    #[cfg(not(windows))]
    {
        // Login shell flag is Unix-only; PowerShell/cmd.exe don't support -l
        cmd.arg("-l");
        inject_unix_terminal_env(&mut cmd);
    }

    #[cfg(windows)]
    {
        // On Windows, if the shell targets WSL, inject Unix-style env vars
        // so that tools inside WSL (Claude Code, etc.) detect terminal
        // capabilities correctly. These are passed through to the Linux
        // environment by wsl.exe.
        if is_wsl_shell(shell) {
            inject_unix_terminal_env(&mut cmd);
        }
    }

    cmd
}

/// Niceness applied to every PTY child process. A child inherits the parent's
/// nice value at fork time, so deprioritizing the shell deprioritizes every
/// process it later spawns — compilers, bundlers, test runners. The intent is
/// that a heavy `cargo build` yields CPU to TUIC's own render thread and the
/// rest of the system *under contention*, while still running at full speed on
/// an idle machine (`nice` only bites when something else wants the core).
///
/// +10 was chosen over macOS QoS-background (`taskpolicy -b`), which pins the
/// workload to the E-cores on Apple Silicon and makes builds crawl even when
/// the P-cores are idle.
///
/// Overridable at launch via `TUIC_PTY_NICE` so the right value can be tuned on
/// the real app without recompiling (nice 0..19; values outside that range are
/// clamped by the kernel).
#[cfg(unix)]
const PTY_CHILD_NICE_DEFAULT: i32 = 10;

/// Capacity of the per-session raw-byte flight recorder (story 056-7545).
/// 2 MiB ≈ several minutes of heavy agent output — enough to capture the
/// corruption window when a duplication shows up in the wild.
const PTY_RAW_RING_CAP: usize = 2 * 1024 * 1024;

/// Resolve the nice value to apply to PTY children: `TUIC_PTY_NICE` env override
/// if set and parseable, else [`PTY_CHILD_NICE_DEFAULT`].
#[cfg(unix)]
fn pty_child_nice() -> i32 {
    std::env::var("TUIC_PTY_NICE")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(PTY_CHILD_NICE_DEFAULT)
}

/// Lower the scheduling priority of a freshly-spawned PTY child so the workloads
/// it spawns don't starve TUIC and the system.
///
/// Failure is logged and ignored: a build at the default priority is a degraded
/// experience, not a broken one. Lowering priority on a process owned by the
/// same user is always permitted, so a non-zero return here is unexpected.
///
/// Unix (macOS, Linux): `setpriority` to nice +10.
#[cfg(unix)]
fn lower_pty_child_priority(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    let nice = pty_child_nice();
    // SAFETY: setpriority takes scalar args and is async-signal-safe; `pid` is
    // the id of the child we just spawned.
    let rc = unsafe { libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, nice) };
    if rc != 0 {
        tracing::warn!(
            pid,
            nice,
            error = %std::io::Error::last_os_error(),
            "failed to lower PTY child priority"
        );
    }
}

/// Windows: `BELOW_NORMAL_PRIORITY_CLASS` — the priority-class analog of nice
/// +10. NOT `IDLE_PRIORITY_CLASS`, which only runs the process when the system
/// is otherwise idle (the Windows equivalent of macOS QoS-background) and would
/// make builds crawl. macOS/Windows lack hard CPU affinity that works on the
/// primary target, so priority lowering is the one strategy portable to all
/// three platforms.
#[cfg(windows)]
fn lower_pty_child_priority(pid: Option<u32>) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        BELOW_NORMAL_PRIORITY_CLASS, OpenProcess, PROCESS_SET_INFORMATION, SetPriorityClass,
    };
    let Some(pid) = pid else { return };
    // SAFETY: Win32 calls with scalar/handle args; `pid` is the id of the child
    // we just spawned. The handle is closed on every path once obtained.
    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        if handle.is_null() {
            tracing::warn!(
                pid,
                error = %std::io::Error::last_os_error(),
                "failed to open PTY child to lower priority"
            );
            return;
        }
        if SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS) == 0 {
            tracing::warn!(
                pid,
                error = %std::io::Error::last_os_error(),
                "failed to lower PTY child priority"
            );
        }
        CloseHandle(handle);
    }
}

#[cfg(not(any(unix, windows)))]
fn lower_pty_child_priority(_pid: Option<u32>) {}

/// macOS thread QoS for the interactive terminal path.
///
/// `lower_pty_child_priority` nices compiler/test workloads *down*, but on
/// Apple Silicon the scheduler is QoS-band driven: nice only reorders threads
/// *within* a band, so under a saturating `cargo build` our PTY reader, frame
/// ticker, and keystroke-write threads — all at default QoS — still waited
/// behind the compiler's many default-QoS worker threads. Raising our own
/// threads to USER_INTERACTIVE puts the interactive path in a higher band, the
/// lever that keeps typing/echo responsive under load (the native trick AppKit
/// apps like iTerm get for free on the foreground GUI thread).
///
/// macOS-only: Linux/Windows have no per-thread QoS equivalent that helps here
/// (raising priority needs privilege); there we rely on lowering children.
#[cfg(target_os = "macos")]
mod thread_qos {
    use std::os::raw::{c_int, c_uint};

    /// `QOS_CLASS_USER_INTERACTIVE` from `<sys/qos.h>`.
    const QOS_CLASS_USER_INTERACTIVE: c_uint = 0x21;

    unsafe extern "C" {
        fn pthread_set_qos_class_self_np(qos_class: c_uint, relative_priority: c_int) -> c_int;
        #[cfg(test)]
        fn pthread_get_qos_class_np(
            thread: libc::pthread_t,
            qos_class: *mut c_uint,
            relative_priority: *mut c_int,
        ) -> c_int;
    }

    /// Raise the calling thread to USER_INTERACTIVE QoS. Best-effort: a failure
    /// leaves the thread at its current QoS (degraded latency, not broken), so
    /// the non-zero return is intentionally ignored.
    pub(super) fn raise_self_to_user_interactive() {
        // SAFETY: extern "C" call with scalar args; affects only the calling thread.
        unsafe {
            pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
        }
    }

    /// Read back the calling thread's QoS class. Test-only verification helper.
    #[cfg(test)]
    pub(super) fn current_qos_class() -> c_uint {
        let mut class: c_uint = 0;
        let mut rel: c_int = 0;
        // SAFETY: out-params point to valid stack locals; pthread_self is always valid.
        unsafe {
            pthread_get_qos_class_np(libc::pthread_self(), &mut class, &mut rel);
        }
        class
    }
}

/// Raise the calling thread's scheduling QoS for the interactive terminal I/O
/// path. macOS-only (see [`thread_qos`]); a no-op on other platforms.
#[cfg(target_os = "macos")]
fn raise_thread_for_interactive_io() {
    thread_qos::raise_self_to_user_interactive();
}

#[cfg(not(target_os = "macos"))]
fn raise_thread_for_interactive_io() {}

/// Resolve the shell to use: explicit override > env default > platform default.
pub(crate) fn resolve_shell(override_shell: Option<String>) -> String {
    let shell = override_shell.unwrap_or_else(default_shell);
    crate::cli::expand_tilde(&shell)
}

/// Which family of shell is running inside a PTY.
///
/// Used by the frontend to decide whether control characters like Ctrl-U are
/// honoured (POSIX readline) or echoed literally (`cmd.exe`, PowerShell).
/// Classifying by the shell command rather than by host OS is the whole point
/// of story 1274-2e38: Git Bash, Cygwin, MSYS and WSL all run on Windows yet
/// support Ctrl-U, so a host-OS check alone is wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ShellFamily {
    /// POSIX shell with readline semantics: sh, bash, zsh, fish, dash, ksh,
    /// and friends — including WSL (spawns a Linux shell) and Git Bash /
    /// Cygwin / MSYS (bash compiled for Windows).
    Posix,
    /// Native Windows shell that treats Ctrl-U as a literal character:
    /// cmd.exe, PowerShell, pwsh.
    WindowsNative,
    /// Shell basename didn't match any known set. Callers should fall back to
    /// the safer default for their host (on Windows: skip Ctrl-U; on
    /// Unix: send it).
    Unknown,
}

/// Classify a shell command string (as passed to `portable_pty`) into a
/// [`ShellFamily`]. Pure function — no I/O, no env lookups — so it's easy to
/// test against the set of strings the UI actually produces.
///
/// Parses the leading binary path first (supports Windows paths with spaces
/// like `C:\Program Files\Git\bin\bash.exe`), then matches the basename
/// case-insensitively with any `.exe` suffix stripped.
pub(crate) fn classify_shell(cmd: &str) -> ShellFamily {
    let trimmed = cmd.trim().trim_matches('"');
    // Locate the binary portion: if there's a case-insensitive `.exe`, take
    // everything up to and including it; otherwise split on first whitespace.
    // This keeps `C:\Program Files\...\bash.exe` intact while still trimming
    // trailing args like `wsl.exe -d Ubuntu`.
    let exe = match trimmed.to_ascii_lowercase().find(".exe") {
        Some(idx) => &trimmed[..idx + ".exe".len()],
        None => trimmed.split_whitespace().next().unwrap_or(""),
    };
    let filename = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    let stem = filename
        .strip_suffix(".exe")
        .or_else(|| filename.strip_suffix(".EXE"))
        .or_else(|| filename.strip_suffix(".Exe"))
        .unwrap_or(filename)
        .to_ascii_lowercase();

    match stem.as_str() {
        // POSIX shells (same set we pattern-match elsewhere in pty.rs)
        "sh" | "bash" | "zsh" | "fish" | "dash" | "ksh" | "ash" | "tcsh" | "csh" | "mksh" => {
            ShellFamily::Posix
        }
        // WSL spawns a Linux shell — readline semantics apply.
        "wsl" => ShellFamily::Posix,
        // Native Windows shells: Ctrl-U is not line-kill.
        "cmd" | "powershell" | "pwsh" => ShellFamily::WindowsNative,
        _ => ShellFamily::Unknown,
    }
}

/// How long the agent must be silent after printing a `?`-ending line before
/// we treat it as a question waiting for input. 10s is long enough to avoid
/// false positives from AI agents that pause while thinking between API calls.
const SILENCE_QUESTION_THRESHOLD: std::time::Duration = std::time::Duration::from_secs(10);

/// Maximum non-`?` chunks allowed after a `?` candidate before considering it stale.
/// Claude Code prints 2-3 decoration chunks after a question (mode line, separator).
/// Anything beyond this threshold means the agent continued working — not waiting.
const STALE_QUESTION_CHUNKS: u32 = 10;

/// How long the agent must be silent after printing a tool-error line before
/// we treat it as a turn-ending error (fire `playError()`). Shorter than the
/// question threshold because tool errors are typically followed by immediate
/// turn end (no retry) — 5s is enough to rule out a same-chunk recovery.
const SILENCE_TOOL_ERROR_THRESHOLD: std::time::Duration = std::time::Duration::from_secs(5);

/// How long a retry line ("Retrying … attempt N/M", "Unable to connect to API")
/// holds the agent BUSY after it was last seen. During an API connection-retry
/// loop the agent is mid-turn but its TUI freezes between attempts (the spinner
/// stops repainting while the network call blocks), producing no changed rows —
/// so the movement-based BUSY evidence (#446-596f) drops and the silence/ready
/// path would flip the session idle mid-retry. Each new attempt line re-arms the
/// hold; once retries stop (recovery or final failure) the hold self-expires and
/// idle detection resumes. Long enough to bridge a stalled TCP connect (~10s).
const AGENT_RETRY_HOLD: std::time::Duration = std::time::Duration::from_secs(15);

/// Detect a turn-ending tool-failure line like Claude Code's
/// `⎿  Error: Exit code 1`. Anchored to line-start with only non-letter,
/// non-quote prefix characters (whitespace, box-drawing glyphs) so source
/// code or markdown that merely quotes the literal `"Error: Exit code N"`
/// does NOT match — avoids false-positive red notifications when the user's
/// own pty.rs tests are displayed in a terminal.
fn is_tool_error_line(line: &str) -> bool {
    lazy_static::lazy_static! {
        static ref TOOL_ERROR_RE: regex::Regex =
            regex::Regex::new(r#"^[^A-Za-z"]*Error:\s*Exit code\s+\d+"#).unwrap();
    }
    TOOL_ERROR_RE.is_match(line)
}

/// Detect an in-flight API connection-retry line, e.g. Claude's subagent SDK
/// `Unable to connect to API (ECONNRESET) · Retrying in 0s · attempt 6/10` or
/// the stream-error `retrying 5/5` form. Presence of such a line means the agent
/// is still mid-turn (auto-retrying), not idle — see `AGENT_RETRY_HOLD`. The
/// `attempt N/M` / `N/M` counter is required so plain prose mentioning "retrying"
/// or a code line containing the string does not latch the session busy.
fn is_retry_line(line: &str) -> bool {
    lazy_static::lazy_static! {
        static ref RETRY_RE: regex::Regex = regex::Regex::new(
            r"(?i)(unable to connect to api|retrying\b[^\n]{0,40}attempt\s+\d+\s*/\s*\d+|retrying\s+\d+\s*/\s*\d+)"
        ).unwrap();
    }
    RETRY_RE.is_match(line)
}

/// How often the timer thread wakes up to check for silence.
const SILENCE_CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// If the wall-clock gap between two consecutive silence-timer ticks exceeds
/// this threshold, the system was likely asleep (lid closed). The tick is
/// skipped and timestamps are reset so stale elapsed times don't trigger
/// false idle transitions or completion sounds for every terminal.
const SLEEP_WAKE_GAP: std::time::Duration = std::time::Duration::from_secs(5);

/// Grace period after a PTY resize during which parsed events (Question, RateLimit,
/// ApiError) are suppressed. The shell redraws visible output after SIGWINCH, which
/// would otherwise re-trigger notifications for content already on screen.
const RESIZE_GRACE: std::time::Duration = std::time::Duration::from_millis(1000);

/// How long after user input to ignore `?`-ending echo lines from the PTY.
const ECHO_SUPPRESS_WINDOW: std::time::Duration = std::time::Duration::from_millis(500);

/// Grace period after PTY session start during which notifications (Question,
/// RateLimit, ApiError) are suppressed. When a CLI tool replays conversation
/// history (e.g. `claude --continue`), the burst of historical output contains
/// old errors and questions that would otherwise trigger stale notifications.
/// The grace ends when output pauses for STARTUP_SETTLE_SILENCE seconds,
/// indicating the replay is over and live output is starting.
const STARTUP_SETTLE_SILENCE: std::time::Duration = std::time::Duration::from_secs(5);

/// Safety cap: startup grace never lasts longer than this, even if output
/// never pauses (e.g. continuous build log).
const STARTUP_GRACE_MAX: std::time::Duration = std::time::Duration::from_secs(120);

/// Shell idle threshold: 500ms without real PTY output → transition busy→idle.
/// Matches the frontend's previous 500ms setTimeout in checkIdle.
const SHELL_IDLE_MS: u64 = 500;

/// Agent idle threshold: 2.5s without real PTY output → transition busy→idle.
/// AI agents produce output in bursts with natural thinking pauses (>500ms).
/// Using the shell threshold causes visible blue→green→blue oscillation.
/// Combined with the 2s frontend debounce, this gives ~4.5s total hold.
const AGENT_IDLE_MS: u64 = 2500;

/// A ready prompt must remain visible across multiple silence-timer ticks before
/// it can end an agent turn. Ink redraws are multi-chunk (erase, then repaint),
/// so a single snapshot can briefly show the prompt without its working row.
const AGENT_READY_CONFIRM: std::time::Duration = std::time::Duration::from_millis(1500);

/// Interrupt intent is only a hint: Ctrl-C/Escape may be ignored or handled
/// asynchronously. Keep it long enough to correlate the subsequent explicit
/// interrupted screen, then discard it without changing shell state.
const INTERRUPT_PENDING_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Maximum time active_sub_tasks can block idle transition (30s).
/// If the parser sets active_sub_tasks > 0 but the agent exits or the
/// mode-line disappears without emitting count=0, the terminal would stay
/// busy forever. After this timeout with no real output, we force-clear
/// the stale counter and allow idle transition.
const SUBTASK_STALE_MS: u64 = 30_000;

/// AtomicU8 encoding for shell_states DashMap.
pub(crate) const SHELL_NULL: u8 = 0;
pub(crate) const SHELL_BUSY: u8 = 1;
pub(crate) const SHELL_IDLE: u8 = 2;

/// Converts a shell_states AtomicU8 value into its wire string ("busy"/"idle").
/// Unknown values (including SHELL_NULL) map to "idle" — the frontend treats
/// a just-created session with no output yet as idle, not busy.
pub(crate) fn shell_state_str(state: u8) -> &'static str {
    match state {
        SHELL_BUSY => "busy",
        SHELL_IDLE => "idle",
        _ => "idle",
    }
}

// Re-export from chrome module for use by this module and tests.
use crate::chrome::is_chrome_row;

/// Searches all changed rows (not just the last non-empty one) so a question row
/// is found even when a mode/status line with a higher row index arrives in the same chunk.
/// Applies content filters to reject lines that are clearly not questions (code comments,
/// diff context, markdown headers, code syntax).
pub(crate) fn extract_question_line(changed_rows: &[ChangedRow]) -> Option<String> {
    changed_rows
        .iter()
        .rev()
        .find(|r| !r.text.is_empty() && r.text.ends_with('?') && is_plausible_question(&r.text))
        .map(|r| r.text.clone())
}

/// Returns false for lines that are clearly not questions: code comments, diff context,
/// markdown headers, prompt-echoed user input, and lines containing code-specific syntax.
fn is_plausible_question(line: &str) -> bool {
    let trimmed = line.trim_start();
    // Prompt-prefixed lines are user input echoed in the conversation, not agent questions.
    if is_prompt_line(trimmed) {
        return false;
    }
    // Comment/diff/markdown prefixes
    if trimmed.starts_with("//")
        || trimmed.starts_with('#')
        || trimmed.starts_with('*')
        || trimmed.starts_with('+')
        || trimmed.starts_with('-')
        || trimmed.starts_with('>')
    {
        return false;
    }
    // Code syntax markers — real questions don't contain these
    if line.contains("->") || line.contains("=>") || line.contains("::") {
        return false;
    }
    // Code try-syntax: word_or_> followed by (...)? — e.g. foo()?, bar(x)?, Vec<T>()?
    // But NOT human option parentheticals like (y/n)?, (yes/no)? where `(` is
    // preceded by whitespace or start-of-line, not a word character.
    lazy_static::lazy_static! {
        static ref CODE_TRY_RE: regex::Regex =
            regex::Regex::new(r"[\w>]\([^)]*\)\?").unwrap();
    }
    if CODE_TRY_RE.is_match(line) {
        return false;
    }
    true
}

/// Returns true if a changed_row text looks like a suggest token line.
/// Used to exclude suggest rows from "real output" classification so they
/// don't reset the silence timer or stale pending questions.
fn is_suggest_row(text: &str) -> bool {
    let t = text.trim();
    t.contains("suggest:") && t.contains('|')
}

/// Verify that a question candidate is still visible among the bottom rows of the
/// terminal screen. Returns true only if the exact question text appears as a
/// complete row (trimmed) within the last `max_bottom_rows` non-empty lines.
/// This prevents ghost notifications from stale `?` lines that have scrolled off.
pub(crate) fn verify_question_on_screen(
    screen_rows: &[String],
    question: &str,
    max_bottom_rows: usize,
) -> bool {
    let q = question.trim();
    screen_rows
        .iter()
        .rev()
        .filter(|r| !r.is_empty())
        .take(max_bottom_rows)
        .any(|r| {
            let t = r.trim();
            // Exact match or prefix match (question may be truncated/wrapped on screen)
            t == q || (!q.is_empty() && t.starts_with(q))
        })
}

use crate::chrome::{is_prompt_line, is_separator_line};

/// Returns true when the line is a TUIC protocol token (`suggest:` or `intent:`
/// with pipe-separated items). These are structural markers consumed by the
/// frontend, not agent chat content — they must be skipped by question detection.
fn is_protocol_token_line(text: &str) -> bool {
    let t = text.trim_start();
    (t.starts_with("suggest:") || t.starts_with("intent:")) && t.contains('|')
}

/// Returns the set of row indices occupied by a protocol token (including
/// terminal-wrapped continuation rows). A continuation row is a row that
/// immediately follows a `suggest:` or `intent:` row and contains `|` but
/// does NOT start a new token prefix. Used to exclude the entire suggest/intent
/// block from "last chat line" detection — without this, the continuation row
/// gets mistaken for real chat content and steals the question slot.
fn collect_protocol_token_indices(screen_rows: &[String]) -> std::collections::HashSet<usize> {
    let mut indices = std::collections::HashSet::new();
    for (i, row) in screen_rows.iter().enumerate() {
        if is_protocol_token_line(row) {
            indices.insert(i);
            // Walk forward to find continuation rows (wrapped by terminal width)
            for (j, row) in screen_rows.iter().enumerate().skip(i + 1) {
                let trimmed = row.trim();
                if trimmed.is_empty() {
                    break;
                }
                // Stop at rows that start a new protocol token or chat content
                if is_protocol_token_line(row)
                    || trimmed.starts_with('>')
                    || trimmed.starts_with('›')
                    || trimmed.starts_with('❯')
                    || trimmed.starts_with('●')
                    || trimmed.starts_with('⏺')
                {
                    break;
                }
                // A continuation row must contain the `|` separator — without
                // it, the row is regular text (like an answer) that happens
                // to follow the suggest line.
                if !trimmed.contains('|') {
                    break;
                }
                indices.insert(j);
            }
        }
    }
    indices
}

/// Find the last chat line above the prompt box and, if it is a plausible
/// `?`-ending question, return it. Suggest/intent protocol blocks (including
/// wrapped continuations) are transparently skipped because they sit between
/// the agent's question and the prompt but are not real chat content — the
/// agent emits the question first and the suggest arrives after.
///
/// Only the single last chat line is inspected. We deliberately do NOT walk
/// deeper looking for an older `?`: a multi-line scan would scavenge past
/// the current agent turn and pick up the user's own previous input (e.g.
/// `❯ tutto ok?`) or stale content from earlier in the conversation, firing
/// phantom notifications 10s after the reply.
pub(crate) fn find_last_chat_question(screen_rows: &[String]) -> Option<String> {
    let prompt_idx = screen_rows
        .iter()
        .enumerate()
        .rev()
        .find(|(_, row)| is_prompt_line(row))?
        .0;

    let protocol_indices = collect_protocol_token_indices(screen_rows);

    for i in (0..prompt_idx).rev() {
        if protocol_indices.contains(&i) {
            continue;
        }
        let trimmed = screen_rows[i].trim();
        if trimmed.is_empty() || is_separator_line(trimmed) || is_chrome_row(trimmed) {
            continue;
        }
        // First non-skip row above the prompt — this is the last chat line.
        // Check it for a question, otherwise give up: we do not scavenge
        // deeper into the buffer.
        if trimmed.ends_with('?') && is_plausible_question(trimmed) {
            return Some(trimmed.to_string());
        }
        return None;
    }
    None
}

/// Shared state between the PTY reader thread and the silence-detection timer thread.
#[derive(Clone)]
pub(crate) struct SilenceState {
    /// When the last chunk of output was received from the PTY.
    pub(crate) last_output_at: std::time::Instant,
    /// The last line ending with `?` that hasn't been resolved yet.
    pub(crate) pending_question_line: Option<String>,
    /// Whether a Question event has already been emitted for the current pending line
    /// (either by the instant regex detector or by the silence timer).
    pub(crate) question_already_emitted: bool,
    /// When the last resize was requested. Used to suppress re-parsing of redrawn output.
    last_resize_at: Option<std::time::Instant>,
    /// Deadline until which `on_chunk` ignores `?`-ending lines (suppresses PTY echo).
    /// Set by `suppress_user_input()` so the echo of user-typed text doesn't
    /// re-enable silence-based question detection.
    pub(crate) suppress_echo_until: Option<std::time::Instant>,
    /// When the last chunk of ANY kind (real or chrome-only) was processed.
    /// Used by the backup idle timer to distinguish "no output at all" (reader
    /// blocked on read()) from "only chrome-only ticks arriving". The backup
    /// timer should only fire when truly no chunks arrive.
    pub(crate) last_chunk_at: std::time::Instant,
    /// When the last StatusLine (spinner) event was seen. If recent,
    /// silence-based question detection is suppressed — spinner means the agent is working.
    pub(crate) last_status_line_at: Option<std::time::Instant>,
    /// How many non-`?` chunks arrived after the current pending question candidate.
    /// Used to detect stale candidates: if the agent continued producing significant
    /// output after the `?` line, it was not a real question.
    output_chunks_after_question: u32,
    /// The text of the last question emitted (by silence timer or check_silence).
    /// Used to prevent re-emission of the same question when scrolling causes the
    /// `?` line to reappear in changed_rows at a different row position.
    /// Cleared on user input (new conversation cycle).
    last_emitted_text: Option<String>,
    /// When this session was created. Used with `startup_settled` to suppress
    /// notifications during the initial output burst (e.g. `--continue` replay).
    created_at: std::time::Instant,
    /// True once the session has settled after the initial output burst.
    /// Settled = output paused for STARTUP_SETTLE_SILENCE seconds, or
    /// STARTUP_GRACE_MAX has elapsed since creation.
    pub(crate) startup_settled: bool,
    /// The last `Error: Exit code N` line seen, awaiting silence verification.
    /// Cleared if real output (non-chrome, non-error) arrives — that means the
    /// agent recovered and the error is not turn-ending.
    pending_tool_error: Option<String>,
    /// Error lines already surfaced via `ToolError` in the current "input epoch"
    /// (since the last user line submit / session start). Persists across
    /// `clear_tool_error_on_recovery` so that scroll-induced reappearances of
    /// the same error in `changed_rows` do not re-fire the notification.
    /// Cleared on explicit user input so a recurring failure in a later turn
    /// can notify again.
    surfaced_tool_errors: std::collections::HashSet<String>,
    /// Parsed `suggest:` items awaiting silence-based flush. The parser detects
    /// the token synchronously with output, but we hold the event here until
    /// `check_suggest` confirms the turn has ended (`SILENCE_SUGGEST_THRESHOLD`
    /// elapsed since the last real output chunk). Eliminates the frontend
    /// `pendingSuggest` race: the event never reaches the UI before idle.
    pending_suggest_items: Option<Vec<String>>,
    /// Input-turn epoch associated with `pending_suggest_items`.
    pending_suggest_turn_epoch: u64,
    /// Timestamp when `pending_suggest_items` was parked. Currently for
    /// diagnostics only — the flush decision is driven by `last_output_at`,
    /// not the park time.
    pending_suggest_at: Option<std::time::Instant>,
    /// The agent emitted the protocol's explicit end-of-task marker for the
    /// current input epoch. Unlike the pending item payload, this survives the
    /// one-shot Suggest event drain so status/list can distinguish completed
    /// work from a merely quiet ready prompt.
    completion_declared: bool,
    /// Input-turn epoch that declared completion.
    completion_turn_epoch: u64,
    /// True after an explicit OSC 133 / OSC 7770 busy marker and until an
    /// explicit idle marker or a confirmed ready screen. Silence alone must not
    /// override this state: hooks are stronger evidence than output timing.
    explicit_busy: bool,
    /// BUSY came from an observed agent hook. A stable ready screen may recover
    /// from a missed idle hook, but the old prompt cannot do so before submitted
    /// turn activity is observed.
    hook_busy: bool,
    /// An explicit idle marker outranks a stale Working row left in the same
    /// render chunk. Cleared by the next explicit busy or later real activity.
    explicit_idle: bool,
    /// True only after OSC 7770 `state=` was observed (OSC 133 shell markers do
    /// not prove that an agent's configured hooks are actually running).
    hook_state_seen: bool,
    /// Whether the current idle state is safe for downstream uses such as
    /// standby and peer-message injection. Enforced for agents with a verified
    /// screen adapter; legacy heuristic-only agents retain their prior behavior.
    idle_confirmed: bool,
    /// First observation of a stable agent ready prompt.
    ready_since: Option<std::time::Instant>,
    /// Recent user request to interrupt (Ctrl-C or bare Escape). This never
    /// changes shell state by itself; it only strengthens a matching interrupted
    /// screen emitted by the agent.
    interrupt_requested_at: Option<std::time::Instant>,
    /// A user/injected prompt started a turn on an adapter-backed agent.
    turn_started_by_input: bool,
    /// Strong activity (real output or Working marker) was observed after that
    /// submission. Until then, the old ready prompt is not proof of completion.
    turn_activity_seen: bool,
    /// Monotonic owner for an IDLE→BUSY transition reserved by terminal
    /// injection. The saved bool is the confirmed-idle value to restore only
    /// when no PTY byte was written and this claim still owns the state.
    active_injection_claim: Option<(u64, bool)>,
    next_injection_claim: u64,
    /// A payload may have been partially written or flushed without a complete
    /// Enter. Such sessions remain conservatively BUSY and are surfaced in
    /// status; automatic retry would risk duplicate or corrupted input.
    pub(crate) injection_delivery_uncertain: bool,
    /// Deadline until which an in-flight API connection-retry holds the agent
    /// BUSY. Armed by `mark_api_retry` when `is_retry_line` matches a changed
    /// row; blocks both the ready-screen and silence idle paths until it expires
    /// or is cleared by recovery/user input. See `AGENT_RETRY_HOLD`.
    api_retry_hold_until: Option<std::time::Instant>,
}

impl SilenceState {
    pub(crate) fn new() -> Self {
        Self {
            last_output_at: std::time::Instant::now(),
            pending_question_line: None,
            question_already_emitted: false,
            last_chunk_at: std::time::Instant::now(),
            last_resize_at: None,
            suppress_echo_until: None,
            last_status_line_at: None,
            output_chunks_after_question: 0,
            last_emitted_text: None,
            created_at: std::time::Instant::now(),
            startup_settled: false,
            pending_tool_error: None,
            surfaced_tool_errors: std::collections::HashSet::new(),
            pending_suggest_items: None,
            pending_suggest_turn_epoch: 0,
            pending_suggest_at: None,
            completion_declared: false,
            completion_turn_epoch: 0,
            explicit_busy: false,
            hook_busy: false,
            explicit_idle: false,
            hook_state_seen: false,
            idle_confirmed: false,
            ready_since: None,
            interrupt_requested_at: None,
            turn_started_by_input: false,
            turn_activity_seen: false,
            active_injection_claim: None,
            next_injection_claim: 0,
            injection_delivery_uncertain: false,
            api_retry_hold_until: None,
        }
    }

    fn begin_injection_claim(&mut self, prior_idle_confirmed: bool) -> u64 {
        self.next_injection_claim = self.next_injection_claim.wrapping_add(1).max(1);
        let token = self.next_injection_claim;
        self.active_injection_claim = Some((token, prior_idle_confirmed));
        self.injection_delivery_uncertain = false;
        token
    }

    fn commit_injection_claim(&mut self, token: u64) -> bool {
        if self
            .active_injection_claim
            .is_some_and(|(owner, _)| owner == token)
        {
            self.active_injection_claim = None;
            self.injection_delivery_uncertain = false;
            true
        } else {
            false
        }
    }

    fn rollback_injection_claim(&mut self, token: u64) -> Option<bool> {
        let (_, prior_idle_confirmed) = self
            .active_injection_claim
            .filter(|(owner, _)| *owner == token)?;
        if self.turn_activity_seen || self.hook_busy {
            self.active_injection_claim = None;
            return None;
        }
        self.active_injection_claim = None;
        self.injection_delivery_uncertain = false;
        self.idle_confirmed = prior_idle_confirmed;
        Some(prior_idle_confirmed)
    }

    fn mark_injection_uncertain(&mut self, token: u64) {
        if self
            .active_injection_claim
            .is_some_and(|(owner, _)| owner == token)
        {
            self.active_injection_claim = None;
            self.injection_delivery_uncertain = true;
        }
    }

    fn invalidate_injection_claim(&mut self) {
        self.active_injection_claim = None;
        self.injection_delivery_uncertain = false;
    }

    fn note_explicit_state(&mut self, state: u8, hook_state: bool) {
        self.invalidate_injection_claim();
        self.hook_state_seen |= hook_state;
        self.ready_since = None;
        match state {
            SHELL_BUSY => {
                self.explicit_busy = true;
                self.hook_busy = hook_state;
                self.explicit_idle = false;
                self.idle_confirmed = false;
                self.last_status_line_at = Some(std::time::Instant::now());
            }
            SHELL_IDLE => {
                self.explicit_busy = false;
                self.hook_busy = false;
                self.explicit_idle = true;
                self.idle_confirmed = true;
                self.last_status_line_at = None;
                self.interrupt_requested_at = None;
                self.turn_started_by_input = false;
                self.turn_activity_seen = false;
            }
            _ => {}
        }
    }

    fn note_busy_evidence(&mut self) {
        self.explicit_idle = false;
        self.idle_confirmed = false;
        self.ready_since = None;
    }

    fn note_working_screen(&mut self) {
        self.invalidate_injection_claim();
        self.note_busy_evidence();
        self.turn_activity_seen = true;
        // Keep silence-based question/tool-error detection aligned with shell
        // activity. Previously the working marker refreshed last_output_ms but
        // not SilenceState, allowing contradictory question events.
        self.last_status_line_at = Some(std::time::Instant::now());
    }

    fn note_real_activity(&mut self) {
        self.invalidate_injection_claim();
        self.note_busy_evidence();
        self.turn_activity_seen = true;
    }

    fn note_ready_screen(&mut self) -> bool {
        if self.injection_delivery_uncertain
            || (self.hook_busy && !self.turn_activity_seen)
            || (self.turn_started_by_input && !self.turn_activity_seen)
            || self.is_api_retry_active()
        {
            self.ready_since = None;
            return false;
        }
        let now = std::time::Instant::now();
        let since = self.ready_since.get_or_insert(now);
        if since.elapsed() < AGENT_READY_CONFIRM {
            return false;
        }
        self.explicit_busy = false;
        self.hook_busy = false;
        self.explicit_idle = false;
        self.idle_confirmed = true;
        self.last_status_line_at = None;
        self.interrupt_requested_at = None;
        self.turn_started_by_input = false;
        self.turn_activity_seen = false;
        true
    }

    fn note_interrupted_screen(&mut self) -> bool {
        let pending = self
            .interrupt_requested_at
            .is_some_and(|at| at.elapsed() < INTERRUPT_PENDING_TTL);
        if pending {
            self.explicit_busy = false;
            self.hook_busy = false;
            self.explicit_idle = false;
            self.idle_confirmed = true;
            self.last_status_line_at = None;
            self.ready_since = None;
            self.interrupt_requested_at = None;
            self.turn_started_by_input = false;
            self.turn_activity_seen = false;
            return true;
        }
        self.note_ready_screen()
    }

    fn note_unknown_screen(&mut self) {
        self.ready_since = None;
        if self
            .interrupt_requested_at
            .is_some_and(|at| at.elapsed() >= INTERRUPT_PENDING_TTL)
        {
            self.interrupt_requested_at = None;
        }
    }

    pub(crate) fn note_interrupt_requested(&mut self) {
        self.interrupt_requested_at = Some(std::time::Instant::now());
        self.ready_since = None;
    }

    pub(crate) fn note_user_submission(&mut self, has_ready_adapter: bool) {
        self.interrupt_requested_at = None;
        self.completion_declared = false;
        self.note_busy_evidence();
        if has_ready_adapter {
            self.explicit_busy = true;
            self.last_status_line_at = Some(std::time::Instant::now());
            self.turn_started_by_input = true;
            self.turn_activity_seen = false;
        }
    }

    #[cfg(test)]
    pub(crate) fn confirm_idle(&mut self) {
        self.explicit_busy = false;
        self.hook_busy = false;
        self.explicit_idle = false;
        self.idle_confirmed = true;
    }

    /// Called by resize_pty when the terminal is resized.
    /// Marks the start of a grace period during which parsed events are suppressed.
    pub(crate) fn on_resize(&mut self) {
        self.last_resize_at = Some(std::time::Instant::now());
    }

    /// Returns true if we are within the resize grace period.
    /// Parsed events (Question, RateLimit, ApiError) should be suppressed during this window
    /// because the shell redraws visible output after SIGWINCH, causing false re-detections.
    pub(crate) fn is_resize_grace(&self) -> bool {
        self.last_resize_at
            .map(|t| t.elapsed() < RESIZE_GRACE)
            .unwrap_or(false)
    }

    /// Returns true if we are still in the startup grace period.
    /// During this window, notifications are suppressed to avoid reacting to
    /// historical output replayed by `--continue` or similar session restore.
    pub(crate) fn is_startup_grace(&self) -> bool {
        !self.startup_settled
    }

    /// Check if the startup grace should end and update the flag.
    /// Called by the silence timer thread every second.
    pub(crate) fn check_startup_settle(&mut self) {
        if self.startup_settled {
            return;
        }
        // Safety cap: always settle after STARTUP_GRACE_MAX
        if self.created_at.elapsed() >= STARTUP_GRACE_MAX {
            self.startup_settled = true;
            self.pending_suggest_items = None;
            self.pending_suggest_at = None;
            return;
        }
        // Settle after STARTUP_SETTLE_SILENCE without output
        if self.last_output_at.elapsed() >= STARTUP_SETTLE_SILENCE {
            self.startup_settled = true;
            self.pending_suggest_items = None;
            self.pending_suggest_at = None;
        }
    }

    /// Called by the reader thread after each chunk.
    /// `regex_found_question`: true if `parse()` already emitted a Question event.
    /// `last_question_line`: the last `?`-ending line in the chunk, if any.
    /// `has_status_line`: true if the chunk contained a StatusLine parsed event.
    /// `status_line_only`: true if the chunk contained ONLY status-line/mode-line updates.
    ///   Mode-line timer ticks (elapsed time updating every second) are not significant
    ///   output — they must not reset the silence timer or the spinner timestamp,
    ///   or questions asked by Ink agents will never be detected.
    pub(crate) fn on_chunk(
        &mut self,
        regex_found_question: bool,
        last_question_line: Option<String>,
        has_status_line: bool,
        status_line_only: bool,
        suggest_only: bool,
    ) {
        // Always track that a chunk arrived — used by the backup idle timer
        // to distinguish "reader blocked on read()" from "chrome ticks arriving".
        self.last_chunk_at = std::time::Instant::now();

        // Suggest-only chunks are not significant output — they are protocol
        // tokens consumed by the frontend, not real agent text.
        let insignificant = status_line_only || suggest_only;

        if !insignificant {
            self.last_output_at = std::time::Instant::now();
        }

        // Only mark spinner active when the status line accompanies real output.
        // Mode-line timer ticks and suggest-only chunks are not agent activity
        // and must not suppress question detection.
        if has_status_line && !insignificant {
            self.last_status_line_at = Some(std::time::Instant::now());
        }

        // Within the echo suppress window, ignore `?`-ending lines — they are
        // the PTY echoing back user-typed text, not agent questions.
        let in_echo_window = self
            .suppress_echo_until
            .map(|deadline| std::time::Instant::now() < deadline)
            .unwrap_or(false);

        if regex_found_question {
            // The instant detector already fired — suppress the silence timer.
            self.pending_question_line = None;
            self.question_already_emitted = true;
            self.output_chunks_after_question = 0;
        } else if let Some(line) = last_question_line {
            if in_echo_window {
                // Ignore — this is the PTY echo of user input.
            } else if self.question_already_emitted
                && (self.pending_question_line.as_deref() == Some(&line)
                    || self.last_emitted_text.as_deref() == Some(&line))
            {
                // Same `?` text as already emitted (either still pending, or
                // previously emitted and reappearing because new output scrolled
                // it to a different row). Don't reset — otherwise the silence
                // timer will re-fire for every scroll of the same question.
            } else {
                // New candidate for silence-based detection.
                self.pending_question_line = Some(line);
                self.question_already_emitted = false;
                self.output_chunks_after_question = 0;
            }
        } else if self.pending_question_line.is_some() && !insignificant {
            // Non-`?` chunk with real output after a pending candidate — track staleness.
            // Insignificant chunks (mode-line ticks, suggest tokens) are NOT real output
            // and must not count toward staleness, or they will clear the pending question
            // before the silence timer has a chance to detect it.
            self.output_chunks_after_question = self.output_chunks_after_question.saturating_add(1);
            // Once stale, clear pending so the repaint guard won't block the
            // same question text from being detected again in a future session.
            if self.output_chunks_after_question > STALE_QUESTION_CHUNKS {
                self.pending_question_line = None;
            }
        }
    }

    /// Called by write_pty when the user submits a line of input.
    /// Clears any pending question candidate since it was typed by the user, not the agent.
    /// Also opens a time window to ignore the PTY echo of the typed text.
    pub(crate) fn suppress_user_input(&mut self) {
        self.pending_question_line = None;
        self.question_already_emitted = true;
        self.last_emitted_text = None;
        self.suppress_echo_until = Some(std::time::Instant::now() + ECHO_SUPPRESS_WINDOW);
    }

    /// Returns true if a spinner/status-line was seen recently.
    /// Uses the same threshold as silence detection (10s) so that agents with
    /// pauses between status-line updates (API calls, file reads) don't trigger
    /// false question notifications during those gaps.
    fn is_spinner_active(&self) -> bool {
        self.explicit_busy
            || self
                .last_status_line_at
                .map(|t| t.elapsed() < SILENCE_QUESTION_THRESHOLD)
                .unwrap_or(false)
    }

    /// Returns true if any chunk (real or chrome-only) was received recently.
    /// The backup idle timer uses this to avoid false idle transitions when the
    /// reader thread IS processing chunks (even chrome-only status-line ticks).
    /// Status-line ticking proves the agent is alive — the backup timer should
    /// only fire when truly no chunks arrive (reader blocked on read()).
    /// The 2s threshold matches the frontend debounce hold (BUSY_HOLD_MS).
    #[allow(dead_code)] // called from tests; kept for backup-idle-timer reintegration
    pub(crate) fn has_recent_chunks(&self) -> bool {
        self.last_chunk_at.elapsed() < std::time::Duration::from_secs(2)
    }

    /// Called by the timer thread. Returns the question text if the silence
    /// threshold has been reached and we haven't emitted yet.
    pub(crate) fn check_silence(&mut self) -> Option<String> {
        if self.question_already_emitted {
            return None;
        }
        // Spinner active means the agent is working — not waiting for input.
        if self.is_spinner_active() {
            return None;
        }
        // Too much output after the `?` line — the agent continued working,
        // so the `?` was not a real question (e.g. code comment, markdown).
        if self.output_chunks_after_question > STALE_QUESTION_CHUNKS {
            return None;
        }
        if let Some(ref line) = self.pending_question_line
            && self.last_output_at.elapsed() >= SILENCE_QUESTION_THRESHOLD
        {
            self.question_already_emitted = true;
            self.last_emitted_text = Some(line.clone());
            return Some(line.clone());
        }
        None
    }

    /// Clear a stale question candidate that failed screen verification.
    /// Prevents the timer from re-checking the same stale candidate every second.
    pub(crate) fn clear_stale_question(&mut self) {
        self.pending_question_line = None;
        self.question_already_emitted = true;
    }

    /// Register an `Error: Exit code N` line seen in visible output. The silence
    /// timer will emit a ToolError event if the session goes idle without any
    /// real-output chunk clearing the candidate (= agent did not recover).
    ///
    /// Idempotent across scroll-induced re-appearances: if this exact line has
    /// already surfaced in the current input epoch, we drop it. Without this,
    /// Ink-based TUIs (Claude Code, Codex) cause `changed_rows` to include the
    /// old error line every time the viewport scrolls, re-arming the candidate
    /// and re-firing the red notification long after the user has resumed.
    pub(crate) fn mark_tool_error_candidate(&mut self, line: String) {
        if self.surfaced_tool_errors.contains(&line) {
            return;
        }
        if self.pending_tool_error.as_deref() == Some(&line) {
            return;
        }
        self.pending_tool_error = Some(line);
    }

    /// Arm (or re-arm) the API connection-retry BUSY hold. Called when
    /// `is_retry_line` matches a changed row: the agent is auto-retrying a failed
    /// API call and is still mid-turn even though its TUI has frozen between
    /// attempts. See `AGENT_RETRY_HOLD` for why this is needed.
    pub(crate) fn mark_api_retry(&mut self) {
        self.api_retry_hold_until = Some(std::time::Instant::now() + AGENT_RETRY_HOLD);
    }

    /// True while an in-flight API retry holds the agent BUSY. Consulted by the
    /// ready-screen and silence idle paths to suppress a premature idle flip.
    pub(crate) fn is_api_retry_active(&self) -> bool {
        self.api_retry_hold_until
            .is_some_and(|deadline| std::time::Instant::now() < deadline)
    }

    /// Called on every real-output chunk that is NOT an error line. Clears the
    /// pending tool-error candidate: if the agent produced real output after an
    /// error, it recovered (e.g. retry) and the error is not turn-ending.
    ///
    /// Does NOT reset `surfaced_tool_errors` — recovery is a transient backend
    /// signal; the user-facing "I've already told you about this error" state
    /// must survive it and only reset on explicit user input.
    pub(crate) fn clear_tool_error_on_recovery(&mut self) {
        self.pending_tool_error = None;
        // Real non-error, non-retry output means the agent recovered from the
        // connection-retry loop — release the BUSY hold so idle detection resumes.
        self.api_retry_hold_until = None;
    }

    /// Clear the "already surfaced" memory so the next occurrence of any error
    /// line — including one we've already fired — can notify again. Called
    /// from `write_pty` when the user submits a line (or Ctrl+C), mirroring
    /// the api-error dedup reset in `OutputParser::parse_clean_lines`.
    pub(crate) fn reset_tool_error_memory(&mut self) {
        self.pending_tool_error = None;
        self.surfaced_tool_errors.clear();
        self.api_retry_hold_until = None;
    }

    /// Called by the timer thread. Returns the error text if the silence
    /// threshold has been reached and we haven't emitted yet. Semantics mirror
    /// `check_silence` but use the shorter tool-error threshold.
    pub(crate) fn check_tool_error(&mut self) -> Option<String> {
        if self.is_spinner_active() {
            return None;
        }
        let should_fire = self.pending_tool_error.is_some()
            && self.last_output_at.elapsed() >= SILENCE_TOOL_ERROR_THRESHOLD;
        if !should_fire {
            return None;
        }
        let line = self.pending_tool_error.take()?;
        self.surfaced_tool_errors.insert(line.clone());
        Some(line)
    }

    /// Park `suggest:` items parsed from output. The silence timer will flush
    /// them to the frontend once the shell state transitions to idle — this
    /// is the single source of truth for "turn ended". A newer set overwrites
    /// an older pending set: if the agent updates its suggestions mid-turn,
    /// we deliver the latest.
    pub(crate) fn mark_suggest_candidate(&mut self, items: Vec<String>, turn_epoch: u64) {
        if items.is_empty() {
            return;
        }
        self.completion_declared = true;
        self.completion_turn_epoch = turn_epoch;
        self.pending_suggest_items = Some(items);
        self.pending_suggest_turn_epoch = turn_epoch;
        self.pending_suggest_at = Some(std::time::Instant::now());
    }

    fn drain_pending_suggest_with_epoch(&mut self) -> Option<(u64, Vec<String>)> {
        self.pending_suggest_at = None;
        self.pending_suggest_items
            .take()
            .map(|items| (self.pending_suggest_turn_epoch, items))
    }

    /// Drain parked suggest items. No gates — trust the caller to invoke only
    /// when the shell state is IDLE (the silence timer does exactly that).
    /// Returns the items once and clears the park slot; a second call returns
    /// `None` until new items are parked.
    #[cfg(test)]
    pub(crate) fn drain_pending_suggest(&mut self) -> Option<Vec<String>> {
        self.drain_pending_suggest_with_epoch()
            .map(|(_, items)| items)
    }

    /// Drop any parked suggest on user input. Parallels `reset_tool_error_memory`:
    /// the user is engaging again, so stale suggestions from the previous turn
    /// must not fire after a new input cycle starts.
    pub(crate) fn reset_suggest_memory(&mut self) {
        self.pending_suggest_items = None;
        self.pending_suggest_turn_epoch = 0;
        self.pending_suggest_at = None;
        self.completion_declared = false;
        self.completion_turn_epoch = 0;
    }

    #[cfg(test)]
    pub(crate) fn completion_declared(&self) -> bool {
        self.completion_declared
    }

    pub(crate) fn completion_declared_for_epoch(&self, turn_epoch: u64) -> bool {
        self.completion_declared && self.completion_turn_epoch == turn_epoch
    }

    /// Returns true if the session has been silent long enough and the spinner
    /// is not active. Used by the timer thread before reading the screen.
    pub(crate) fn is_silent(&self) -> bool {
        !self.question_already_emitted
            && !self.is_spinner_active()
            && self.last_output_at.elapsed() >= SILENCE_QUESTION_THRESHOLD
    }

    /// Mark that a question has been emitted (prevents re-emission).
    /// Stores the emitted text so that scroll-induced reappearances of the same
    /// `?` line in changed_rows are recognized as duplicates, not new questions.
    pub(crate) fn mark_emitted(&mut self, text: &str) {
        self.question_already_emitted = true;
        self.last_emitted_text = Some(text.to_string());
    }
}

/// Attempt a shell state transition using compare_exchange.
/// Returns true if the transition was performed (and a ShellState event should be emitted).
/// Attempt an atomic shell-state transition.
///
/// When `notify_parent` is true and the transition is BUSY→IDLE, pushes a
/// state_change message to the parent's inbox (used during normal idle detection).
/// Pass `notify_parent=false` from process-exit paths — the sole "exited"
/// notification from `mark_session_exited` is sufficient; suppressing the
/// intermediate "idle" avoids the orchestrator double-firing on exit.
///
/// RE-ENTRANCY INVARIANT (CONC-C, story 099-6526): this fn does its own
/// `shell_states.get(session_id)` below. Callers MUST NOT hold a `shell_states`
/// Ref for the same key across this call — a held Ref plus this second get on the
/// same shard can deadlock under parking_lot writer-fairness when a concurrent
/// session create/destroy is queued to write the shard between the two reads.
/// Load what you need, drop the Ref, then call. Internally the Ref is dropped
/// BEFORE any post-transition work for the same reason: both
/// `flush_pending_injections` and `push_state_change_to_parent` (via
/// `deliver_message_to_pty`) re-read `shell_states` through `should_inject_now`.
fn try_shell_transition(
    state: &crate::state::AppState,
    session_id: &str,
    expected: u8,
    new: u8,
    notify_parent: bool,
) -> bool {
    let observed_turn_epoch = state
        .session_states
        .get(session_id)
        .map(|session| session.turn_epoch);
    try_shell_transition_for_epoch(
        state,
        session_id,
        expected,
        new,
        notify_parent,
        observed_turn_epoch,
    )
}

fn try_shell_transition_for_epoch(
    state: &crate::state::AppState,
    session_id: &str,
    expected: u8,
    new: u8,
    notify_parent: bool,
    observed_turn_epoch: Option<u64>,
) -> bool {
    try_shell_transition_with_hooks(
        ShellTransitionRequest {
            state,
            session_id,
            expected,
            new,
            notify_parent,
            observed_turn_epoch,
        },
        ShellTransitionHooks {
            after_epoch_snapshot: || {},
            after_cas: || {},
            before_parent_dispatch: || {},
        },
    )
}

#[cfg(test)]
fn try_shell_transition_with_hook<F: FnOnce()>(
    state: &crate::state::AppState,
    session_id: &str,
    expected: u8,
    new: u8,
    notify_parent: bool,
    after_cas: F,
) -> bool {
    let observed_turn_epoch = state
        .session_states
        .get(session_id)
        .map(|session| session.turn_epoch);
    try_shell_transition_with_hooks(
        ShellTransitionRequest {
            state,
            session_id,
            expected,
            new,
            notify_parent,
            observed_turn_epoch,
        },
        ShellTransitionHooks {
            after_epoch_snapshot: || {},
            after_cas,
            before_parent_dispatch: || {},
        },
    )
}

#[derive(Clone, Copy)]
struct ShellTransitionRequest<'a> {
    state: &'a crate::state::AppState,
    session_id: &'a str,
    expected: u8,
    new: u8,
    notify_parent: bool,
    observed_turn_epoch: Option<u64>,
}

struct ShellTransitionHooks<B: FnOnce(), A: FnOnce(), D: FnOnce()> {
    after_epoch_snapshot: B,
    after_cas: A,
    before_parent_dispatch: D,
}

fn try_shell_transition_with_hooks<B: FnOnce(), A: FnOnce(), D: FnOnce()>(
    transition: ShellTransitionRequest<'_>,
    hooks: ShellTransitionHooks<B, A, D>,
) -> bool {
    // One lifecycle lock covers CAS through the authoritative parent inbox
    // enqueue. Submitted-turn reservations take the same lock, so a new epoch
    // cannot begin between an IDLE CAS and the preceding turn's notification.
    (hooks.after_epoch_snapshot)();
    let silence = transition
        .state
        .silence_states
        .get(transition.session_id)
        .map(|entry| Arc::clone(entry.value()));
    let (transitioned, parent_dispatch) = {
        let mut silence_guard = silence.as_ref().map(|silence| silence.lock());
        let silence_state = silence_guard.as_deref_mut();
        try_shell_transition_locked(transition, silence_state, hooks.after_cas)
    };
    if let Some(dispatch) = parent_dispatch {
        (hooks.before_parent_dispatch)();
        dispatch_parent_lifecycle(transition.state, dispatch);
    }
    transitioned
}

/// Perform a shell transition while the caller owns the lifecycle lock.
/// `note_submitted_input` uses this form so epoch mutation and IDLE→BUSY are
/// one critical section instead of recursively acquiring `SilenceState`.
fn try_shell_transition_locked<F: FnOnce()>(
    transition: ShellTransitionRequest<'_>,
    mut silence_state: Option<&mut SilenceState>,
    after_cas: F,
) -> (bool, Option<ParentLifecycleDispatch>) {
    let ShellTransitionRequest {
        state,
        session_id,
        expected,
        new,
        notify_parent,
        observed_turn_epoch,
    } = transition;
    if expected == SHELL_BUSY
        && new == SHELL_IDLE
        && observed_turn_epoch.is_some_and(|observed| {
            state
                .session_states
                .get(session_id)
                .is_some_and(|session| session.turn_epoch != observed)
        })
    {
        return (false, None);
    }
    let ok = match state.shell_states.get(session_id) {
        Some(atom) => atom
            .compare_exchange(
                expected,
                new,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_ok(),
        None => return (false, None),
    };
    let mut parent_dispatch = None;
    if ok {
        after_cas();
    }
    // Ref dropped here — post-transition work below re-enters shell_states.
    if ok {
        if new == SHELL_BUSY
            && let Some(silence) = silence_state.as_mut()
        {
            silence.note_busy_evidence();
            invalidate_background_probe_boundary_locked(state, session_id);
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        // Insert with the correct timestamp immediately so concurrent
        // readers never observe a transient 0 between or_insert and store.
        state
            .shell_state_since_ms
            .entry(session_id.to_string())
            .and_modify(|a| a.store(now_ms, std::sync::atomic::Ordering::Relaxed))
            .or_insert_with(|| std::sync::atomic::AtomicU64::new(now_ms));
        // Notify orchestrator when an agent goes idle (BUSY→IDLE only).
        // Plain shell sessions are excluded — only registered agent sessions qualify.
        if notify_parent && expected == SHELL_BUSY && new == SHELL_IDLE {
            let session_lifecycle = state
                .session_states
                .get(session_id)
                .map(|s| (s.agent_type.is_some(), s.turn_epoch));
            let completion_declared = session_lifecycle.is_some_and(|(_, turn_epoch)| {
                silence_state
                    .as_ref()
                    .is_some_and(|silence| silence.completion_declared_for_epoch(turn_epoch))
            });
            let is_agent = session_lifecycle.is_some_and(|(is_agent, _)| is_agent);
            let has_background_work = state
                .session_states
                .get(session_id)
                .is_some_and(|session| session.background_work);
            let background_probe_pending = state
                .session_states
                .get(session_id)
                .is_some_and(|session| session.has_pending_background_probe());
            if is_agent && !completion_declared && !has_background_work && !background_probe_pending
            {
                parent_dispatch = enqueue_state_change_to_parent(
                    state,
                    session_id,
                    serde_json::json!({
                        "type": "state_change",
                        "state": "idle",
                        "session_id": session_id,
                    }),
                );
            }
        }
    }
    (ok, parent_dispatch)
}

/// Decision from `should_transition_idle`.
///
/// `force_cleared_subtasks` is true only on the stale-subtask recovery path —
/// callers must emit `ActiveSubtasks { count: 0 }` so the frontend store and
/// notification gate reset (story 1366-2b3e/H1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IdleDecision {
    should_transition: bool,
    force_cleared_subtasks: bool,
    turn_epoch: Option<u64>,
}

impl IdleDecision {
    const NO: Self = Self {
        should_transition: false,
        force_cleared_subtasks: false,
        turn_epoch: None,
    };

    const fn yes(turn_epoch: Option<u64>) -> Self {
        Self {
            should_transition: true,
            force_cleared_subtasks: false,
            turn_epoch,
        }
    }
}

/// Current wall-clock time as milliseconds since the Unix epoch.
fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Check whether the session should transition to idle (busy → idle).
/// Conditions: last real output > threshold ago AND no active sub-tasks.
/// Agent sessions use a longer threshold (AGENT_IDLE_MS) because AI agents
/// produce output in bursts with natural thinking pauses between them.
fn should_transition_idle(state: &crate::state::AppState, session_id: &str) -> IdleDecision {
    should_transition_idle_with_hook(state, session_id, || {})
}

fn should_transition_idle_with_hook<F: FnOnce()>(
    state: &crate::state::AppState,
    session_id: &str,
    after_silence_evidence: F,
) -> IdleDecision {
    // Capture the originating turn before reading the silence evidence. A new
    // submission updates the epoch before stamping last_output_ms; either this
    // decision sees the fresh timestamp, or the transition rejects its stale
    // epoch. Reading these in the opposite order can pair old silence with the
    // new turn and immediately idle a just-submitted task.
    //
    // Read the snapshot in a scoped block so the DashMap shard read-lock is
    // released before we take a write-lock below — same shard would otherwise
    // deadlock the runtime in the force-clear branch.
    let (is_agent, sub_tasks, turn_epoch) = {
        let session = state.session_states.get(session_id);
        (
            session
                .as_ref()
                .map(|s| s.agent_type.is_some())
                .unwrap_or(false),
            session.as_ref().map(|s| s.active_sub_tasks).unwrap_or(0),
            session.as_ref().map(|s| s.turn_epoch),
        )
    };
    let last_ms = state
        .last_output_ms
        .get(session_id)
        .map(|ts| ts.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(0);
    after_silence_evidence();
    if last_ms == 0 {
        return IdleDecision::NO;
    }
    let threshold = if is_agent {
        AGENT_IDLE_MS
    } else {
        SHELL_IDLE_MS
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let elapsed = now.saturating_sub(last_ms);
    if elapsed < threshold {
        return IdleDecision::NO;
    }
    if sub_tasks == 0 {
        return IdleDecision::yes(turn_epoch);
    }
    // Sub-tasks are active but no output for SUBTASK_STALE_MS — the mode-line
    // disappeared without emitting count=0 (agent exited, user cleared, etc.).
    // Force-clear the stale counter so we don't stay busy forever.
    if elapsed >= SUBTASK_STALE_MS {
        if let Some(mut entry) = state.session_states.get_mut(session_id) {
            entry.active_sub_tasks = 0;
        }
        return IdleDecision {
            should_transition: true,
            force_cleared_subtasks: true,
            turn_epoch,
        };
    }
    IdleDecision::NO
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentScreenActivity {
    Working,
    Ready,
    Interrupted,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessTreeEntry {
    pid: u32,
    parent_pid: u32,
    name: String,
    command: String,
}

#[derive(Default)]
struct ProcessSnapshotState {
    generation: u64,
    current: Option<Arc<Vec<ProcessTreeEntry>>>,
}

#[derive(Default)]
pub(crate) struct ProcessSnapshotCache {
    state: parking_lot::RwLock<ProcessSnapshotState>,
}

impl ProcessSnapshotCache {
    fn store(&self, snapshot: Option<Vec<ProcessTreeEntry>>) {
        let mut state = self.state.write();
        state.generation = state.generation.wrapping_add(1);
        state.current = snapshot.map(Arc::new);
    }

    fn load(&self) -> Option<(u64, Arc<Vec<ProcessTreeEntry>>)> {
        let state = self.state.read();
        Some((state.generation, Arc::clone(state.current.as_ref()?)))
    }

    fn generation(&self) -> u64 {
        self.state.read().generation
    }
}

fn normalized_process_name(value: &str) -> &str {
    value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .trim_end_matches(".exe")
}

/// Apply the same basename/path convention used by `process_name_from_pid`.
/// Claude's installer notably uses a version number as the executable basename,
/// so the containing `claude/versions/` path is authoritative.
fn classify_agent_name_or_path(value: &str) -> Option<&'static str> {
    let normalized = value.to_ascii_lowercase();
    let basename = normalized_process_name(&normalized);
    classify_agent(basename)
        .or_else(|| normalized.split(['/', '\\']).rev().find_map(classify_agent))
}

fn is_persistent_agent_helper(process: &ProcessTreeEntry) -> bool {
    is_persistent_agent_helper_with_command_line(process, cfg!(not(windows)))
}

fn is_standalone_timed_caffeinate(command: &str) -> bool {
    let mut argv = command.split_whitespace();
    let executable = argv.next().map(normalized_process_name).unwrap_or("");
    if executable != "caffeinate" {
        return false;
    }
    let first = argv.next();
    let second = argv.next();
    let third = argv.next();
    if argv.next().is_some() {
        return false;
    }
    let positive_timeout = |value: &str| value.parse::<u64>().is_ok_and(|seconds| seconds > 0);
    matches!((first, second, third), (Some("-i"), Some("-t"), Some(value)) if positive_timeout(value))
        || matches!((first, second, third), (Some("-t"), Some(value), Some("-i")) if positive_timeout(value))
}

fn is_persistent_agent_helper_with_command_line(
    process: &ProcessTreeEntry,
    command_line_authoritative: bool,
) -> bool {
    let name = process.name.to_ascii_lowercase();
    let name = normalized_process_name(&name);
    let command = process.command.to_ascii_lowercase();
    let mut argv = command.split_whitespace();
    let executable = argv.next().map(normalized_process_name).unwrap_or("");
    let script = argv.next().map(normalized_process_name).unwrap_or("");
    matches!(name, "mdkb" | "tuic-bridge" | "node_repl")
        || (command_line_authoritative
            && (matches!(executable, "mdkb" | "tuic-bridge" | "node_repl")
                || (matches!(executable, "node" | "nodejs")
                    && script.trim_end_matches(".js") == "node_repl")
                || is_standalone_timed_caffeinate(&command)))
}

fn agent_process_root(
    session_root: u32,
    agent_type: &str,
    processes: &[ProcessTreeEntry],
) -> Option<u32> {
    let mut children = std::collections::HashMap::<u32, Vec<&ProcessTreeEntry>>::new();
    let mut by_pid = std::collections::HashMap::<u32, &ProcessTreeEntry>::new();
    for process in processes {
        children
            .entry(process.parent_pid)
            .or_default()
            .push(process);
        by_pid.insert(process.pid, process);
    }
    by_pid.get(&session_root)?;
    let mut queue = std::collections::VecDeque::from([session_root]);
    while let Some(pid) = queue.pop_front() {
        if let Some(process) = by_pid.get(&pid) {
            let executable_arg = process.command.split_whitespace().next().unwrap_or("");
            if classify_agent_name_or_path(&process.name) == Some(agent_type)
                || classify_agent_name_or_path(executable_arg) == Some(agent_type)
            {
                return Some(pid);
            }
        }
        if let Some(descendants) = children.get(&pid) {
            queue.extend(descendants.iter().map(|process| process.pid));
        }
    }
    // A configured custom alias may have no classifiable executable path. The
    // process-group leader is then the established foreground-process fallback;
    // descendants, rather than the alias process itself, represent background work.
    Some(session_root)
}

/// Return whether `root_pid` owns at least one meaningful live descendant.
/// Helper roots and their entire subtrees are ignored: integration daemons are
/// session plumbing, not evidence that the agent still owns autonomous work.
fn has_meaningful_descendant(root_pid: u32, processes: &[ProcessTreeEntry]) -> bool {
    let mut children = std::collections::HashMap::<u32, Vec<&ProcessTreeEntry>>::new();
    for process in processes {
        children
            .entry(process.parent_pid)
            .or_default()
            .push(process);
    }
    let mut stack = vec![root_pid];
    while let Some(parent) = stack.pop() {
        let Some(descendants) = children.get(&parent) else {
            continue;
        };
        for descendant in descendants {
            if is_persistent_agent_helper(descendant) {
                continue;
            }
            return true;
        }
    }
    false
}

fn background_work_from_snapshot(
    session_root: u32,
    agent_type: &str,
    processes: &[ProcessTreeEntry],
) -> Option<bool> {
    let agent_root = agent_process_root(session_root, agent_type, processes)?;
    Some(has_meaningful_descendant(agent_root, processes))
}

#[cfg(not(windows))]
fn process_tree_snapshot() -> Option<Vec<ProcessTreeEntry>> {
    let output = std::process::Command::new("ps")
        .args(["-ww", "-axo", "pid=,ppid=,comm=,args="])
        .output()
        .ok()?;
    parse_process_tree_snapshot(
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
    )
}

#[cfg(not(windows))]
fn parse_process_tree_snapshot(success: bool, text: &str) -> Option<Vec<ProcessTreeEntry>> {
    if !success {
        return None;
    }
    let mut result = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let (pid, rest) = take_process_snapshot_field(line)?;
        let (parent_pid, rest) = take_process_snapshot_field(rest)?;
        let (name, command) = take_process_snapshot_field(rest)?;
        result.push(ProcessTreeEntry {
            pid: pid.parse().ok()?,
            parent_pid: parent_pid.parse().ok()?,
            name: name.to_string(),
            command: command.trim_start().to_string(),
        });
    }
    (!result.is_empty()).then_some(result)
}

#[cfg(not(windows))]
fn take_process_snapshot_field(value: &str) -> Option<(&str, &str)> {
    let value = value.trim_start();
    let end = value.find(char::is_whitespace).unwrap_or(value.len());
    (end > 0).then(|| (&value[..end], &value[end..]))
}

#[cfg(windows)]
fn process_tree_snapshot() -> Option<Vec<ProcessTreeEntry>> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32, Process32First, Process32Next, TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return None;
        }
        let mut result = Vec::new();
        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snapshot, &mut entry) == 0 {
            CloseHandle(snapshot);
            return valid_process_snapshot(false, result);
        }
        loop {
            let name_bytes: Vec<u8> = entry
                .szExeFile
                .iter()
                .take_while(|&&byte| byte != 0)
                .map(|&byte| byte as u8)
                .collect();
            let name = String::from_utf8_lossy(&name_bytes).into_owned();
            result.push(ProcessTreeEntry {
                pid: entry.th32ProcessID,
                parent_pid: entry.th32ParentProcessID,
                command: String::new(),
                name,
            });
            if Process32Next(snapshot, &mut entry) == 0 {
                break;
            }
        }
        CloseHandle(snapshot);
        valid_process_snapshot(true, result)
    }
}

#[cfg(any(windows, test))]
fn valid_process_snapshot(
    enumeration_succeeded: bool,
    processes: Vec<ProcessTreeEntry>,
) -> Option<Vec<ProcessTreeEntry>> {
    (enumeration_succeeded && !processes.is_empty()).then_some(processes)
}

fn emit_suggest_event(state: &AppState, session_id: &str, turn_epoch: u64, items: Vec<String>) {
    let parsed = ParsedEvent::Suggest { items };
    if let Ok(mut json) = serde_json::to_value(&parsed) {
        if let Some(object) = json.as_object_mut() {
            object.insert("_turn_epoch".to_string(), turn_epoch.into());
        }
        #[cfg(feature = "desktop")]
        if let Some(app) = state.app_handle.read().as_ref() {
            let _ = app.emit(&format!("pty-parsed-{session_id}"), &json);
        }
        state.emit_pty_event(crate::state::AppEvent::PtyParsed {
            session_id: session_id.to_string(),
            parsed: json,
        });
    }
}

fn set_background_work_for_epoch(
    state: &AppState,
    session_id: &str,
    observed_turn_epoch: u64,
    snapshot_generation: u64,
    active: bool,
) -> bool {
    set_background_work_for_epoch_with_hook(
        state,
        session_id,
        observed_turn_epoch,
        snapshot_generation,
        active,
        || {},
    )
}

fn set_background_work_for_epoch_with_hook<F: FnOnce()>(
    state: &AppState,
    session_id: &str,
    observed_turn_epoch: u64,
    snapshot_generation: u64,
    active: bool,
    after_lifecycle_snapshot: F,
) -> bool {
    let Some(silence) = state
        .silence_states
        .get(session_id)
        .map(|entry| Arc::clone(entry.value()))
    else {
        return false;
    };
    after_lifecycle_snapshot();
    let mut silence_state = silence.lock();
    let still_owns_lifecycle = state
        .silence_states
        .get(session_id)
        .is_some_and(|current| Arc::ptr_eq(current.value(), &silence));
    if !still_owns_lifecycle || !state.shell_states.contains_key(session_id) {
        return false;
    }
    let Some(mut session) = state.session_states.get_mut(session_id) else {
        return false;
    };
    if session.turn_epoch != observed_turn_epoch
        || snapshot_generation <= session.background_snapshot_generation
    {
        return false;
    }
    let reconciled_probe = if session.has_pending_background_probe() {
        let Some(boundary) = session.background_probe_after_generation else {
            return false;
        };
        if snapshot_generation <= boundary {
            return false;
        }
        session.background_probe_turn_epoch = None;
        session.background_probe_after_generation = None;
        session.background_probe_satisfied_turn_epoch = Some(observed_turn_epoch);
        true
    } else if !session.background_work {
        return false;
    } else {
        false
    };
    session.background_snapshot_generation = snapshot_generation;
    if session.background_work == active {
        if !reconciled_probe || active {
            return true;
        }
    } else {
        session.background_work = active;
    }
    drop(session);

    let mut parent_dispatch = None;
    if !active
        && state
            .shell_states
            .get(session_id)
            .is_some_and(|shell| shell.load(Ordering::Acquire) == SHELL_IDLE)
    {
        let completion = silence_state.drain_pending_suggest_with_epoch();
        match completion {
            Some((turn_epoch, items)) if turn_epoch == observed_turn_epoch => {
                emit_suggest_event(state, session_id, turn_epoch, items);
                parent_dispatch = enqueue_state_change_to_parent(
                    state,
                    session_id,
                    serde_json::json!({
                        "type": "state_change",
                        "state": "completed",
                        "session_id": session_id,
                    }),
                );
            }
            Some((turn_epoch, _)) => {
                if silence_state.completion_turn_epoch == turn_epoch {
                    silence_state.completion_declared = false;
                    silence_state.completion_turn_epoch = 0;
                }
            }
            None => {
                parent_dispatch = enqueue_state_change_to_parent(
                    state,
                    session_id,
                    serde_json::json!({
                        "type": "state_change",
                        "state": "idle",
                        "session_id": session_id,
                    }),
                );
            }
        }
    }
    drop(silence_state);
    if let Some(dispatch) = parent_dispatch {
        dispatch_parent_lifecycle(state, dispatch);
    }
    true
}

fn ready_probe_satisfied_or_requested(
    state: &AppState,
    session_id: &str,
    silence: &Arc<Mutex<SilenceState>>,
) -> bool {
    let still_owns_lifecycle = state
        .silence_states
        .get(session_id)
        .is_some_and(|current| Arc::ptr_eq(current.value(), silence));
    if !still_owns_lifecycle || !state.shell_states.contains_key(session_id) {
        return false;
    }
    let Some(mut session) = state.session_states.get_mut(session_id) else {
        return false;
    };
    if session.agent_type.is_none() {
        return true;
    }
    let turn_epoch = session.turn_epoch;
    if session.background_probe_satisfied_turn_epoch == Some(turn_epoch) {
        return true;
    }
    if !session.has_pending_background_probe() {
        session.background_probe_turn_epoch = Some(turn_epoch);
        session.background_probe_after_generation = Some(state.process_snapshot_cache.generation());
    }
    false
}

/// Invalidate only the process-snapshot boundary for the current working
/// episode. The caller must hold this session's SilenceState lifecycle lock.
fn invalidate_background_probe_boundary_locked(state: &AppState, session_id: &str) {
    let Some(mut session) = state.session_states.get_mut(session_id) else {
        return;
    };
    session.background_probe_turn_epoch = None;
    session.background_probe_after_generation = None;
    session.background_probe_satisfied_turn_epoch = None;
}

fn arm_explicit_idle_background_probe(state: &AppState, session_id: &str, turn_epoch: u64) {
    let Some(mut session) = state.session_states.get_mut(session_id) else {
        return;
    };
    if session.agent_type.is_none() || session.turn_epoch != turn_epoch {
        return;
    }
    session.background_probe_turn_epoch = Some(turn_epoch);
    session.background_probe_after_generation = Some(state.process_snapshot_cache.generation());
    session.background_probe_satisfied_turn_epoch = None;
}

fn refresh_background_work(state: &AppState, session_id: &str) {
    let agent_type = state
        .session_states
        .get(session_id)
        .and_then(|session| session.agent_type.clone());
    let observed_turn_epoch = state
        .session_states
        .get(session_id)
        .map(|session| session.turn_epoch);
    let root_pid = state.sessions.get(session_id).and_then(|entry| {
        let session = entry.value().lock();
        #[cfg(not(windows))]
        {
            session.master.process_group_leader().map(|pid| pid as u32)
        }
        #[cfg(windows)]
        {
            session._child.process_id()
        }
    });
    let (Some(root_pid), Some(agent_type), Some(observed_turn_epoch)) =
        (root_pid, agent_type, observed_turn_epoch)
    else {
        return;
    };
    refresh_background_work_from_cached_snapshot(
        state,
        session_id,
        root_pid,
        &agent_type,
        observed_turn_epoch,
        state.process_snapshot_cache.load(),
    );
}

fn refresh_background_work_from_cached_snapshot(
    state: &AppState,
    session_id: &str,
    root_pid: u32,
    agent_type: &str,
    observed_turn_epoch: u64,
    cached: Option<(u64, Arc<Vec<ProcessTreeEntry>>)>,
) -> bool {
    let Some((generation, processes)) = cached else {
        return false;
    };
    let Some(active) = background_work_from_snapshot(root_pid, agent_type, &processes) else {
        return false;
    };
    set_background_work_for_epoch(state, session_id, observed_turn_epoch, generation, active)
}

fn process_snapshot_is_demanded(state: &AppState) -> bool {
    state.session_states.iter().any(|session| {
        session.agent_type.is_some()
            && (session.has_pending_background_probe() || session.background_work)
            && state.silence_states.contains_key(session.key())
            && state.shell_states.contains_key(session.key())
    })
}

fn reconcile_process_snapshot_demand(state: &AppState) {
    let sessions: Vec<String> = state
        .session_states
        .iter()
        .filter(|session| {
            session.agent_type.is_some()
                && (session.has_pending_background_probe() || session.background_work)
                && state.silence_states.contains_key(session.key())
                && state.shell_states.contains_key(session.key())
        })
        .map(|session| session.key().clone())
        .collect();
    for session_id in sessions {
        refresh_background_work(state, &session_id);
    }
}

fn refresh_process_snapshot_if_demanded<F>(state: &AppState, enumerate: F) -> bool
where
    F: FnOnce() -> Option<Vec<ProcessTreeEntry>>,
{
    if !process_snapshot_is_demanded(state) {
        return false;
    }
    state.process_snapshot_cache.store(enumerate());
    reconcile_process_snapshot_demand(state);
    true
}

/// Enumerate the OS process table at most once per lifecycle cadence on
/// Tokio's blocking pool while a probe or tracked child needs reconciliation.
/// Every demanding session reads the resulting app-wide cache.
pub(crate) fn spawn_process_snapshot_refresher(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let refresh_state = Arc::clone(&state);
            let _ = tokio::task::spawn_blocking(move || {
                refresh_process_snapshot_if_demanded(&refresh_state, process_tree_snapshot)
            })
            .await;
        }
    });
}

/// Inspect Codex's live prompt neighborhood on the UNFILTERED screen.
///
/// `find_chrome_cutoff` cannot be used here: Codex separators delimit tool
/// output from summaries, not its prompt box. When a recent separator sits
/// above `• Working`, the generic cutoff intentionally trims the whole region
/// and used to hide the strongest activity signal from both reader and timer.
/// Restricting the match to a few rows immediately above the lowest `›` prompt
/// prevents a historical Working line elsewhere in the viewport from latching
/// the session busy.
fn detect_codex_screen_activity(rows: &[String]) -> AgentScreenActivity {
    const PROMPT_NEIGHBORHOOD: usize = 6;

    let Some(prompt_idx) = rows.iter().rposition(|row| {
        let t = row.trim_start();
        t.starts_with('\u{203A}') && !t.starts_with("\u{203A}\u{203A}")
    }) else {
        return AgentScreenActivity::Unknown;
    };
    let start = prompt_idx.saturating_sub(PROMPT_NEIGHBORHOOD);
    let neighborhood = &rows[start..prompt_idx];

    if neighborhood
        .iter()
        .any(|row| crate::chrome::is_working_status_row(row))
    {
        return AgentScreenActivity::Working;
    }
    if neighborhood
        .iter()
        .any(|row| row.trim_start().starts_with("■ Conversation interrupted"))
    {
        return AgentScreenActivity::Interrupted;
    }
    AgentScreenActivity::Ready
}

/// Claude/Gemini/Aider screen classification is PROMPT-based only (#446-596f):
/// Working is never inferred from glyph presence. A spinner is defined by
/// ANIMATION, and animation is only observable as text above the input area
/// CHANGING — the PTY reader owns that evidence (a spinner row among the
/// post-cutoff `changed_rows` latches and keeps BUSY; a byte-identical repaint
/// produces no ChangedRow, so a frozen glyph physically cannot). Any static
/// glyph — a completed-turn summary (`✻ Sautéed for 1m 25s`), a `· run /mcp`
/// hint, HUD bars, banner art — is therefore inert by construction: it cannot
/// classify Working, cannot latch or hold BUSY, and cannot mask the Ready
/// prompt below it. Codex is the deliberate exception (presence-based, see
/// `detect_codex_screen_activity`): its TUI legitimately freezes while a child
/// process runs.
fn detect_claude_screen_activity(rows: &[String]) -> AgentScreenActivity {
    let content_end = rows
        .iter()
        .rposition(|row| !row.trim().is_empty())
        .map_or(0, |idx| idx + 1);
    let chrome_start = content_end.saturating_sub(crate::chrome::CHROME_SCAN_ROWS);
    let prompt_present = rows[chrome_start..content_end]
        .iter()
        .any(|row| row.trim() == "\u{276F}");
    if prompt_present {
        AgentScreenActivity::Ready
    } else {
        AgentScreenActivity::Unknown
    }
}

fn gemini_prompt_present(rows: &[String]) -> bool {
    rows.iter().any(|row| {
        let t = row.trim_start();
        t == ">" || t.starts_with("> ")
    })
}

/// Prompt-based only — see `detect_claude_screen_activity` for the rationale.
fn detect_gemini_screen_activity(rows: &[String]) -> AgentScreenActivity {
    if gemini_prompt_present(rows) {
        AgentScreenActivity::Ready
    } else {
        AgentScreenActivity::Unknown
    }
}

/// Prompt-based only — see `detect_claude_screen_activity` for the rationale.
/// During generation Aider has no bottom input box (prompt_toolkit returned),
/// so the screen reads Unknown and BUSY is held by spinner movement + silence.
fn detect_aider_screen_activity(rows: &[String]) -> AgentScreenActivity {
    if rows.iter().rev().take(3).any(|row| row.trim() == ">") {
        AgentScreenActivity::Ready
    } else {
        AgentScreenActivity::Unknown
    }
}

fn detect_agent_screen_activity(agent_type: Option<&str>, rows: &[String]) -> AgentScreenActivity {
    match agent_type {
        Some("claude") => detect_claude_screen_activity(rows),
        Some("codex") => detect_codex_screen_activity(rows),
        Some("gemini") => detect_gemini_screen_activity(rows),
        Some("aider") => detect_aider_screen_activity(rows),
        _ => AgentScreenActivity::Unknown,
    }
}

pub(crate) fn has_ready_screen_adapter(agent_type: Option<&str>) -> bool {
    matches!(agent_type, Some("claude" | "codex" | "gemini" | "aider"))
}

fn stamp_last_output_now(state: &crate::state::AppState, session_id: &str, now_ms: u64) {
    if let Some(ts) = state.last_output_ms.get(session_id) {
        ts.store(now_ms, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Apply positive working evidence immediately. In particular this repairs an
/// already-false-idle session: working evidence is an edge into BUSY, not merely
/// a keepalive that only runs while the state happens to be busy. An explicit
/// idle marker (agent hook) outranks it until the next busy evidence.
///
/// Two sources call this (#446-596f):
/// - `"working-screen"` — Codex's presence-based `• Working (… esc to
///   interrupt)` status line (its TUI legitimately freezes while a child runs).
/// - `"spinner-movement"` — a spinner row among the post-cutoff `changed_rows`.
///   Changed rows are text-equality diffed, so this fires only while the
///   spinner actually ANIMATES; a frozen glyph cannot reach here.
fn apply_working_evidence(
    state: &crate::state::AppState,
    silence: &Arc<Mutex<SilenceState>>,
    session_id: &str,
    now_ms: u64,
    source: &'static str,
) {
    {
        let mut sl = silence.lock();
        let turn_completed = state
            .session_states
            .get(session_id)
            .is_some_and(|session| sl.completion_declared_for_epoch(session.turn_epoch));
        if turn_completed {
            return;
        }
        if sl.explicit_idle {
            return;
        }
        sl.note_working_screen();
        invalidate_background_probe_boundary_locked(state, session_id);
    }
    stamp_last_output_now(state, session_id, now_ms);
    let prev = state
        .shell_states
        .get(session_id)
        .map(|atom| atom.load(std::sync::atomic::Ordering::Acquire));
    if let Some(prev) = prev
        && prev != SHELL_BUSY
        && try_shell_transition(state, session_id, prev, SHELL_BUSY, true)
    {
        tracing::debug!(session_id, activity_source = source, "Shell state → busy");
        emit_shell_state(state, session_id, "busy");
    }
}

/// A submitted line to a known agent is strong BUSY evidence even before the
/// first model token or spinner repaint. Adapter-backed agents hold that state
/// until a ready screen/explicit Stop; unknown agents retain the timing fallback.
pub(crate) fn note_submitted_input(state: &AppState, session_id: &str) {
    note_submitted_input_with_hook(state, session_id, || {});
}

fn note_submitted_input_with_hook<F: FnOnce()>(state: &AppState, session_id: &str, after_epoch: F) {
    let agent_type = state
        .session_states
        .get(session_id)
        .and_then(|s| s.agent_type.clone());
    let Some(agent_type) = agent_type else {
        if let Some(sl) = state.silence_states.get(session_id) {
            let mut silence = sl.lock();
            silence.note_user_submission(false);
            silence.reset_suggest_memory();
        }
        return;
    };

    let silence = state
        .silence_states
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(SilenceState::new())))
        .clone();
    let transitioned_busy = {
        // Lock order for submitted turns is SilenceState → SessionState → shell
        // atomics. Completion drains and Suggest parsing use the same order.
        let mut silence = silence.lock();
        if let Some(mut session) = state.session_states.get_mut(session_id) {
            session.turn_epoch = session.turn_epoch.wrapping_add(1);
            session.suggested_actions = None;
        }
        after_epoch();
        silence.note_user_submission(has_ready_screen_adapter(Some(&agent_type)));
        silence.reset_suggest_memory();
        stamp_last_output_now(state, session_id, now_epoch_ms());
        let prev = state
            .shell_states
            .get(session_id)
            .map(|atom| atom.load(std::sync::atomic::Ordering::Acquire));
        let transitioned = prev.is_some_and(|prev| {
            prev != SHELL_BUSY
                && try_shell_transition_locked(
                    ShellTransitionRequest {
                        state,
                        session_id,
                        expected: prev,
                        new: SHELL_BUSY,
                        notify_parent: true,
                        observed_turn_epoch: None,
                    },
                    Some(&mut silence),
                    || {},
                )
                .0
        });
        if transitioned {
            emit_shell_state(state, session_id, "busy");
        }
        transitioned
    };
    if transitioned_busy {
        tracing::debug!(
            session_id,
            activity_source = "user-submit",
            "Shell state → busy"
        );
    }
}

/// Emit a ShellState parsed event via both event bus and Tauri IPC.
fn emit_shell_state(state: &crate::state::AppState, session_id: &str, shell_state: &str) {
    let agent_type = state
        .session_states
        .get(session_id)
        .and_then(|s| s.agent_type.clone());
    let parsed = ParsedEvent::ShellState {
        state: shell_state.to_string(),
        agent_type,
    };
    match serde_json::to_value(&parsed) {
        Ok(json) => {
            state.emit_pty_event(crate::state::AppEvent::PtyParsed {
                session_id: session_id.to_string(),
                parsed: json,
            });
        }
        Err(e) => tracing::error!(session_id, "Failed to serialize ShellState event: {e}"),
    }
    #[cfg(feature = "desktop")]
    if let Some(app) = state.app_handle.read().as_ref() {
        let _ = app.emit(&format!("pty-parsed-{session_id}"), &parsed);
    }
}

/// Apply an authoritative shell-state marker and emit the new state if it
/// changed. Shared by OSC 133 A/C and OSC 7770 `state=` handlers.
fn transition_explicit_shell_state(
    state: &crate::state::AppState,
    session_id: &str,
    target: u8,
    label: &str,
    hook_state: bool,
) {
    transition_explicit_shell_state_with_hook(state, session_id, target, label, hook_state, || {});
}

fn transition_explicit_shell_state_with_hook<F: FnOnce()>(
    state: &crate::state::AppState,
    session_id: &str,
    target: u8,
    label: &str,
    hook_state: bool,
    before_transaction: F,
) {
    let evidence_turn_epoch = state
        .session_states
        .get(session_id)
        .map(|session| session.turn_epoch);
    before_transaction();
    let silence = state
        .silence_states
        .get(session_id)
        .map(|entry| Arc::clone(entry.value()));
    let (transitioned, parent_dispatch) = {
        let mut silence_guard = silence.as_ref().map(|silence| silence.lock());
        if target == SHELL_IDLE
            && evidence_turn_epoch.is_some_and(|observed| {
                state
                    .session_states
                    .get(session_id)
                    .is_some_and(|session| session.turn_epoch != observed)
            })
        {
            return;
        }
        if let Some(silence) = silence_guard.as_mut() {
            silence.note_explicit_state(target, hook_state);
            if target == SHELL_BUSY {
                invalidate_background_probe_boundary_locked(state, session_id);
            }
        }
        if target == SHELL_BUSY {
            stamp_last_output_now(state, session_id, now_epoch_ms());
        }
        let prev = match state.shell_states.get(session_id) {
            Some(atom) => atom.load(std::sync::atomic::Ordering::Acquire),
            None => return,
        };
        if prev == target {
            return;
        }
        if prev == SHELL_BUSY
            && target == SHELL_IDLE
            && let Some(turn_epoch) = evidence_turn_epoch
        {
            arm_explicit_idle_background_probe(state, session_id, turn_epoch);
        }
        try_shell_transition_locked(
            ShellTransitionRequest {
                state,
                session_id,
                expected: prev,
                new: target,
                notify_parent: true,
                observed_turn_epoch: evidence_turn_epoch,
            },
            silence_guard.as_deref_mut(),
            || {},
        )
    };
    if let Some(dispatch) = parent_dispatch {
        dispatch_parent_lifecycle(state, dispatch);
    }
    if transitioned {
        emit_shell_state(state, session_id, label);
        // Publish IDLE before a queued delivery claims IDLE→BUSY again. Reversing
        // this order leaves the backend BUSY while the frontend's last event is
        // the stale IDLE emitted by this caller.
        if target == SHELL_IDLE {
            flush_pending_injections(state, session_id);
        }
    }
}

/// Emit an ActiveSubtasks parsed event via both event bus and Tauri IPC.
/// Used by the stale-subtasks recovery path to keep the frontend store in
/// sync after `should_transition_idle` force-clears the in-memory counter.
fn emit_active_subtasks(
    state: &crate::state::AppState,
    session_id: &str,
    count: u32,
    task_type: &str,
) {
    let parsed = ParsedEvent::ActiveSubtasks {
        count,
        task_type: task_type.to_string(),
    };
    match serde_json::to_value(&parsed) {
        Ok(json) => {
            state.emit_pty_event(crate::state::AppEvent::PtyParsed {
                session_id: session_id.to_string(),
                parsed: json,
            });
        }
        Err(e) => tracing::error!(session_id, "Failed to serialize ActiveSubtasks event: {e}"),
    }
    #[cfg(feature = "desktop")]
    if let Some(app) = state.app_handle.read().as_ref() {
        let _ = app.emit(&format!("pty-parsed-{session_id}"), &parsed);
    }
}

/// Extract a signal number from portable_pty's signal string.
/// Format is typically "Killed: 9", "Interrupt: 2", or "Signal 15".
pub(crate) fn parse_signal_number(sig: &str) -> i32 {
    sig.rsplit(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .and_then(|s| s.parse::<i32>().ok())
        .unwrap_or(0)
}

fn parse_osc7_cwd(url: &str) -> Result<String, ()> {
    let rest = url.strip_prefix("file://").ok_or(())?;
    let path_start = rest.find('/').ok_or(())?;
    let raw = &rest[path_start..];
    if raw.is_empty() {
        return Err(());
    }
    let decoded = percent_decode(raw)?;
    let path = if decoded.len() > 1 && decoded.ends_with('/') {
        &decoded[..decoded.len() - 1]
    } else {
        &decoded
    };
    if !path.starts_with('/') {
        return Err(());
    }
    Ok(path.to_string())
}

fn percent_decode(s: &str) -> Result<String, ()> {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_val(bytes[i + 1]).ok_or(())?;
            let lo = hex_val(bytes[i + 2]).ok_or(())?;
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn parse_osc133_exit_code(command: char, params: &str) -> Option<i32> {
    if command == 'D' && !params.is_empty() {
        params.parse::<i32>().ok()
    } else {
        None
    }
}

/// Detect Claude Code tool call headers: `⏺ ToolName(args)`.
/// The ⏺ (U+23FA) bullet followed by a capitalized word and `(` is unique to
/// CC's expanded tool-call rendering — agent prose after ⏺ starts with a
/// lowercase word or a proper noun without parens.
fn is_cc_tool_call_header(text: &str) -> bool {
    let trimmed = text.trim_start();
    let rest = if let Some(r) = trimmed.strip_prefix('\u{23FA}') {
        r
    } else {
        return false;
    };
    let rest = rest.trim_start();
    if rest.is_empty() {
        return false;
    }
    // Must start with uppercase ASCII (ToolName) or `mcp__` prefix.
    let first = rest.as_bytes()[0];
    if !first.is_ascii_uppercase() && !rest.starts_with("mcp__") {
        return false;
    }
    // Find the opening paren — everything before it must be a single
    // identifier (no spaces). Rejects prose like "Boss, ci sono (molti)".
    rest.find('(').is_some_and(|pos| {
        let before = &rest[..pos];
        !before.is_empty()
            && before
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    })
}

/// Emit an `Inferred` command outcome for shells that don't speak OSC 133.
/// Called right after a busy→idle transition; no-op once we've ever observed
/// a marker for this session (shell-integration path is authoritative then).
/// The command text is unknown in this mode, but cwd + snippet still populate
/// context summary and cwd history.
fn record_inferred_outcome_if_no_osc133(state: &AppState, session_id: &str) {
    use crate::ai_agent::knowledge::{CommandOutcome, OutcomeClass};

    if state.has_osc133_integration.contains_key(session_id) {
        return;
    }
    // try_lock to avoid blocking the timer thread if write_pty holds
    // the session lock. Inferred outcomes are best-effort — missing cwd
    // for one record is acceptable vs risking contention.
    let cwd = state
        .sessions
        .get(session_id)
        .and_then(|s| s.try_lock().and_then(|s| s.cwd.clone()))
        .unwrap_or_default();
    let output_snippet = state
        .vt_log_buffers
        .get(session_id)
        .map(|b| {
            let buf = b.lock();
            buf.screen_rows().join("\n")
        })
        .unwrap_or_default();
    let mut tail_start = output_snippet.len().saturating_sub(500);
    while tail_start > 0 && !output_snippet.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    let output_snippet = output_snippet[tail_start..].to_string();

    let outcome = CommandOutcome {
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        command: String::new(),
        cwd,
        exit_code: None,
        output_snippet,
        classification: OutcomeClass::Inferred,
        duration_ms: 0,
        id: 0,
    };
    state.record_outcome(session_id, outcome);
}

/// How many bottom screen rows to check when verifying a question candidate.
/// Wide enough to cover agent footer layouts (mode line, spinner, Wiz HUD,
/// suggest/intent blocks, trailing disclaimer text) that push the actual
/// question several rows above the prompt box.
const SCREEN_VERIFY_ROWS: usize = 20;

struct TimerIdleTransition {
    transitioned: bool,
    force_cleared_subtasks: bool,
    screen_confirms_idle: bool,
}

fn try_timer_idle_transition(
    state: &AppState,
    silence: &Arc<Mutex<SilenceState>>,
    session_id: &str,
    screen_activity: AgentScreenActivity,
    agent_type: Option<&str>,
    evidence_turn_epoch: Option<u64>,
) -> TimerIdleTransition {
    let lifecycle = Arc::clone(silence);
    let (transitioned, force_cleared_subtasks, screen_confirms_idle, parent_dispatch) = {
        let mut silence = silence.lock();
        if evidence_turn_epoch.is_some_and(|observed| {
            state
                .session_states
                .get(session_id)
                .is_some_and(|session| session.turn_epoch != observed)
        }) {
            return TimerIdleTransition {
                transitioned: false,
                force_cleared_subtasks: false,
                screen_confirms_idle: false,
            };
        }

        let screen_confirms_idle = match screen_activity {
            AgentScreenActivity::Ready => silence.note_ready_screen(),
            AgentScreenActivity::Interrupted => silence.note_interrupted_screen(),
            AgentScreenActivity::Unknown => {
                silence.note_unknown_screen();
                false
            }
            AgentScreenActivity::Working => false,
        };
        let is_busy = state
            .shell_states
            .get(session_id)
            .is_some_and(|atom| atom.load(std::sync::atomic::Ordering::Acquire) == SHELL_BUSY);
        if !is_busy || screen_activity == AgentScreenActivity::Working {
            return TimerIdleTransition {
                transitioned: false,
                force_cleared_subtasks: false,
                screen_confirms_idle,
            };
        }

        let hold_for_ready_confirmation = matches!(
            screen_activity,
            AgentScreenActivity::Ready | AgentScreenActivity::Interrupted
        ) && !screen_confirms_idle;
        let ready_probe_satisfied = !screen_confirms_idle
            || ready_probe_satisfied_or_requested(state, session_id, &lifecycle);
        let decision = if screen_confirms_idle && ready_probe_satisfied {
            IdleDecision::yes(evidence_turn_epoch)
        } else if screen_confirms_idle
            || silence.explicit_busy
            || hold_for_ready_confirmation
            || silence.is_api_retry_active()
        {
            IdleDecision::NO
        } else {
            should_transition_idle(state, session_id)
        };
        if !decision.should_transition {
            return TimerIdleTransition {
                transitioned: false,
                force_cleared_subtasks: false,
                screen_confirms_idle,
            };
        }
        if !screen_confirms_idle {
            silence.idle_confirmed = agent_type.is_none();
        }
        let (transitioned, parent_dispatch) = try_shell_transition_locked(
            ShellTransitionRequest {
                state,
                session_id,
                expected: SHELL_BUSY,
                new: SHELL_IDLE,
                notify_parent: true,
                observed_turn_epoch: decision.turn_epoch,
            },
            Some(&mut silence),
            || {},
        );
        (
            transitioned,
            decision.force_cleared_subtasks,
            screen_confirms_idle,
            parent_dispatch,
        )
    };
    if let Some(dispatch) = parent_dispatch {
        dispatch_parent_lifecycle(state, dispatch);
    }
    TimerIdleTransition {
        transitioned,
        force_cleared_subtasks,
        screen_confirms_idle,
    }
}

fn completion_adjusted_screen_activity(
    state: &AppState,
    silence: &Arc<Mutex<SilenceState>>,
    session_id: &str,
    screen_activity: AgentScreenActivity,
) -> AgentScreenActivity {
    if screen_activity != AgentScreenActivity::Working {
        return screen_activity;
    }
    let silence = silence.lock();
    if state
        .session_states
        .get(session_id)
        .is_some_and(|session| silence.completion_declared_for_epoch(session.turn_epoch))
    {
        AgentScreenActivity::Ready
    } else {
        screen_activity
    }
}

/// Spawn the silence-detection timer thread. Shared by desktop and headless readers.
///
/// Two strategies run in priority order:
/// 1. **Screen-based**: read the terminal screen, find the last chat line above the
///    prompt box (delimited by two separator lines), check if it ends with `?`.
/// 2. **Chunk-based fallback**: use `check_silence()` with `pending_question_line`
///    for agents that don't have a prompt box (plain shell, etc.).
fn spawn_silence_timer(
    silence: Arc<Mutex<SilenceState>>,
    running: Arc<AtomicBool>,
    session_id: String,
    state: Arc<AppState>,
) {
    tokio::spawn(async move {
        // Track the inter-tick gap in WALL-CLOCK time, not `Instant`.
        // `should_transition_idle` measures idle elapsed against the wall clock
        // (`last_output_ms` is epoch millis), so sleep detection MUST use the
        // same clock. On macOS, `Instant` (mach_absolute_time) does not advance
        // while the system is asleep — an Instant-based gap stays ~1s across a
        // lid-close sleep and never detects the wake, letting the wall-clock
        // jump fire a false busy→idle (completion sound) on every terminal.
        let mut last_tick_ms = now_epoch_ms();
        while running.load(Ordering::Relaxed) {
            tokio::time::sleep(SILENCE_CHECK_INTERVAL).await;
            if !running.load(Ordering::Relaxed) {
                break;
            }

            // Sleep-wake detection: if the wall-clock gap between consecutive
            // ticks is much larger than SILENCE_CHECK_INTERVAL, the system was
            // asleep (lid closed) or the clock stepped. Reset timestamps so
            // stale elapsed times don't trigger false idle transitions /
            // completion sounds.
            let epoch_now = now_epoch_ms();
            let tick_gap = std::time::Duration::from_millis(epoch_now.saturating_sub(last_tick_ms));
            last_tick_ms = epoch_now;
            if tick_gap >= SLEEP_WAKE_GAP {
                tracing::info!(
                    source = "silence_timer",
                    session_id = %session_id,
                    gap_secs = tick_gap.as_secs(),
                    "Sleep-wake detected — resetting timestamps"
                );
                if let Some(ts) = state.last_output_ms.get(&session_id) {
                    ts.store(epoch_now, std::sync::atomic::Ordering::Release);
                }
                {
                    let mut sl = silence.lock();
                    let now = std::time::Instant::now();
                    sl.last_output_at = now;
                    sl.last_chunk_at = now;
                }
                continue;
            }

            // Reconcile high-confidence screen evidence before the silence
            // fallback. Working here means Codex's presence-based status line
            // (the only screen classifier that returns Working, #446-596f); it
            // runs regardless of current state so it repairs an already-false-
            // idle session instead of merely keeping a pre-existing BUSY alive.
            // Claude/Gemini/Aider BUSY is movement-driven in the reader.
            let idle_evidence_turn_epoch = state
                .session_states
                .get(&session_id)
                .map(|session| session.turn_epoch);
            let agent_type = state
                .session_states
                .get(&session_id)
                .and_then(|s| s.agent_type.clone());
            let screen_activity = state
                .vt_log_buffers
                .get(&session_id)
                .map(|vt| {
                    detect_agent_screen_activity(agent_type.as_deref(), &vt.lock().screen_rows())
                })
                .unwrap_or(AgentScreenActivity::Unknown);
            let screen_activity =
                completion_adjusted_screen_activity(&state, &silence, &session_id, screen_activity);
            let tracked_background_work = state
                .session_states
                .get(&session_id)
                .is_some_and(|session| session.background_work);
            let shell_is_busy = state
                .shell_states
                .get(&session_id)
                .is_some_and(|shell| shell.load(Ordering::Acquire) == SHELL_BUSY);
            if tracked_background_work
                || (shell_is_busy
                    && matches!(
                        screen_activity,
                        AgentScreenActivity::Ready | AgentScreenActivity::Interrupted
                    ))
            {
                refresh_background_work(&state, &session_id);
            }
            if screen_activity == AgentScreenActivity::Working {
                apply_working_evidence(&state, &silence, &session_id, epoch_now, "working-screen");
            } else {
                // Evidence mutation, silence decision, and BUSY→IDLE CAS share
                // one lifecycle transaction. A new submitted epoch therefore
                // wins before any stale Ready/Interrupted/Unknown evidence can
                // alter its SilenceState.
                let transition = try_timer_idle_transition(
                    &state,
                    &silence,
                    &session_id,
                    screen_activity,
                    agent_type.as_deref(),
                    idle_evidence_turn_epoch,
                );
                if transition.transitioned {
                    if transition.force_cleared_subtasks {
                        emit_active_subtasks(&state, &session_id, 0, "");
                    }
                    if let Some(vt) = state.vt_log_buffers.get(&session_id) {
                        vt.lock().process(b"\x1b[?25h");
                    }
                    tracing::debug!(
                        session_id,
                        activity_source = if transition.screen_confirms_idle {
                            "agent-ready-screen"
                        } else {
                            "silence"
                        },
                        idle_confirmed = silence.lock().idle_confirmed,
                        "Shell state → idle"
                    );
                    emit_shell_state(&state, &session_id, "idle");
                    flush_pending_injections(&state, &session_id);
                    record_inferred_outcome_if_no_osc133(&state, &session_id);
                }
            }

            // Update startup grace state (checks if output has settled).
            {
                let mut sl = silence.lock();
                sl.check_startup_settle();
                if sl.is_startup_grace() {
                    continue; // Still in startup burst — suppress question detection
                }
            }

            // Tool-error turn-end: `Error: Exit code N` + silence = fire playError.
            // Checked before question detection — a tool error is not a question.
            if let Some(text) = silence.lock().check_tool_error() {
                let parsed = ParsedEvent::ToolError { matched_text: text };
                if let Ok(json) = serde_json::to_value(&parsed) {
                    #[cfg(feature = "desktop")]
                    if let Some(app) = state.app_handle.read().as_ref() {
                        let _ = app.emit(&format!("pty-parsed-{session_id}"), &json);
                    }
                    state.emit_pty_event(crate::state::AppEvent::PtyParsed {
                        session_id: session_id.clone(),
                        parsed: json,
                    });
                }
            }

            // Suggest turn-end: drain parked `suggest:` items once the shell
            // has transitioned to IDLE. The reader parks them at parse time
            // (see write_pty's emit loop); gating the drain on shell_state ==
            // IDLE makes the frontend's `pendingSuggest` race impossible —
            // the event physically cannot reach the UI before idle.
            emit_pending_suggest_if_idle(&state, &silence, &session_id);

            // Check temporal conditions first (shared by both strategies).
            let is_silent = silence.lock().is_silent();
            if !is_silent {
                continue;
            }

            // Strategy 1: screen-based — walk upward from the prompt box looking
            // for the most recent plausible question within a bounded window.
            // This is robust to trailing non-question text between the question
            // and the prompt box (e.g. "(stopping here — waiting for your answer)").
            let screen_question = state.vt_log_buffers.get(&session_id).and_then(|vt| {
                let rows = vt.lock().screen_rows();
                let line = find_last_chat_question(&rows);
                tracing::trace!(
                    session_id = %session_id,
                    found = line.is_some(),
                    line = line.as_deref().unwrap_or(""),
                    "DIAG silence_timer: screen strategy"
                );
                line
            });

            // Strategy 2: chunk-based fallback — pending_question_line + screen verify.
            let prompt_text = if let Some(line) = screen_question {
                line
            } else {
                let question = silence.lock().check_silence();
                match question {
                    Some(ref text) => {
                        let on_screen = state
                            .vt_log_buffers
                            .get(&session_id)
                            .map(|vt| {
                                verify_question_on_screen(
                                    &vt.lock().screen_rows(),
                                    text,
                                    SCREEN_VERIFY_ROWS,
                                )
                            })
                            .unwrap_or(false);
                        tracing::debug!(
                            session_id = %session_id,
                            question = %text,
                            on_screen = on_screen,
                            "silence_timer: chunk fallback"
                        );
                        if !on_screen {
                            silence.lock().clear_stale_question();
                            continue;
                        }
                        text.clone()
                    }
                    None => {
                        tracing::trace!(
                            session_id = %session_id,
                            "silence_timer: silent but no question candidate"
                        );
                        continue;
                    }
                }
            };

            // Suppress heuristics only after a hook marker was observed at
            // runtime. A persisted config flag alone can be stale after a failed
            // install or an agent-version change.
            let hook_configured = state
                .session_states
                .get(&session_id)
                .map(|s| s.hook_instrumented)
                .unwrap_or(false);
            if hook_configured && silence.lock().hook_state_seen {
                silence.lock().clear_stale_question();
                continue;
            }

            // Emit question event.
            silence.lock().mark_emitted(&prompt_text);
            let parsed = ParsedEvent::Question {
                prompt_text: prompt_text.clone(),
                confident: false,
            };
            if let Ok(json) = serde_json::to_value(&parsed) {
                #[cfg(feature = "desktop")]
                if let Some(app) = state.app_handle.read().as_ref() {
                    let _ = app.emit(&format!("pty-parsed-{session_id}"), &json);
                }
                state.emit_pty_event(crate::state::AppEvent::PtyParsed {
                    session_id: session_id.clone(),
                    parsed: json,
                });
            }
        }
    });
}

/// Publish the explicit end-of-task marker only after the shell has settled.
/// A completed lifecycle event is emitted from the same drain point, so an
/// orchestrator never has to reinterpret an ambiguous BUSY→IDLE transition.
fn emit_pending_suggest_if_idle(
    state: &AppState,
    silence: &Arc<Mutex<SilenceState>>,
    session_id: &str,
) -> bool {
    let shell_is_idle = state
        .shell_states
        .get(session_id)
        .map(|atom| atom.load(std::sync::atomic::Ordering::Acquire) == SHELL_IDLE)
        .unwrap_or(false);
    if !shell_is_idle {
        return false;
    }
    // Serialize completion emission against note_submitted_input, which takes
    // this same lock before advancing SessionState.turn_epoch and clearing the
    // old turn. Whichever owns the lock first defines the lifecycle order.
    let mut silence_state = silence.lock();
    let Some((current_turn_epoch, background_work)) = state
        .session_states
        .get(session_id)
        .map(|session| (session.turn_epoch, session.background_work))
    else {
        return false;
    };
    if background_work {
        return false;
    }
    let Some((turn_epoch, items)) = silence_state.drain_pending_suggest_with_epoch() else {
        return false;
    };
    if turn_epoch != current_turn_epoch {
        if silence_state.completion_turn_epoch == turn_epoch {
            silence_state.completion_declared = false;
            silence_state.completion_turn_epoch = 0;
        }
        return false;
    }
    emit_suggest_event(state, session_id, turn_epoch, items);
    let parent_dispatch = enqueue_state_change_to_parent(
        state,
        session_id,
        serde_json::json!({
            "type": "state_change",
            "state": "completed",
            "session_id": session_id,
        }),
    );
    drop(silence_state);
    if let Some(dispatch) = parent_dispatch {
        dispatch_parent_lifecycle(state, dispatch);
    }
    true
}

// ---------------------------------------------------------------------------
// ChunkProcessor: shared output processing logic for desktop & headless readers
// ---------------------------------------------------------------------------

/// Extract a clean prompt from grok's "⚠ Action Required" OSC 0 title.
/// Strips the leading warning / "Action Required" marker, the spinner braille
/// frame, and separators, leaving the human-readable action description.
/// `"⚠ Action Required - ⠙ - Running: echo x - Execute Shell …"` → `"Running: echo x - Execute Shell …"`.
fn clean_action_required_title(title: &str) -> String {
    let after = title.split("Action Required").nth(1).unwrap_or(title);
    let cleaned = after
        .trim_start_matches(|c: char| {
            c == '-' || c == ' ' || ('\u{2800}'..='\u{28FF}').contains(&c)
        })
        .trim();
    if cleaned.is_empty() {
        "grok is awaiting approval".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Map a TUIC `state=` verb to the awaiting-input `ParsedEvent` it implies.
///
/// busy/idle shell transitions are handled by `handle_tuic_state`; this covers
/// only the separate `awaiting_input` field, which is driven by Question /
/// UserInput events in `state.rs`:
/// - `awaiting` → confident `Question` (sets `awaiting_input` + `question_confident`)
/// - `busy`     → `UserInput` clear (hook busy is authoritative — clears an awaiting
///   set by a prior `PreToolUse(AskUserQuestion)`; empty content never overwrites
///   `last_prompt`)
/// - anything else (incl. `idle`, unknown) → `None`
fn tuic_state_awaiting_event(payload: &str, line: i64) -> Option<ParsedEvent> {
    match payload {
        "awaiting" => Some(ParsedEvent::Question {
            prompt_text: String::new(),
            confident: true,
        }),
        // `line` is the absolute prompt row (history_size + cursor row) at the
        // busy transition — the row the user's submitted prompt sits on. Carried
        // so the frontend can mark user-prompt lines on the scrollbar.
        "busy" => Some(ParsedEvent::UserInput {
            content: String::new(),
            line,
        }),
        _ => None,
    }
}

/// Whether `agent_type`'s config enables native-hook instrumentation. Resolved
/// once when the session's agent type becomes known (config changes apply on the
/// next agent launch, matching when the hooks themselves take effect).
pub(crate) fn hook_instrumented_for(
    agents: &crate::config::AgentsConfig,
    agent_type: Option<&str>,
) -> bool {
    agent_type
        .and_then(|at| agents.agents.get(at))
        .and_then(|s| s.hook_instrumentation)
        .unwrap_or(false)
}

/// Whether a heuristic `Question` event should be suppressed for this session.
/// Hook-instrumented agents report awaiting via OSC 7770 (`state=awaiting`), so
/// the silence/regex question heuristics would only double-fire. Only `Question`
/// is suppressed — idle/busy transitions and every other event pass through.
fn suppress_heuristic_question(hook_instrumented: bool, event: &ParsedEvent) -> bool {
    hook_instrumented && matches!(event, ParsedEvent::Question { .. })
}

/// Per-session mutable state for processing PTY output chunks.
/// Holds dedup state, parser, and session CWD for PlanFile resolution.
/// Used by `spawn_reader_thread`.
struct ChunkProcessor {
    parser: OutputParser,
    /// Dedup: only emit StatusLine when task_name actually changes
    last_status_task: Option<String>,
    /// Dedup: don't re-emit the same question prompt_text
    last_question_text: Option<String>,
    /// Dedup: last emitted ChoicePrompt signature (title + option keys).
    /// Prevents re-emit on repaint while the dialog stays on screen.
    last_choice_prompt_sig: Option<String>,
    /// Session CWD for resolving relative plan-file paths
    session_cwd: Option<String>,
    /// Plan files awaiting creation on disk (agent announces before writing).
    /// Tuples of (absolute_path, deadline). Checked each chunk until file appears
    /// or 10s deadline expires. Already-emitted paths tracked for dedup.
    pending_planfiles: Vec<(String, std::time::Instant)>,
    /// Plan file paths already emitted — prevents re-emitting on spinner redraws.
    emitted_planfiles: std::collections::HashSet<String>,
    /// Plan file paths that exhausted their retry window without appearing on
    /// disk. Tombstoned so a still-on-screen reference (re-parsed every chunk)
    /// is not re-queued forever — that was a source of endless retry-log spam.
    gaveup_planfiles: std::collections::HashSet<String>,
    /// Tracks whether the terminal is in alternate screen buffer mode.
    /// Set on ESC[?1049h, cleared on ESC[?1049l.
    pub(crate) in_alt_buffer: bool,
    /// Structured terminal mode with nesting depth and app detection.
    terminal_mode: crate::ai_agent::tui_detect::TerminalMode,
    /// One-shot flag: inject ESC[2J before the next ESC[H cursor-home.
    /// Set on alt-buffer entry and when content may have shrunk (detected via
    /// cursor-up ESC[nA with n > previous). Consumed after inject fires.
    alt_buffer_needs_clear: bool,
    /// Tracks the largest cursor-up (ESC[nA) value seen since last clear.
    /// When a new ESC[nA arrives with n < last_cursor_up_n, content has shrunk
    /// and we need a clear to prevent ghost artifacts.
    last_cursor_up_n: u16,
    /// Last VtLogBuffer total_lines observed — used to detect growth and emit
    /// `pty-vt-log-total-{session_id}` for the scrollback overlay.
    last_vt_log_total: usize,
    /// Last VtLogBuffer oldest_offset observed — emit when buffer rotation
    /// advances oldest so the frontend can invalidate stale chunks proactively.
    last_vt_log_oldest: usize,
    /// Last time we emitted a `pty-vt-log-total-*` event. Throttled to ~100 ms
    /// to avoid flooding the frontend during heavy output.
    last_vt_log_emit: Option<std::time::Instant>,
    /// Command text captured on OSC 133 C — used when the matching D arrives
    /// to build a `CommandOutcome`. Cleared after D.
    pending_command: Option<String>,
    /// `Instant` when OSC 133 C arrived; used for `duration_ms`.
    pending_command_started: Option<std::time::Instant>,
    /// TUIC_SESSION UUID for this PTY — used to create flag files that
    /// signal the shell wrapper to stop injecting `--session-id`.
    tuic_session: Option<String>,
    /// Last time we created a no-session-inject flag file in response to
    /// an `AgentSessionConflict` event. Gates subsequent marks so a single
    /// burst of conflict output fires the mitigation exactly once.
    last_session_conflict_mark: Option<std::time::Instant>,
    /// Absolute buffer line of the last heuristic agent-block start.
    /// Used to emit AgentBlock end when the next block starts or agent exits.
    last_agent_block_line: Option<usize>,
    /// Edge-detect an "Action Required" OSC 0 title so a permission prompt fires
    /// the question notification exactly once (the title repaints every spinner
    /// tick). Agent-agnostic: any agent that puts "Action Required" in its title
    /// (grok, Codex, …) drives this. True while the last title signalled
    /// awaiting-approval.
    title_awaiting: bool,
}

impl ChunkProcessor {
    fn new(session_cwd: Option<String>, tuic_session: Option<String>) -> Self {
        Self {
            parser: OutputParser::new(),
            last_status_task: None,
            last_question_text: None,
            last_choice_prompt_sig: None,
            session_cwd,
            pending_planfiles: Vec::new(),
            emitted_planfiles: std::collections::HashSet::new(),
            gaveup_planfiles: std::collections::HashSet::new(),
            in_alt_buffer: false,
            terminal_mode: crate::ai_agent::tui_detect::TerminalMode::Shell,
            alt_buffer_needs_clear: false,
            last_cursor_up_n: 0,
            last_vt_log_total: 0,
            last_vt_log_oldest: 0,
            last_vt_log_emit: None,
            pending_command: None,
            pending_command_started: None,
            tuic_session,
            last_session_conflict_mark: None,
            last_agent_block_line: None,
            title_awaiting: false,
        }
    }

    /// Handle OSC 7770 `state=idle|busy` from the TUIC protocol.
    fn handle_tuic_state(&self, payload: &str, session_id: &str, state: &AppState) {
        let (target, label) = match payload {
            "idle" => (SHELL_IDLE, "idle"),
            "busy" => (SHELL_BUSY, "busy"),
            _ => return,
        };
        transition_explicit_shell_state(state, session_id, target, label, true);
    }

    /// Handle a single OSC 133 event from the VTE handler.
    /// On 'C' captures the command text; on 'D' builds a `CommandOutcome`.
    fn handle_osc133_event(
        &mut self,
        command: char,
        params: &str,
        session_id: &str,
        state: &AppState,
    ) {
        use crate::ai_agent::knowledge::{
            CommandOutcome, OutcomeClass, SessionKnowledge, classify_error,
        };

        // Deterministic state transitions from shell integration markers.
        // A = prompt shown (idle), C = command execution started (busy).
        // These bypass the silence timer entirely when OSC 133 is available.
        match command {
            'A' => {
                transition_explicit_shell_state(state, session_id, SHELL_IDLE, "idle", false);
            }
            'C' => {
                transition_explicit_shell_state(state, session_id, SHELL_BUSY, "busy", false);
                let cmd = state
                    .input_buffers
                    .get(session_id)
                    .map(|b| b.lock().content())
                    .unwrap_or_default();
                self.pending_command = Some(cmd);
                self.pending_command_started = Some(std::time::Instant::now());
            }
            'D' => {
                // A 'D' (command finished) with no preceding 'C' (command
                // started) means no command actually ran — e.g. Enter on an
                // empty prompt, where the shell still emits D carrying the
                // previous command's exit code. Recording it would create a
                // phantom outcome with an empty command and "unknown" error
                // type, polluting both the knowledge panel and the agent's
                // injected prompt. Skip it.
                if self.pending_command_started.is_none() {
                    self.pending_command = None;
                    return;
                }
                let exit_code = params.parse::<i32>().unwrap_or(0);
                let command = self.pending_command.take().unwrap_or_default();
                let duration_ms = self
                    .pending_command_started
                    .take()
                    .map(|t| t.elapsed().as_millis() as u64)
                    .unwrap_or(0);
                let cwd = self.session_cwd.clone().unwrap_or_default();
                let output_snippet = state
                    .vt_log_buffers
                    .get(session_id)
                    .map(|b| {
                        let buf = b.lock();
                        buf.screen_rows().join("\n")
                    })
                    .unwrap_or_default();
                let mut tail_start = output_snippet.len().saturating_sub(500);
                while tail_start > 0 && !output_snippet.is_char_boundary(tail_start) {
                    tail_start += 1;
                }
                let output_snippet = output_snippet[tail_start..].to_string();

                let classification = if exit_code == 0 {
                    OutcomeClass::Success
                } else if let Some(error_type) = classify_error(&output_snippet) {
                    OutcomeClass::Error { error_type }
                } else {
                    OutcomeClass::Error {
                        error_type: "unknown".into(),
                    }
                };

                let outcome = CommandOutcome {
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    command,
                    cwd,
                    exit_code: Some(exit_code),
                    output_snippet,
                    classification,
                    duration_ms,
                    id: 0,
                };
                {
                    let entry = state
                        .session_knowledge
                        .entry(session_id.to_string())
                        .or_insert_with(|| Mutex::new(SessionKnowledge::new()));
                    entry.lock().terminal_mode = self.terminal_mode.clone();
                }
                state.record_outcome(session_id, outcome);
            }
            _ => {}
        }
    }

    /// Colorize `intent:` tokens and apply alternate-buffer fixes on the xterm
    /// stream. Suggest tokens are NOT concealed here — the frontend's
    /// `eraseSuggestFromBuffer()` handles that via rAF after xterm renders.
    fn transform_xterm(&mut self, data: String) -> Option<String> {
        // Track alternate screen buffer state for the clear-before-home fix below.
        if data.contains("\x1b[?1049h") {
            self.in_alt_buffer = true;
            self.alt_buffer_needs_clear = true;
            self.terminal_mode = self.terminal_mode.on_alt_enter();
        } else if data.contains("\x1b[?1049l") {
            self.in_alt_buffer = false;
            self.alt_buffer_needs_clear = false;
            self.terminal_mode = self.terminal_mode.on_alt_exit();
        }

        // Detect render-height change in alternate buffer: when Ink's cursor-up
        // (ESC[nA) value changes, the chrome area may have shifted vertically.
        // Ink never sends ESC[K (erase to end of line), so rows that were chrome
        // in the previous render but aren't overwritten in the new one persist as
        // ghost artifacts — starting from the bottom and expanding upward.
        if self.in_alt_buffer
            && let Some(n) = extract_largest_cursor_up(&data)
        {
            if n != self.last_cursor_up_n && self.last_cursor_up_n > 0 {
                self.alt_buffer_needs_clear = true;
            }
            self.last_cursor_up_n = n;
        }

        // Inject ESC[2J (clear screen) before the first positioning sequence when
        // needed. Tries cursor-home (ESC[H) first, then falls back to cursor-up
        // (ESC[nA). Ink re-renders use cursor-up for repositioning, not cursor-home,
        // so the fallback is essential — without it the flag accumulates forever.
        let data = if self.alt_buffer_needs_clear {
            let injected = inject_clear_before_cursor_home(&data);
            if injected.len() != data.len() {
                self.alt_buffer_needs_clear = false;
                injected
            } else {
                let injected = inject_clear_before_cursor_up(&data);
                if injected.len() != data.len() {
                    self.alt_buffer_needs_clear = false;
                }
                injected
            }
        } else {
            data
        };

        if data.is_empty() {
            return Some(String::new());
        }

        Some(data)
    }

    /// Resolve a relative plan-file path to absolute using session CWD.
    /// Returns None if the path is relative and no CWD is available.
    fn resolve_planfile_path(&self, path: &str) -> Option<String> {
        if path.starts_with('/') {
            Some(path.to_string())
        } else if let Some(ref cwd) = self.session_cwd {
            let joined = std::path::PathBuf::from(cwd).join(path);
            Some(normalize_path(&joined).to_string_lossy().into_owned())
        } else {
            None
        }
    }

    /// Create a flag file that tells the shell wrapper to stop injecting
    /// `--session-id $TUIC_SESSION` into `claude` invocations. This is the
    /// safe alternative to writing `export TUIC_SESSION=…` into the PTY,
    /// which can corrupt fullscreen TUI output or race with user input.
    ///
    /// Guarded by a 3-second cooldown: Claude prints the error line multiple
    /// times as it exits, and we want exactly one flag per conflict burst.
    fn mark_session_no_inject(&mut self, kind: &str) {
        const COOLDOWN: std::time::Duration = std::time::Duration::from_secs(3);
        let now = std::time::Instant::now();
        if self
            .last_session_conflict_mark
            .is_some_and(|t| now.duration_since(t) < COOLDOWN)
        {
            return;
        }
        self.last_session_conflict_mark = Some(now);

        let Some(ref tuic_session) = self.tuic_session else {
            return;
        };

        let flag_path =
            crate::config::config_dir().join(format!("no-session-inject.{tuic_session}"));
        match std::fs::write(&flag_path, b"") {
            Ok(()) => {
                tracing::info!(
                    tuic_session = %tuic_session,
                    kind = %kind,
                    "Created no-session-inject flag after agent-session-conflict"
                );
            }
            Err(e) => {
                tracing::warn!(
                    tuic_session = %tuic_session,
                    error = %e,
                    "Failed to create no-session-inject flag"
                );
            }
        }
    }

    /// Drain pending plan files: emit event for files that now exist, drop expired ones.
    fn check_pending_planfiles(&mut self, session_id: &str, state: &AppState) {
        if self.pending_planfiles.is_empty() {
            return;
        }
        let now = std::time::Instant::now();
        let mut i = 0;
        while i < self.pending_planfiles.len() {
            let (ref path, deadline) = self.pending_planfiles[i];
            if now > deadline {
                tracing::debug!("[plan-file] Retry expired (10s), dropping: {path}");
                let path = self.pending_planfiles.swap_remove(i).0;
                // Tombstone so the still-visible reference isn't re-queued forever.
                self.gaveup_planfiles.insert(path);
                continue;
            }
            if std::path::Path::new(path).is_file() {
                let path = self.pending_planfiles.swap_remove(i).0;
                tracing::info!("[plan-file] Retry succeeded: {path}");
                self.emitted_planfiles.insert(path.clone());
                let evt = ParsedEvent::PlanFile { path };
                if let Ok(json) = serde_json::to_value(&evt) {
                    state.emit_pty_event(crate::state::AppEvent::PtyParsed {
                        session_id: session_id.to_string(),
                        parsed: json.clone(),
                    });
                    #[cfg(feature = "desktop")]
                    if let Some(a) = state.app_handle.read().as_ref() {
                        let _ = a.emit(
                            "pty-parsed",
                            serde_json::json!({
                                "session_id": session_id,
                                "parsed": json,
                            }),
                        );
                    }
                }
                continue;
            }
            i += 1;
        }
    }

    /// Process a chunk of PTY output after kitty-sequence stripping.
    /// Handles: VT log buffer, ring buffer, WebSocket broadcast, event parsing,
    /// dedup, resize-grace filtering, PlanFile resolution, event emission,
    /// silence state, last_output_ms, and shell state transitions.
    ///
    /// Returns the data string if non-empty (for callers that need to emit raw output to xterm).
    /// `app` is Some for desktop mode (emits Tauri IPC), None for headless.
    fn process_chunk(
        &mut self,
        data: &str,
        silence: &Arc<Mutex<SilenceState>>,
        session_id: &str,
        state: &AppState,
    ) -> Option<String> {
        if data.is_empty() {
            return None;
        }

        // Check pending plan files: emit if file appeared, drop if deadline expired.
        self.check_pending_planfiles(session_id, state);

        // Feed raw data (post-kitty-strip) into VT100 log buffer.
        // Also capture the post-process `total_lines` and `oldest_offset` so
        // we can emit a throttled growth/rotation event for the scrollback overlay.
        let (
            changed_rows,
            vt_log_total,
            vt_log_oldest,
            term_events,
            screen_cache,
            cursor_row,
            logical_prefix,
            physical_prefix,
            history_size,
        ): VtProcessResult = if let Some(vt_log) = state.vt_log_buffers.get(session_id) {
            let mut vt = vt_log.lock();
            let changed = vt.process(data.as_bytes());
            let total = vt.total_lines();
            let oldest = vt.oldest_offset();
            let hist = vt.grid_history_size();
            let tevts = vt.grid_drain_events();

            // Filter out changed rows below the input area border (horizontal rule).
            // Claude Code (and similar agents) render a quota/budget status bar below
            // the input box separator. Those rows are cosmetic chrome — processing them
            // resets the silence timer and causes false busy→idle→question transitions.
            //
            // Use screen_rows_ref() to avoid cloning prev_rows for the chrome cutoff
            // check. The owned snapshot is captured once below for slash-menu/choice-prompt
            // parsing that happens after the lock is released.
            let changed = if !changed.is_empty() {
                if let Some(screen) = vt.screen_rows_ref() {
                    let refs: Vec<&str> = screen.iter().map(|s| s.as_str()).collect();
                    if let Some(cutoff) = crate::chrome::find_chrome_cutoff(&refs) {
                        changed
                            .into_iter()
                            .filter(|r| r.row_index < cutoff)
                            .collect()
                    } else {
                        changed
                    }
                } else {
                    changed
                }
            } else {
                changed
            };

            // Single owned snapshot for downstream parsers (slash-menu, choice-prompt).
            let screen = vt.screen_rows();
            let cursor_row = vt.cursor_point().0;
            let logical_prefix = vt.logical_prefix_at_cursor();
            let physical_prefix = vt.physical_prefix_at_cursor();

            (
                changed,
                Some(total),
                Some(oldest),
                tevts,
                Some(screen),
                Some(cursor_row),
                logical_prefix,
                physical_prefix,
                hist,
            )
        } else {
            (
                Vec::new(),
                None,
                None,
                Vec::new(),
                None,
                None,
                None,
                None,
                0,
            )
        };

        // Did this chunk grow the scrollback (genuine new output) or merely
        // repaint existing rows (SIGWINCH reflow, cursor blink, statusline)?
        // Captured BEFORE `last_vt_log_total` is updated below. A pure reflow
        // never grows the buffer; real agent work scrolls in new lines.
        let vt_log_grew = vt_log_total
            .map(|t| t > self.last_vt_log_total)
            .unwrap_or(false);

        // Emit scrollback-overlay growth/rotation event (throttled to 100ms).
        // Frontend listens to `pty-vt-log-total-{session_id}` and updates
        // cache.total and cache.oldest for the scrollback overlay.
        if let Some(new_total) = vt_log_total
            && new_total > self.last_vt_log_total
        {
            let should_emit = self
                .last_vt_log_emit
                .map(|t| t.elapsed() >= std::time::Duration::from_millis(100))
                .unwrap_or(true);
            if should_emit {
                #[cfg(feature = "desktop")]
                if let Some(a) = state.app_handle.read().as_ref() {
                    let _ = a.emit(&format!("pty-vt-log-total-{session_id}"), new_total);
                }
                self.last_vt_log_emit = Some(std::time::Instant::now());
            }
            self.last_vt_log_total = new_total;
        }
        // Update oldest tracking (no event needed — frontend reads it on chunk fetch)
        if let Some(new_oldest) = vt_log_oldest {
            self.last_vt_log_oldest = new_oldest;
        }

        // Handle terminal events from alacritty (title, clipboard, PTY writes, OSC 133, TUIC)
        let mut tuic_events: Vec<ParsedEvent> = Vec::new();
        let mut explicit_idle_in_chunk = false;
        if !term_events.is_empty() {
            use crate::terminal_grid::{Osc133Event, TermEvent};
            for evt in term_events {
                match evt {
                    TermEvent::PtyWrite(response) => {
                        if response.contains("\x1b[?1049")
                            || response.contains("\x1b[?1047")
                            || response.contains("\x1b[?47l")
                            || response.contains("\x1b[?25h")
                        {
                            tracing::error!(source = "terminal", session_id = %session_id,
                                "PtyWrite contains DEC private mode sequences! response={:?}",
                                response.as_bytes().iter().take(200).collect::<Vec<_>>());
                        }
                        if let Some(sess) = state.sessions.get(session_id)
                            && let Some(mut s) = sess.try_lock()
                        {
                            if let Err(e) = s.writer.write_all(response.as_bytes()) {
                                tracing::warn!(source = "terminal", session_id = %session_id, "PtyWrite response failed: {e}");
                            }
                            if let Err(e) = s.writer.flush() {
                                tracing::warn!(source = "terminal", session_id = %session_id, "PtyWrite flush failed: {e}");
                            }
                        }
                    }
                    TermEvent::Title(title) => {
                        #[cfg(feature = "desktop")]
                        if let Some(a) = state.app_handle.read().as_ref() {
                            let _ = a.emit(&format!("pty-title-{session_id}"), &title);
                        }
                        // Some agents signal an awaiting-approval permission prompt by
                        // putting "Action Required" in their OSC 0 title (grok prefixes
                        // "⚠ Action Required - ⠙ - Running: echo … - Execute Shell …";
                        // Codex uses "[ . ] Action Required | …"). Agent-agnostic: any
                        // such title drives this. The title repaints every spinner tick,
                        // so edge-detect the false→true transition and fire the question
                        // exactly once.
                        // DEFERRED (2026-06-11) — grok 0.2.45 in always-approve mode
                        // emits titles like "Run Shell Command echo … - grok" with NO
                        // "Action Required" prefix (verified live). The prefix may be
                        // version/permission-mode specific; the on-screen "◆ …?" prompt
                        // (cliclack path in output_parser) covers real approvals. Re-verify
                        // grok's title in default (non-always-approve) mode before removing.
                        let title_awaiting = title.contains("Action Required");
                        if title_awaiting && !self.title_awaiting {
                            tuic_events.push(ParsedEvent::Question {
                                prompt_text: clean_action_required_title(&title),
                                confident: true,
                            });
                        }
                        self.title_awaiting = title_awaiting;
                    }
                    TermEvent::ResetTitle => {
                        #[cfg(feature = "desktop")]
                        if let Some(a) = state.app_handle.read().as_ref() {
                            let _ = a.emit(&format!("pty-title-{session_id}"), "");
                        }
                        self.title_awaiting = false;
                    }
                    TermEvent::ClipboardStore(text) => {
                        #[cfg(feature = "desktop")]
                        if let Some(a) = state.app_handle.read().as_ref() {
                            let _ = a.emit(&format!("pty-clipboard-store-{session_id}"), &text);
                        }
                    }
                    TermEvent::Osc133 {
                        command,
                        params,
                        line,
                    } => {
                        explicit_idle_in_chunk |= command == 'A';
                        state
                            .has_osc133_integration
                            .insert(session_id.to_string(), ());
                        self.handle_osc133_event(command, &params, session_id, state);
                        #[cfg(feature = "desktop")]
                        if let Some(a) = state.app_handle.read().as_ref() {
                            let _ = a.emit(
                                &format!("pty-osc133-{session_id}"),
                                &Osc133Event {
                                    marker: command.to_string(),
                                    line,
                                    exit_code: parse_osc133_exit_code(command, &params),
                                },
                            );
                        }
                    }
                    TermEvent::Osc7(url) =>
                    {
                        #[allow(clippy::collapsible_if)]
                        if let Ok(cwd) = parse_osc7_cwd(&url) {
                            if let Some(entry) = state.sessions.get(session_id) {
                                entry.lock().cwd = Some(cwd.clone());
                            }
                            #[cfg(feature = "desktop")]
                            if let Some(a) = state.app_handle.read().as_ref() {
                                let _ = a.emit(&format!("pty-cwd-{session_id}"), &cwd);
                            }
                        }
                    }
                    TermEvent::Tuic {
                        verb,
                        payload,
                        line,
                    } => match verb.as_str() {
                        "state" => {
                            // idle/busy drive the shell-state machine; awaiting is
                            // ignored here (it's a separate field). The awaiting_input
                            // field is driven by Question/UserInput events instead.
                            explicit_idle_in_chunk |= payload == "idle";
                            self.handle_tuic_state(&payload, session_id, state);
                            if let Some(evt) = tuic_state_awaiting_event(&payload, line as i64) {
                                tuic_events.push(evt);
                            }
                        }
                        "suggest" => {
                            // Tolerate an optional `[ … ]` wrapper so this OSC
                            // channel accepts the same payload as the text token
                            // (`suggest: [ A | B | C ]`).
                            let inner = payload.trim();
                            let inner = inner.strip_prefix('[').unwrap_or(inner);
                            let inner = inner.strip_suffix(']').unwrap_or(inner);
                            let items: Vec<String> = inner
                                .split('|')
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .collect();
                            if !items.is_empty() {
                                tuic_events.push(ParsedEvent::Suggest { items });
                            }
                        }
                        "intent" => {
                            let (text, title) = if let Some(paren_start) = payload.rfind('(') {
                                let desc = payload[..paren_start].trim().to_string();
                                let t = payload[paren_start + 1..]
                                    .trim_end_matches(')')
                                    .trim()
                                    .to_string();
                                (desc, if t.is_empty() { None } else { Some(t) })
                            } else {
                                (payload.clone(), None)
                            };
                            tuic_events.push(ParsedEvent::Intent { text, title });
                        }
                        "block" => {
                            let (action, exit_code) =
                                if let Some(rest) = payload.strip_prefix("end;") {
                                    ("end".to_string(), rest.parse::<i32>().ok())
                                } else {
                                    (payload.clone(), None)
                                };
                            if action == "start" || action == "end" {
                                tuic_events.push(ParsedEvent::AgentBlock {
                                    action,
                                    line: line as i64,
                                    exit_code,
                                });
                            }
                        }
                        _ => {}
                    },
                    TermEvent::MouseCursorDirty | TermEvent::CursorBlinkingChange => {}
                }
            }
        }

        // Write to ring buffer and broadcast to WebSocket clients while
        // holding the ring lock. Serializing these two steps prevents a race
        // with WS catch-up: a newly-connecting handler that also takes
        // ring.lock() for its snapshot cannot observe a state where the byte
        // is in the ring but also still queued for live delivery, which
        // would cause the catch-up and the live stream to replay the same
        // bytes to the client.
        if let Some(ring) = state.output_buffers.get(session_id) {
            let mut ring_guard = ring.lock();
            ring_guard.write(data.as_bytes());
            if let Some(mut clients) = state.ws_clients.get_mut(session_id) {
                let owned = data.to_owned();
                clients.retain(|tx| tx.send(owned.clone()).is_ok());
            }
            drop(ring_guard);
        }

        // Parse events: OSC 9;4 progress from raw stream, others from clean rows.
        let (in_resize_grace, in_startup_grace) = {
            let sl = silence.lock();
            (sl.is_resize_grace(), sl.is_startup_grace())
        };
        let suppress_notifications = in_resize_grace || in_startup_grace;
        let mut events = tuic_events;
        // Hook-instrumented sessions get awaiting from OSC 7770; drop heuristic
        // (regex) Question events from the parser so they don't double-fire.
        let hook_instrumented = state
            .session_states
            .get(session_id)
            .map(|s| s.hook_instrumented)
            .unwrap_or(false)
            && silence.lock().hook_state_seen;
        if let Some(evt) = crate::output_parser::parse_osc94(data) {
            events.push(evt);
        }
        let agent_active_for_parse = state
            .session_states
            .get(session_id)
            .map(|s| s.agent_type.is_some())
            .unwrap_or(false);
        // Cursor-completeness guard: parse a suggest token from the bounded grid
        // prefix through the cursor, never from stale cells to its right. When a
        // soft-wrapped continuation changes in a later chunk, replace its whole
        // physical range with one synthetic logical row so the unchanged anchor
        // remains available to the existing parser. Intent deferral is unchanged.
        let mut structured_rows = None;
        let structured_prefix = logical_prefix
            .filter(|prefix| crate::output_parser::structured_token_anchor(&prefix.text).is_some())
            .or_else(|| {
                physical_prefix.filter(|prefix| {
                    self.parser
                        .is_complete_suggest(&prefix.text, agent_active_for_parse)
                })
            });
        if let Some(prefix) = structured_prefix {
            let intersects = changed_rows
                .iter()
                .any(|row| (prefix.start_row..=prefix.end_row).contains(&row.row_index));
            if intersects
                && let Some(anchor) = crate::output_parser::structured_token_anchor(&prefix.text)
            {
                let complete_suggest = anchor
                    == crate::output_parser::StructuredTokenAnchor::Suggest
                    && self
                        .parser
                        .is_complete_suggest(&prefix.text, agent_active_for_parse);
                let mut rows: Vec<_> = changed_rows
                    .iter()
                    .filter(|row| !(prefix.start_row..=prefix.end_row).contains(&row.row_index))
                    .cloned()
                    .collect();
                if complete_suggest {
                    rows.push(crate::state::ChangedRow {
                        row_index: prefix.start_row,
                        text: prefix.text,
                    });
                    rows.sort_by_key(|row| row.row_index);
                }
                structured_rows = Some(rows);
            }
        } else if let Some(cursor_row) = cursor_row
            && changed_rows.iter().any(|row| {
                row.row_index == cursor_row
                    && crate::output_parser::structured_token_anchor(&row.text).is_some()
            })
        {
            structured_rows = Some(
                changed_rows
                    .iter()
                    .filter(|row| row.row_index != cursor_row)
                    .cloned()
                    .collect(),
            );
        }
        let rows = structured_rows.as_deref().unwrap_or(&changed_rows);
        events.extend(
            self.parser
                .parse_clean_lines(rows, agent_active_for_parse)
                .into_iter()
                .filter(|e| !suppress_heuristic_question(hook_instrumented, e)),
        );

        // Heuristic agent-block detection for Claude Code tool calls.
        // CC renders tool calls as `⏺ ToolName(args)` — detect these and
        // synthesize AgentBlock start/end events so the block system works
        // without CC emitting OSC 7770;block= sequences.
        if !agent_active_for_parse && let Some(prev) = self.last_agent_block_line.take() {
            events.push(ParsedEvent::AgentBlock {
                action: "end".into(),
                line: prev as i64,
                exit_code: None,
            });
        }
        if agent_active_for_parse {
            for row in &changed_rows {
                if is_cc_tool_call_header(&row.text) {
                    let abs_line = history_size + row.row_index;
                    if Some(abs_line) == self.last_agent_block_line {
                        continue;
                    }
                    if let Some(prev) = self.last_agent_block_line {
                        events.push(ParsedEvent::AgentBlock {
                            action: "end".into(),
                            line: prev as i64,
                            exit_code: None,
                        });
                    }
                    events.push(ParsedEvent::AgentBlock {
                        action: "start".into(),
                        line: abs_line as i64,
                        exit_code: None,
                    });
                    self.last_agent_block_line = Some(abs_line);
                }
            }
        }

        // screen_cache was computed once inside the vt_log lock scope above.

        // Slash menu detection — use full screen rows (not chrome-trimmed).
        // Claude Code v2.1+ renders autocomplete items BELOW the prompt chrome,
        // so trimming to above-chrome would discard the menu. parse_slash_menu
        // scans bottom-up, skips empty rows, and stops at the first non-matching
        // row (separator/chrome), so it safely finds items regardless of position.
        let slash_on = state
            .slash_mode
            .get(session_id)
            .is_some_and(|v| v.load(std::sync::atomic::Ordering::Relaxed));
        if slash_on && let Some(screen) = &screen_cache {
            let menu = crate::output_parser::parse_slash_menu(screen);
            tracing::debug!(
                "slash_menu parse: sid={session_id} found={} rows={}",
                menu.is_some(),
                screen.len()
            );
            if let Some(evt) = menu {
                events.push(evt);
            }
        }

        // ChoicePrompt detection — numbered confirmation dialogs rendered below
        // the prompt line (edit-confirm, bash-confirm, apply-patch). Runs on
        // every chunk (unlike slash_menu which is gated by slash_mode) because
        // these dialogs appear asynchronously when the agent requests input.
        // Parser uses a strict shape (title with ?/verb + ≥2 numbered options)
        // so false-positive cost is low. Dedup via last_choice_prompt_sig
        // guards against repaint re-emission.
        if let Some(screen) = &screen_cache
            && let Some(evt) = crate::output_parser::parse_choice_prompt(screen)
        {
            events.push(evt);
        }

        let regex_found_question = if suppress_notifications {
            false
        } else {
            events
                .iter()
                .any(|e| matches!(e, ParsedEvent::Question { .. }))
        };

        // Emit events with dedup, grace filtering, and PlanFile resolution.
        for event in &events {
            // During startup/resize grace, suppress low-confidence notifications to
            // avoid boot-noise false positives — but let CONFIDENT questions through.
            // An agent can signal an approval prompt via its "Action Required" title
            // (confident), yet its continuous animation keeps resetting last_output,
            // so the startup grace never settles by silence and would otherwise
            // suppress the approval prompt for the full 120s safety cap.
            let suppress_this = suppress_notifications
                && match event {
                    ParsedEvent::Question { confident, .. } => !*confident,
                    ParsedEvent::RateLimit { .. } | ParsedEvent::ApiError { .. } => true,
                    _ => false,
                };
            if suppress_this {
                continue;
            }

            if let ParsedEvent::AgentSessionConflict { kind, .. } = event
                && matches!(
                    self.terminal_mode,
                    crate::ai_agent::tui_detect::TerminalMode::Shell
                )
            {
                self.mark_session_no_inject(kind);
                continue;
            }

            // Suggest: park in SilenceState and defer emission until silence
            // confirms the turn has ended. The frontend used to buffer these
            // events in `pendingSuggest` to compensate for suggest arriving
            // before `shell-state: idle`; gating the emission backend-side
            // removes the race and simplifies the Terminal event handler.
            if let ParsedEvent::Suggest { items } = event {
                let mut silence_state = silence.lock();
                let turn_epoch = state
                    .session_states
                    .get(session_id)
                    .map(|session| session.turn_epoch)
                    .unwrap_or(0);
                silence_state.mark_suggest_candidate(items.clone(), turn_epoch);
                continue;
            }

            // Dedup status-line: skip if task_name hasn't changed
            if let ParsedEvent::StatusLine { task_name, .. } = event {
                if self.last_status_task.as_deref() == Some(task_name.as_str()) {
                    continue;
                }
                self.last_status_task = Some(task_name.clone());
            }

            // Dedup question: skip if same prompt_text already emitted.
            if let ParsedEvent::Question { prompt_text, .. } = event {
                if self.last_question_text.as_deref() == Some(prompt_text.as_str()) {
                    continue;
                }
                self.last_question_text = Some(prompt_text.clone());
            }

            // Dedup choice-prompt: skip if same (title + option keys) already emitted.
            // Signature keeps option order but ignores highlighted drift so cursor
            // movement within the dialog doesn't re-fire.
            if let ParsedEvent::ChoicePrompt { title, options, .. } = event {
                let sig = format!(
                    "{}|{}",
                    title,
                    options
                        .iter()
                        .map(|o| o.key.as_str())
                        .collect::<Vec<_>>()
                        .join(","),
                );
                if self.last_choice_prompt_sig.as_deref() == Some(sig.as_str()) {
                    continue;
                }
                self.last_choice_prompt_sig = Some(sig);
            }

            // Resolve relative plan-file paths to absolute using session CWD.
            // If the file doesn't exist yet (agent announces before writing),
            // queue it for retry — checked each chunk for up to 10 seconds.
            let resolved = if let ParsedEvent::PlanFile { path } = event {
                match self.resolve_planfile_path(path) {
                    Some(p)
                        if self.emitted_planfiles.contains(&p)
                            || self.gaveup_planfiles.contains(&p) =>
                    {
                        // Already emitted, or it exhausted its retry window — skip
                        // (spinner redraws re-parse the same on-screen line).
                        continue;
                    }
                    Some(p) if std::path::Path::new(&p).is_file() => {
                        tracing::info!("[plan-file] Detected: {p} (cwd={:?})", self.session_cwd);
                        self.emitted_planfiles.insert(p.clone());
                        Some(ParsedEvent::PlanFile { path: p })
                    }
                    Some(p) => {
                        // File not on disk yet — queue for retry if not already pending
                        if !self.pending_planfiles.iter().any(|(pp, _)| pp == &p) {
                            tracing::debug!(
                                "[plan-file] Queued for retry: {p} (cwd={:?})",
                                self.session_cwd
                            );
                            let deadline =
                                std::time::Instant::now() + std::time::Duration::from_secs(10);
                            self.pending_planfiles.push((p, deadline));
                        }
                        continue;
                    }
                    None => {
                        tracing::warn!(
                            "[plan-file] Cannot resolve relative path: {path} (cwd={:?})",
                            self.session_cwd
                        );
                        continue;
                    }
                }
            } else {
                None
            };

            let emit_event = resolved.as_ref().unwrap_or(event);

            // Serialize once, reuse for both broadcast and Tauri IPC
            if let Ok(json) = serde_json::to_value(emit_event) {
                #[cfg(feature = "desktop")]
                if let Some(app) = state.app_handle.read().as_ref() {
                    let _ = app.emit(&format!("pty-parsed-{session_id}"), &json);
                }
                state.emit_pty_event(crate::state::AppEvent::PtyParsed {
                    session_id: session_id.to_string(),
                    parsed: json,
                });
            }
        }

        // Update silence state for fallback question detection.
        let has_status_line = events
            .iter()
            .any(|e| matches!(e, ParsedEvent::StatusLine { .. }));
        let last_q_line = extract_question_line(&changed_rows);
        // A chunk is chrome-only when no real output reached the screen.
        // Path 0: changed_rows is empty — nothing visible happened (cursor
        //   blink, OSC title update, mouse report, SGR-only sequence). Must
        //   count as chrome-only or these periodic re-emits latch the shell
        //   state to busy forever during genuine idle.
        // Path 1: every row has a chrome marker (is_chrome_row).
        // Path 2: parse_status_line detected a spinner pattern (Gemini braille,
        //   Aider Knight Rider) AND no row contains real agent output. A row is
        //   "real output" if it is not chrome and not blank — this prevents
        //   has_status_line from suppressing chunks that mix spinner + output.
        let all_chrome_markers = changed_rows.iter().all(|r| is_chrome_row(&r.text));
        let has_suggest = events
            .iter()
            .any(|e| matches!(e, ParsedEvent::Suggest { .. }))
            || rows.iter().any(|row| {
                self.parser
                    .is_complete_suggest(&row.text, agent_active_for_parse)
            });
        let no_real_output = changed_rows.iter().all(|r| {
            is_chrome_row(&r.text)
                || r.text.trim().is_empty()
                || crate::chrome::is_separator_line(&r.text)
                || crate::chrome::is_prompt_line(&r.text)
                // Suggest tokens are protocol markers, not real agent output.
                // Without this, a visible suggest row makes the chunk look like
                // "real output" and increments the question staleness counter.
                || (has_suggest && is_suggest_row(&r.text))
        });
        let chrome_only = !regex_found_question
            && last_q_line.is_none()
            && (changed_rows.is_empty()
                || all_chrome_markers
                || ((has_status_line || has_suggest) && no_real_output));
        // Suggest-only: chunk produced only Suggest events (no real text).
        let suggest_only = has_suggest
            && !regex_found_question
            && last_q_line.is_none()
            && !has_status_line
            && no_real_output;
        {
            let mut sl = silence.lock();
            sl.on_chunk(
                regex_found_question,
                last_q_line,
                has_status_line,
                chrome_only,
                suggest_only,
            );

            // Tool-error detection: scan visible rows for `Error: Exit code N`
            // emitted by Claude Code / Codex at the end of a failing tool call.
            // Fires playError() via silence_timer when followed only by chrome
            // until SILENCE_TOOL_ERROR_THRESHOLD elapses (= turn ended on error).
            let mut error_line: Option<String> = None;
            let mut retry_seen = false;
            for row in changed_rows.iter() {
                if is_retry_line(&row.text) {
                    retry_seen = true;
                } else if is_tool_error_line(&row.text) {
                    error_line = Some(row.text.trim().to_string());
                }
            }
            if retry_seen {
                // Agent is auto-retrying a failed API call — hold BUSY across the
                // frozen gap between attempts. Takes precedence over the recovery
                // clear below: the retry line IS real output but is not recovery.
                sl.mark_api_retry();
            } else if let Some(line) = error_line {
                sl.mark_tool_error_candidate(line);
            } else if !chrome_only {
                // Real output without an error/retry line → agent recovered/continued.
                sl.clear_tool_error_on_recovery();
            }
        }

        // Screen activity is evaluated on the full, unfiltered snapshot. The
        // generic chrome cutoff is a presentation/logging boundary and must not
        // erase agent-specific liveness evidence (Codex tool separators are the
        // canonical counterexample).
        let agent_type = state
            .session_states
            .get(session_id)
            .and_then(|s| s.agent_type.clone());
        let screen_activity = screen_cache
            .as_ref()
            .map(|rows| detect_agent_screen_activity(agent_type.as_deref(), rows))
            .unwrap_or(AgentScreenActivity::Unknown);
        if screen_activity == AgentScreenActivity::Working && !explicit_idle_in_chunk {
            apply_working_evidence(state, silence, session_id, now_epoch_ms(), "working-screen");
        }

        // Stamp last_output_ms for real output and for active spinner repaints.
        // Spinner rows (dingbats ✻, braille ⠋, Aider ░█) prove the agent is
        // alive even though they are chrome-only — keeping the timestamp fresh
        // prevents should_transition_idle from firing mid-think.
        //
        // Spinner detection runs on the SAME post-cutoff `changed_rows` as
        // everything else. Real spinners (Gemini braille, Aider Knight Rider,
        // Claude `✻ Thinking…`) all render ABOVE the input separator and LEAD
        // their row, so they survive the chrome cutoff and still keep the agent
        // alive here. A status-line HUD's `█░` progress bar or a `·`-bearing
        // footer is NOT a spinner (`is_spinner_row` requires the glyph to lead
        // the line, #446-596f), so it can never keep a session busy even if it
        // renders above the cutoff.
        let has_spinner = chrome_only
            && changed_rows
                .iter()
                .any(|r| crate::chrome::is_spinner_row(&r.text));
        if (!chrome_only || has_spinner) && !explicit_idle_in_chunk {
            {
                let mut sl = silence.lock();
                if has_spinner {
                    sl.note_working_screen();
                } else {
                    sl.note_real_activity();
                }
                invalidate_background_probe_boundary_locked(state, session_id);
            }
            stamp_last_output_now(state, session_id, now_epoch_ms());
        }

        // Suggest dedup is intentionally not reset on submission: the previous
        // marker may repaint while still visible. Once this turn has real
        // working evidence, however, an identical terminal marker is a valid
        // new completion. Update the parser after this chunk was parsed so a
        // stale marker repainted alongside the first activity remains ignored.
        if !explicit_idle_in_chunk
            && (screen_activity == AgentScreenActivity::Working || !chrome_only || has_spinner)
            && let Some(turn_epoch) = state
                .session_states
                .get(session_id)
                .map(|session| session.turn_epoch)
        {
            self.parser.begin_suggest_working_turn(turn_epoch);
        }

        // SIGWINCH reflow repaints content rows for longer than the initial 1s
        // resize grace, but a reflow never grows the buffer — it only repaints
        // existing rows. While such pure-repaint chunks keep arriving within the
        // grace window, re-arm the grace so a resize never flips an idle agent to
        // busy. A growing chunk (genuine new output) is NOT extended, so real work
        // started right after a resize still registers as busy. An already-busy
        // session is unaffected (idle transitions are silence-timer only).
        if !vt_log_grew {
            let mut sl = silence.lock();
            if sl.is_resize_grace() {
                sl.on_resize();
            }
        }

        // Shell state: reader transitions → BUSY on real output OR active spinner.
        // Idle transitions are handled exclusively by the silence timer to
        // eliminate the two-path race that caused 15+ fix/revert cycles.
        // Load `prev` and drop the shell_states Ref before try_shell_transition (which
        // re-gets the same key): holding a Ref across that second get risks the CONC-C
        // re-entrant-read deadlock (story 099-6526).
        let prev = if (!chrome_only || has_spinner)
            && !explicit_idle_in_chunk
            && !silence.lock().is_resize_grace()
        {
            state
                .shell_states
                .get(session_id)
                .map(|atom| atom.load(std::sync::atomic::Ordering::Acquire))
        } else {
            None
        };
        if let Some(prev) = prev
            && prev != SHELL_BUSY
            && try_shell_transition(state, session_id, prev, SHELL_BUSY, true)
        {
            emit_shell_state(state, session_id, "busy");
        }

        // Update terminal mode in SessionState when it changes.
        // Detect TUI app from visible screen rows while in alternate buffer.
        if self.terminal_mode.is_fullscreen() {
            let row_texts: Vec<&str> = changed_rows.iter().map(|r| r.text.as_str()).collect();
            if let Some(app) = crate::ai_agent::tui_detect::detect_app_from_rows(&row_texts) {
                self.terminal_mode = self.terminal_mode.with_app_hint(app.to_string());
            }
        }
        if let Some(mut entry) = state.session_states.get_mut(session_id) {
            let new_mode = if self.terminal_mode.is_fullscreen() {
                Some(self.terminal_mode.clone())
            } else {
                None
            };
            if entry.terminal_mode != new_mode {
                entry.terminal_mode = new_mode;
            }
        }

        Some(data.to_owned())
    }
}

/// Process kitty keyboard actions (push/pop/query) shared by both reader threads.
fn process_kitty_actions(kitty_actions: &[KittyAction], session_id: &str, state: &AppState) {
    if kitty_actions.is_empty() {
        return;
    }
    let entry = state
        .kitty_states
        .entry(session_id.to_string())
        .or_insert_with(|| Mutex::new(KittyKeyboardState::new()));
    let mut ks = entry.lock();
    for action in kitty_actions {
        match action {
            KittyAction::Push(flags) => ks.push(*flags),
            KittyAction::Pop => ks.pop(),
            KittyAction::Query => {
                let flags = ks.current_flags();
                let response = format!("\x1b[?{}u", flags);
                // try_lock: MUST NOT block the reader thread — blocking here
                // while write_pty holds the lock causes a circular deadlock
                // (reader blocked → kernel buffer fills → write_pty blocks on write).
                if let Some(sess) = state.sessions.get(session_id) {
                    if let Some(mut s) = sess.try_lock() {
                        if let Err(e) = s.writer.write_all(response.as_bytes()) {
                            tracing::warn!(source = "terminal", session_id = %session_id, "kitty query write failed: {e}");
                        }
                        if let Err(e) = s.writer.flush() {
                            tracing::warn!(source = "terminal", session_id = %session_id, "kitty query flush failed: {e}");
                        }
                    } else {
                        tracing::warn!(source = "terminal", session_id = %session_id,
                            "kitty query response dropped — session lock contended; agent input handling may degrade");
                    }
                }
            }
        }
    }
    let flags = ks.current_flags();
    drop(ks);
    #[cfg(feature = "desktop")]
    if let Some(app) = state.app_handle.read().as_ref() {
        let _ = app.emit(&format!("kitty-keyboard-{session_id}"), flags);
    }
}

/// Flush remaining bytes at EOF and write to ring buffer + WebSocket.
/// Returns the flushed data (may be empty).
fn flush_eof(
    utf8_buf: &mut Utf8ReadBuffer,
    esc_buf: &mut EscapeAwareBuffer,
    session_id: &str,
    state: &AppState,
) -> String {
    let utf8_tail = utf8_buf.flush();
    let esc_remaining = if utf8_tail.is_empty() {
        esc_buf.flush()
    } else {
        let mut flushed = esc_buf.push(&utf8_tail);
        flushed.push_str(&esc_buf.flush());
        flushed
    };
    if !esc_remaining.is_empty()
        && let Some(ring) = state.output_buffers.get(session_id)
    {
        let mut ring_guard = ring.lock();
        ring_guard.write(esc_remaining.as_bytes());
        if let Some(mut clients) = state.ws_clients.get_mut(session_id) {
            clients.retain(|tx| tx.send(esc_remaining.clone()).is_ok());
        }
        drop(ring_guard);
    }
    esc_remaining
}

/// Fully remove session state from all DashMaps.
/// Called on explicit close/kill — caller has already consumed any output they need.
pub(crate) fn cleanup_session(session_id: &str, state: &AppState) {
    if state.sessions.remove(session_id).is_some() {
        state
            .metrics
            .active_sessions
            .fetch_sub(1, Ordering::Relaxed);
    }
    state.output_buffers.remove(session_id);
    state.vt_log_buffers.remove(session_id);
    state.pty_raw_rings.remove(session_id);
    #[cfg(feature = "desktop")]
    state.grid_channels.remove(session_id);
    state.grid_watch.remove(session_id);
    state.grid_frame_in_flight.remove(session_id);
    state.pending_scroll.remove(session_id);
    state.ws_clients.remove(session_id);
    // Drop the per-session PTY event channel alongside ws_clients. Any final
    // SessionClosed already emitted stays buffered for live subscribers (broadcast
    // drains buffered messages before signalling Closed), so no close frame is lost.
    state.pty_event_channels.remove(session_id);
    state.kitty_states.remove(session_id);
    state.input_buffers.remove(session_id);
    state.silence_states.remove(session_id);
    state.shell_states.remove(session_id);
    state.last_output_ms.remove(session_id);
    state.last_prompts.remove(session_id);
    state.terminal_rows.remove(session_id);
    state.resize_locks.remove(session_id);
    state.exit_codes.remove(session_id);
    state.term_aliases.remove(session_id);
}

/// Reap transient per-session state that has no post-mortem value, and stamp
/// `last_output_ms` so the tombstone sweeper can age the entry out.
/// Intentionally keeps: `output_buffers`, `vt_log_buffers`, `last_output_ms`, `exit_codes`.
fn tombstone_transient_cleanup(session_id: &str, state: &AppState) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    state
        .last_output_ms
        .entry(session_id.to_string())
        .or_insert_with(|| AtomicU64::new(0))
        .store(now_ms, Ordering::Relaxed);
    state.ws_clients.remove(session_id);
    // Drop the per-session PTY event channel alongside ws_clients. Any final
    // SessionClosed already emitted stays buffered for live subscribers (broadcast
    // drains buffered messages before signalling Closed), so no close frame is lost.
    state.pty_event_channels.remove(session_id);
    #[cfg(feature = "desktop")]
    state.grid_channels.remove(session_id);
    state.grid_watch.remove(session_id);
    state.grid_frame_in_flight.remove(session_id);
    state.pending_scroll.remove(session_id);
    state.kitty_states.remove(session_id);
    state.input_buffers.remove(session_id);
    state.silence_states.remove(session_id);
    state.shell_states.remove(session_id);
    state.last_prompts.remove(session_id);
    state.terminal_rows.remove(session_id);
    state.resize_locks.remove(session_id);
    // Swarm maps — inserted at spawn/register time, must be cleaned on exit.
    state.shell_state_since_ms.remove(session_id);
    state.pending_injections.remove(session_id);
    state.pending_initial_prompts.remove(session_id);
    state.active_agent_waiters.remove(session_id);
    state.peer_agents.remove(session_id);
    state.agent_inbox.remove(session_id);
    state.agent_inbox_evictions.remove(session_id);
    #[cfg(unix)]
    state.standby_sessions.remove(session_id);
    state.session_parent.remove(session_id);
    // mcp_to_session maps mcp_session_id → tuic_session. The reverse index
    // session_to_mcp lets us drop O(k) entries (k = mcp sessions for this
    // tuic_session, typically 1) instead of scanning every entry.
    if let Some((_, mcp_sids)) = state.session_to_mcp.remove(session_id) {
        for sid in &mcp_sids {
            state.mcp_to_session.remove(sid);
        }
    }
}

struct ParentLifecycleDispatch {
    parent_id: String,
    message_id: String,
    framed: String,
}

type VtProcessResult = (
    Vec<crate::state::ChangedRow>,
    Option<usize>,
    Option<usize>,
    Vec<crate::terminal_grid::TermEvent>,
    Option<Vec<String>>,
    Option<usize>,
    Option<crate::terminal_grid::LogicalPrefix>,
    Option<crate::terminal_grid::LogicalPrefix>,
    usize,
);

/// Enqueue the authoritative parent lifecycle message without touching the
/// parent's PTY lifecycle lock. BUSY→IDLE and completed paths call this while
/// holding the child's SilenceState transaction lock.
fn enqueue_state_change_to_parent(
    state: &AppState,
    session_id: &str,
    payload: serde_json::Value,
) -> Option<ParentLifecycleDispatch> {
    let parent_id = state
        .session_parent
        .get(session_id)
        .map(|e| e.value().clone())?;
    if parent_id == session_id {
        return None;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let msg = crate::state::AgentMessage {
        id: format!("tuic-auto-{}-{}", session_id, now_ms),
        from_tuic_session: session_id.to_string(),
        from_name: "tuic".to_string(),
        content: serde_json::to_string(&payload).unwrap_or_default(),
        timestamp: now_ms,
        delivered_via_channel: false,
    };
    let message_id = msg.id.clone();
    state.push_agent_inbox(&parent_id, msg);
    if state.assign_agent_delivery(
        &parent_id,
        &message_id,
        state.sessions.contains_key(&parent_id),
    ) != crate::state::AgentDeliveryAssignment::Terminal
    {
        return None;
    }
    let state_desc = payload
        .get("state")
        .and_then(|s| s.as_str())
        .unwrap_or("changed");
    let framed = match payload.get("exit_code").and_then(|c| c.as_i64()) {
        Some(code) => format!(
            "[TUIC] child agent {} {} (exit {})",
            short_session(session_id),
            state_desc,
            code
        ),
        None => format!(
            "[TUIC] child agent {} is now {}",
            short_session(session_id),
            state_desc
        ),
    };
    Some(ParentLifecycleDispatch {
        parent_id,
        message_id,
        framed,
    })
}

/// Wake/dispatch only after the child lifecycle lock has been released. This
/// may acquire the parent's SilenceState lock through terminal delivery.
fn dispatch_parent_lifecycle(state: &AppState, dispatch: ParentLifecycleDispatch) {
    if deliver_message_to_managed_pty(state, &dispatch.parent_id, &dispatch.framed) {
        state.mark_terminal_delivery_dispatched(&dispatch.parent_id, &dispatch.message_id);
    } else {
        state.release_terminal_delivery(&dispatch.parent_id, &dispatch.message_id);
    }
}

/// Push a state_change message and wake the parent when no child lifecycle
/// transaction is active (for example, process exit and direct test helpers).
fn push_state_change_to_parent(state: &AppState, session_id: &str, payload: serde_json::Value) {
    if let Some(dispatch) = enqueue_state_change_to_parent(state, session_id, payload) {
        dispatch_parent_lifecycle(state, dispatch);
    }
}

/// Emit the single exceptional-path notification for an initial prompt that
/// never completed PTY submission. Removing the marker first makes the
/// operation idempotent: a watchdog can fire at most once per spawned child.
pub(crate) fn notify_initial_prompt_timeout_if_pending(state: &AppState, session_id: &str) -> bool {
    if state.pending_initial_prompts.remove(session_id).is_none() {
        return false;
    }
    let Some(parent_id) = state
        .session_parent
        .get(session_id)
        .map(|entry| entry.value().clone())
    else {
        tracing::warn!(session = %session_id, "Initial prompt delivery timed out without a registered parent");
        return false;
    };
    let now_ms = now_epoch_ms();
    let payload = serde_json::json!({
        "type": "prompt_delivery_failed",
        "reason": "timeout",
        "session_id": session_id,
    });
    let message_id = format!("tuic-auto-prompt-{session_id}-{now_ms}");
    state.push_agent_inbox(
        &parent_id,
        crate::state::AgentMessage {
            id: message_id.clone(),
            from_tuic_session: session_id.to_string(),
            from_name: "tuic".to_string(),
            content: serde_json::to_string(&payload).unwrap_or_default(),
            timestamp: now_ms,
            delivered_via_channel: false,
        },
    );
    if state.assign_agent_delivery(
        &parent_id,
        &message_id,
        state.sessions.contains_key(&parent_id),
    ) != crate::state::AgentDeliveryAssignment::Terminal
    {
        return true;
    }
    let delivered = deliver_message_to_managed_pty(
        state,
        &parent_id,
        &format!(
            "[TUIC] child agent {} initial prompt delivery timed out",
            short_session(session_id)
        ),
    );
    if delivered {
        state.mark_terminal_delivery_dispatched(&parent_id, &message_id);
    } else {
        state.release_terminal_delivery(&parent_id, &message_id);
    }
    true
}

/// First 8 chars of a session UUID, for compact human-facing labels.
fn short_session(session_id: &str) -> &str {
    session_id.get(..8).unwrap_or(session_id)
}

/// Whether a framed peer message should be typed into `session_id` right now
/// rather than queued. True only for an agent session that is idle and not
/// blocked on a *confident* user-facing question — writing into a busy Ink TUI
/// can corrupt its render, and writing into a plain shell would execute the
/// message as a command.
///
/// The gate is `question_confident`, NOT `awaiting_input`: agents that idle at
/// a ready prompt (codex) sit permanently at `awaiting_input=true` via the
/// low-confidence silence heuristic, which would starve delivery forever
/// (story 091). Confident questions (Ink footer, cliclack `◆ …?`, "Action
/// Required" titles) still block injection so a peer message never answers a
/// real approval prompt.
fn idle_is_confirmed(state: &AppState, session_id: &str) -> bool {
    let confirmed = state
        .silence_states
        .get(session_id)
        .map(|sl| sl.lock().idle_confirmed)
        .unwrap_or(false);
    if confirmed {
        return true;
    }
    let agent_type = state
        .session_states
        .get(session_id)
        .and_then(|s| s.agent_type.clone());
    // Preserve legacy behavior for agents without a verified ready-screen
    // adapter. Hook-enabled variants become confirmed via explicit Stop; the
    // remaining heuristics cannot yet provide a stronger proof.
    !has_ready_screen_adapter(agent_type.as_deref())
}

pub(crate) fn should_inject_now(state: &AppState, session_id: &str) -> bool {
    let is_agent = state
        .session_states
        .get(session_id)
        .map(|s| s.agent_type.is_some())
        .unwrap_or(false);
    if !is_agent {
        return false;
    }
    let idle = state
        .shell_states
        .get(session_id)
        .map(|a| a.load(std::sync::atomic::Ordering::Relaxed) == SHELL_IDLE)
        .unwrap_or(false);
    let blocked_on_question = state
        .session_states
        .get(session_id)
        .map(|s| s.question_confident)
        .unwrap_or(false);
    let has_partial_user_input = state
        .input_buffers
        .get(session_id)
        .is_some_and(|buffer| !buffer.lock().content().is_empty());
    idle && idle_is_confirmed(state, session_id) && !blocked_on_question && !has_partial_user_input
}

/// Reserve an idle agent composer for one injected command.
///
/// `should_inject_now` is only a snapshot. The agent may become busy between
/// that read and the PTY write, so the final IDLE→BUSY transition must be an
/// atomic compare-exchange. A lost race leaves the message queued instead of
/// typing it into an active composer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct InjectionClaim {
    token: u64,
}

fn claim_idle_for_injection(state: &AppState, session_id: &str) -> Option<InjectionClaim> {
    if !should_inject_now(state, session_id) {
        return None;
    }
    let prior_idle_confirmed = state
        .silence_states
        .get(session_id)
        .map(|silence| silence.lock().idle_confirmed)
        .unwrap_or(false);
    if !try_shell_transition(state, session_id, SHELL_IDLE, SHELL_BUSY, true) {
        return None;
    }
    let token = state
        .silence_states
        .get(session_id)
        .map(|silence| silence.lock().begin_injection_claim(prior_idle_confirmed))
        .unwrap_or(0);
    emit_shell_state(state, session_id, "busy");
    Some(InjectionClaim { token })
}

fn rollback_injection_claim(state: &AppState, session_id: &str, claim: InjectionClaim) -> bool {
    let owns_claim = state
        .silence_states
        .get(session_id)
        .and_then(|silence| silence.lock().rollback_injection_claim(claim.token))
        .is_some();
    if !owns_claim {
        return false;
    }
    if try_shell_transition(state, session_id, SHELL_BUSY, SHELL_IDLE, true) {
        emit_shell_state(state, session_id, "idle");
        true
    } else {
        false
    }
}

fn mark_injection_uncertain(state: &AppState, session_id: &str, claim: InjectionClaim) {
    if let Some(silence) = state.silence_states.get(session_id) {
        silence.lock().mark_injection_uncertain(claim.token);
    }
}

/// Build the first write of an injection: Ctrl-U clears any pending input, and
/// multiline text rides inside a bracketed paste (ESC[200~ … ESC[201~) so the
/// TUI keeps embedded newlines as paste content and the trailing CR (sent as a
/// separate write) lands as a real Enter keypress. Mirrors the frontend
/// `sendCommand.ts` recipe exactly — raw multiline text merely PREFILLS
/// codex/claude without submitting (verified live, story 091).
fn injection_payload(text: &str) -> String {
    if text.contains('\n') {
        format!("\x15\x1b[200~{text}\x1b[201~")
    } else {
        format!("\x15{text}")
    }
}

/// Real-time gap inserted between the payload write and the Enter write of an
/// injection. Ink/raw-mode agents (Codex, Claude Code) only treat the trailing
/// CR as a submit when it arrives in a SEPARATE `read()` from the text; a
/// microsecond-apart back-to-back write — even with a flush in between — is
/// coalesced into one read and the CR is swallowed as part of the typed buffer,
/// so the message just sits at the prompt unsubmitted (verified live against
/// Codex: back-to-back hangs, CR after a gap submits). The frontend
/// `sendCommand.ts` recipe gets this gap for free — its two `writeFn` calls are
/// separate IPC round-trips — so this native path must reproduce it explicitly.
/// 50ms comfortably clears the child's read-scheduling latency while staying
/// imperceptible for a wake message.
const INJECT_ENTER_GAP: std::time::Duration = std::time::Duration::from_millis(50);

/// Type a framed line into a session's PTY as if the user submitted it, waking an
/// idle agent so it processes the message on its next turn. Split-write with the
/// `injection_payload` framing that Ink/raw-mode agents require, and — critically —
/// a REAL time gap between the payload and the Enter (see `INJECT_ENTER_GAP`): a
/// concatenated or merely back-to-back Enter is missed, and unbracketed multiline
/// text never submits. The session lock is released across the gap so a concurrent
/// writer to the same session is never blocked by the delay. Best-effort: a dead
/// PTY is logged and ignored (the inbox still holds the message).
/// Write prompt text and a submitting Enter to an agent PTY using the exact
/// framing and timing required by raw-mode TUIs. The caller owns bookkeeping:
/// peer delivery records a synthetic submission, while MCP session input feeds
/// the original text and Enter through its input-state FSM.
pub(crate) fn write_agent_command_to_pty(
    state: &AppState,
    session_id: &str,
    text: &str,
) -> Result<(), String> {
    {
        let entry = state
            .sessions
            .get(session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        let mut session = entry.lock();
        session
            .writer
            .write_all(injection_payload(text).as_bytes())
            .map_err(|e| format!("Write failed: {e}"))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Flush failed: {e}"))?;
    } // lock released before the gap

    // DEFERRED (2026-07-17) — this blocks the calling thread (sometimes a tokio
    // worker: session-state accumulator / agent-send dispatch) for INJECT_ENTER_GAP.
    // Acceptable because injection is low-frequency (peer messages, idle-transition
    // wakes). If a hot path ever calls this, move the sequence onto a detached
    // thread — that needs Arc<AppState> threaded through deliver/flush (wider refactor).
    std::thread::sleep(INJECT_ENTER_GAP);

    {
        let entry = state
            .sessions
            .get(session_id)
            .ok_or_else(|| "Session vanished before Enter injection".to_string())?;
        let mut session = entry.lock();
        session
            .writer
            .write_all(b"\r")
            .map_err(|e| format!("Write failed: {e}"))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Flush failed: {e}"))?;
    }

    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum InjectionOutcome {
    Submitted,
    NotStarted(String),
    Uncertain(String),
}

fn write_all_with_progress(
    writer: &mut dyn Write,
    bytes: &[u8],
    prior_bytes_written: usize,
) -> Result<(), (usize, String)> {
    let mut written = 0usize;
    while written < bytes.len() {
        match writer.write(&bytes[written..]) {
            Ok(0) => {
                return Err((
                    prior_bytes_written + written,
                    "Write failed: writer returned zero bytes".to_string(),
                ));
            }
            Ok(n) => written += n,
            Err(error) => {
                return Err((
                    prior_bytes_written + written,
                    format!("Write failed: {error}"),
                ));
            }
        }
    }
    Ok(())
}

fn write_claimed_agent_command(state: &AppState, session_id: &str, text: &str) -> InjectionOutcome {
    let payload = injection_payload(text);
    {
        let entry = match state.sessions.get(session_id) {
            Some(entry) => entry,
            None => return InjectionOutcome::NotStarted("Session not found".to_string()),
        };
        let mut session = entry.lock();
        if let Err((written, error)) =
            write_all_with_progress(session.writer.as_mut(), payload.as_bytes(), 0)
        {
            return if written == 0 {
                InjectionOutcome::NotStarted(error)
            } else {
                InjectionOutcome::Uncertain(error)
            };
        }
        if let Err(error) = session.writer.flush() {
            return InjectionOutcome::Uncertain(format!("Flush failed: {error}"));
        }
    }

    std::thread::sleep(INJECT_ENTER_GAP);

    {
        let entry = match state.sessions.get(session_id) {
            Some(entry) => entry,
            None => {
                return InjectionOutcome::Uncertain(
                    "Session vanished before Enter injection".to_string(),
                );
            }
        };
        let mut session = entry.lock();
        if let Err((_, error)) =
            write_all_with_progress(session.writer.as_mut(), b"\r", payload.len())
        {
            return InjectionOutcome::Uncertain(error);
        }
        if let Err(error) = session.writer.flush() {
            return InjectionOutcome::Uncertain(format!("Flush failed: {error}"));
        }
    }

    InjectionOutcome::Submitted
}

fn commit_injection_claim(state: &AppState, session_id: &str, claim: InjectionClaim) {
    let committed = state
        .silence_states
        .get(session_id)
        .map(|silence| silence.lock().commit_injection_claim(claim.token))
        .unwrap_or(false);
    if committed {
        note_submitted_input(state, session_id);
    }
}

fn run_claimed_injection(
    state: &AppState,
    session_id: &str,
    text: &str,
    claim: InjectionClaim,
) -> InjectionOutcome {
    let outcome = write_claimed_agent_command(state, session_id, text);
    apply_claimed_injection_outcome(state, session_id, text, claim, outcome)
}

fn apply_claimed_injection_outcome(
    state: &AppState,
    session_id: &str,
    text: &str,
    claim: InjectionClaim,
    outcome: InjectionOutcome,
) -> InjectionOutcome {
    match &outcome {
        InjectionOutcome::Submitted => {
            commit_injection_claim(state, session_id, claim);
            if state
                .pending_initial_prompts
                .get(session_id)
                .is_some_and(|prompt| prompt.as_str() == text)
            {
                state.pending_initial_prompts.remove(session_id);
            }
        }
        InjectionOutcome::NotStarted(error) => {
            tracing::debug!(session = %session_id, error, "agent command injection did not start");
            rollback_injection_claim(state, session_id, claim);
        }
        InjectionOutcome::Uncertain(error) => {
            tracing::warn!(session = %session_id, error, "agent command injection outcome uncertain; preserving busy state");
            mark_injection_uncertain(state, session_id, claim);
        }
    }
    outcome
}

fn requeue_injection_front(state: &AppState, session_id: &str, text: &str) {
    state
        .pending_injections
        .entry(session_id.to_string())
        .or_default()
        .push_front(text.to_string());
}

/// Deliver a framed peer message into a recipient's terminal, waking it. Injects
/// immediately when the recipient is an idle agent; otherwise queues it to flush
/// on the recipient's next BUSY→IDLE transition. No-op for non-agent sessions.
/// The caller has already buffered the authoritative copy in the inbox.
pub(crate) fn deliver_message_to_pty(state: &AppState, session_id: &str, framed: &str) {
    // Never queue for a non-agent — shells and dead sessions have no wake path.
    let is_agent = state
        .session_states
        .get(session_id)
        .map(|s| s.agent_type.is_some())
        .unwrap_or(false);
    if !is_agent {
        return;
    }
    if let Some(claim) = claim_idle_for_injection(state, session_id) {
        if matches!(
            run_claimed_injection(state, session_id, framed, claim),
            InjectionOutcome::NotStarted(_)
        ) {
            requeue_injection_front(state, session_id, framed);
        }
    } else {
        state
            .pending_injections
            .entry(session_id.to_string())
            .or_default()
            .push_back(framed.to_string());
        // CONC-A (story 101-20e3): the should_inject_now read above and this push are
        // not atomic vs a concurrent BUSY→IDLE flush. If the silence timer transitions
        // the session to idle and drains the (still-empty) queue in the window between
        // them, our message would sit queued until the NEXT idle cycle — exactly the
        // auto-wake this feature exists to deliver. Re-flush after enqueuing: if the
        // session went idle during the window, flush_pending_injections (self-guarded
        // by should_inject_now) delivers it ourselves. A double flush is harmless — it
        // drains under a get_mut write lock, so the racing flush that loses just finds
        // an empty queue.
        flush_pending_injections(state, session_id);
    }
}

/// Deliver only while the recipient still has a managed PTY and agent state.
/// Returns false when teardown won the race so the caller can release wake
/// ownership and leave the authoritative inbox copy available to `agent wait`.
pub(crate) fn deliver_message_to_managed_pty(
    state: &AppState,
    session_id: &str,
    framed: &str,
) -> bool {
    let available = state.sessions.contains_key(session_id)
        && state
            .session_states
            .get(session_id)
            .is_some_and(|session| session.agent_type.is_some());
    if !available {
        return false;
    }
    deliver_message_to_pty(state, session_id, framed);
    state.sessions.contains_key(session_id)
}

/// Drain and inject any messages queued for a session that can receive them now.
/// Self-guarded by `should_inject_now`: skips (leaves queued) unless the session
/// is an idle agent not blocked on a confident question, so a peer message never
/// answers a user-facing approval prompt and never corrupts a busy TUI. Called
/// from the BUSY→IDLE transition, the post-enqueue race re-check, and the
/// unblock path when a confident question clears while the agent is idle.
pub(crate) fn flush_pending_injections(state: &AppState, session_id: &str) {
    if state
        .pending_injections
        .get(session_id)
        .is_none_or(|pending| pending.is_empty())
    {
        return;
    }
    let claim = match claim_idle_for_injection(state, session_id) {
        Some(claim) => claim,
        None => return,
    };
    let pending = match state.pending_injections.get_mut(session_id) {
        Some(mut q) => q.pop_front(),
        None => return,
    };
    if let Some(text) = pending
        && matches!(
            run_claimed_injection(state, session_id, &text, claim),
            InjectionOutcome::NotStarted(_)
        )
    {
        requeue_injection_front(state, session_id, &text);
    }
}

/// Keeps `output_buffers`, `vt_log_buffers`, `last_output_ms`, and `exit_codes`
/// alive so MCP consumers can read final output + exit status post-mortem.
/// Tombstones are reaped by `spawn_tombstone_sweeper` after `TOMBSTONE_TTL_MS`.
pub(crate) fn mark_session_exited(session_id: &str, state: &AppState) {
    // Capture exit code before dropping the session entry.
    // portable_pty::ExitStatus carries both exit_code() and signal().
    // Signal-killed processes get 128+signum (shell convention) so the
    // caller can distinguish SIGKILL (137) from normal exit(1).
    if let Some(entry) = state.sessions.get(session_id)
        && let Ok(Some(status)) = entry.value().lock()._child.try_wait()
    {
        let code = if let Some(sig) = status.signal() {
            let signum = parse_signal_number(sig);
            128 + signum
        } else {
            status.exit_code() as i32
        };
        state.exit_codes.insert(session_id.to_string(), code);
    }
    if state.sessions.remove(session_id).is_some() {
        state
            .metrics
            .active_sessions
            .fetch_sub(1, Ordering::Relaxed);
    }

    // Notify orchestrator (if any) that this agent has exited.
    let exit_code = state.exit_codes.get(session_id).map(|e| *e.value());
    push_state_change_to_parent(
        state,
        session_id,
        serde_json::json!({
            "type": "state_change",
            "state": "exited",
            "session_id": session_id,
            "exit_code": exit_code,
        }),
    );

    // SIMP-1: drain HTML tabs registered by this session and emit close.
    // Same helper used by `session(close)` and `session(kill)` so all three
    // exit paths drain `session_html_tabs` identically (no orphan tabs).
    crate::mcp_http::mcp_transport::emit_close_html_tabs(state, session_id);

    tombstone_transient_cleanup(session_id, state);
}

/// Time a tombstoned session's buffers remain readable after process exit.
pub(crate) const TOMBSTONE_TTL_MS: u64 = 5 * 60 * 1000; // 5 minutes

/// Background sweeper that reaps tombstoned session buffers once they age out.
/// Started once at boot from the HTTP server runtime.
pub(crate) fn spawn_tombstone_sweeper(state: Arc<AppState>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            // A tombstone is: buffer entry present, session entry absent, aged past TTL.
            let candidates: Vec<String> = state
                .output_buffers
                .iter()
                .filter_map(|entry| {
                    let id = entry.key();
                    if state.sessions.contains_key(id) {
                        return None;
                    }
                    let last_ms = state
                        .last_output_ms
                        .get(id)
                        .map(|m| m.load(Ordering::Relaxed))
                        .unwrap_or(0);
                    if last_ms == 0 || now_ms.saturating_sub(last_ms) < TOMBSTONE_TTL_MS {
                        return None;
                    }
                    Some(id.clone())
                })
                .collect();
            for id in candidates {
                state.output_buffers.remove(&id);
                state.vt_log_buffers.remove(&id);
                state.pty_raw_rings.remove(&id);
                state.last_output_ms.remove(&id);
                state.exit_codes.remove(&id);
                tracing::debug!(source = "pty", session_id = %id, "Tombstone reaped");
            }
        }
    });
}

/// Detect anomalous ANSI sequences that may cause scroll-jump-to-top or viewport resets.
/// Returns a list of human-readable labels for each detected sequence.
/// These are logged as warnings for diagnostic purposes — data is never modified.
fn detect_anomalous_sequences(data: &str) -> Vec<&'static str> {
    let bytes = data.as_bytes();
    let len = bytes.len();
    let mut found = Vec::new();
    let mut i = 0;

    while i < len {
        if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == b'[' {
            i += 2; // skip ESC[

            // Check for ESC[? private mode sequences (alt screen)
            if i < len && bytes[i] == b'?' {
                i += 1;
                let num_start = i;
                while i < len && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i < len {
                    let num_str = std::str::from_utf8(&bytes[num_start..i]).unwrap_or("");
                    match (num_str, bytes[i]) {
                        ("1049", b'h') => found.push("ESC[?1049h (Alt Screen Enter)"),
                        ("1049", b'l') => found.push("ESC[?1049l (Alt Screen Exit)"),
                        _ => {}
                    }
                    i += 1;
                }
                // No continue — let the outer while loop re-evaluate i < len
            } else {
                // Parse numeric params: n or n;m
                let num_start = i;
                while i < len && (bytes[i].is_ascii_digit() || bytes[i] == b';') {
                    i += 1;
                }
                if i < len {
                    let params = std::str::from_utf8(&bytes[num_start..i]).unwrap_or("");
                    match bytes[i] {
                        b'J' => match params {
                            "2" => found.push("ESC[2J (Clear Screen)"),
                            "3" => found.push("ESC[3J (Clear Scrollback)"),
                            _ => {}
                        },
                        b'H' => {
                            // ESC[H or ESC[1;1H = Cursor Home
                            if params.is_empty() {
                                found.push("ESC[H (Cursor Home)");
                            } else if params == "1;1" {
                                found.push("ESC[1;1H (Cursor Home)");
                            }
                            // Other ESC[n;mH = regular cursor position, not anomalous
                        }
                        _ => {}
                    }
                    i += 1;
                }
            }
        } else {
            i += 1;
        }
    }

    found
}

/// Extract the largest ESC[nA (cursor-up) value from `data`.
/// Ink emits ESC[nA where n equals the previous render height before redrawing.
/// A decrease in n between consecutive redraws signals content shrinkage.
fn extract_largest_cursor_up(data: &str) -> Option<u16> {
    let bytes = data.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    let mut max_n: Option<u16> = None;

    while i < len {
        if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == b'[' {
            i += 2;
            let num_start = i;
            while i < len && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < len
                && bytes[i] == b'A'
                && i > num_start
                && let Ok(n) = std::str::from_utf8(&bytes[num_start..i])
                    .unwrap_or("")
                    .parse::<u16>()
            {
                max_n = Some(max_n.map_or(n, |prev: u16| prev.max(n)));
            }
            if i < len {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    max_n
}

/// Inject ESC[2J (clear screen) before the first ESC[H or ESC[1;1H (cursor home) in `data`.
///
/// Ink-based TUIs render differentially: they position the cursor at home and overwrite
/// changed cells but never send ESC[K (erase to end of line). When output shrinks between
/// redraws, old characters — especially box-drawing separators — persist as ghost artifacts.
///
/// Injecting a single ESC[2J before the cursor-home ensures the screen is blank before
/// the redraw starts. Because xterm.js processes the entire write() atomically (clear +
/// cursor home + new content happen before the next paint), no intermediate blank frame
/// is ever rendered to the user.
///
/// Only injects once per call (before the first cursor-home) to avoid unnecessary clears
/// for chunks that contain multiple ESC[H sequences (common in Ink's rapid redraws).
fn inject_clear_before_cursor_home(data: &str) -> String {
    let bytes = data.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == b'[' {
            let seq_start = i;
            i += 2; // skip ESC[
            // Parse optional numeric parameters
            let num_start = i;
            while i < len && (bytes[i].is_ascii_digit() || bytes[i] == b';') {
                i += 1;
            }
            if i < len && bytes[i] == b'H' {
                let params = std::str::from_utf8(&bytes[num_start..i]).unwrap_or("");
                // ESC[H (no params) or ESC[1;1H — both mean cursor home
                if params.is_empty() || params == "1;1" {
                    // Inject ESC[2J before this cursor-home sequence
                    let mut result = String::with_capacity(len + 4);
                    result.push_str(&data[..seq_start]);
                    result.push_str("\x1b[2J");
                    result.push_str(&data[seq_start..]);
                    return result;
                }
            }
            if i < len {
                i += 1; // skip command byte
            }
        } else {
            i += 1;
        }
    }

    // No cursor-home found — return as-is
    data.to_string()
}

/// Inject ESC[2J before the first ESC[nA (cursor-up, n > 0) in `data`.
///
/// Fallback for `inject_clear_before_cursor_home`: Ink re-renders reposition via
/// cursor-up (ESC[nA), not cursor-home (ESC[H). Without this path the
/// `alt_buffer_needs_clear` flag is set but never consumed, and ghost rows
/// from previous renders accumulate from the bottom upward.
fn inject_clear_before_cursor_up(data: &str) -> String {
    let bytes = data.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == b'[' {
            let seq_start = i;
            i += 2; // skip ESC[
            let num_start = i;
            while i < len && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if i < len && bytes[i] == b'A' && i > num_start {
                // ESC[nA with n > 0 — inject ESC[2J before it
                let mut result = String::with_capacity(len + 4);
                result.push_str(&data[..seq_start]);
                result.push_str("\x1b[2J");
                result.push_str(&data[seq_start..]);
                return result;
            }
            if i < len {
                i += 1; // skip command byte
            }
        } else {
            i += 1;
        }
    }

    data.to_string()
}

/// Spawn a reader thread that reads from a PTY, processes output, and emits events.
/// Unified for both desktop (Tauri IPC) and headless (event_bus only) modes.
/// 1-minute system load average divided by the online CPU count — a measure of
/// machine-wide CPU oversubscription (NOT this process's own usage, which the
/// cpu_watchdog covers via getrusage). >= 1.0 means the run queue is as long as
/// there are cores: things are queueing and the WebView main thread gets starved.
/// Used to gate the typing frame-throttle so it only kicks in under real load.
/// Returns 0.0 where unavailable (Windows) — throttle stays off, behaviour unchanged.
#[cfg(unix)]
fn system_load_per_core() -> f64 {
    let mut avg = [0f64; 3];
    let n = unsafe { libc::getloadavg(avg.as_mut_ptr(), 3) };
    if n < 1 {
        return 0.0;
    }
    let ncpu = unsafe { libc::sysconf(libc::_SC_NPROCESSORS_ONLN) };
    let ncpu = if ncpu < 1 { 1.0 } else { ncpu as f64 };
    avg[0] / ncpu
}

#[cfg(not(unix))]
fn system_load_per_core() -> f64 {
    0.0
}

/// Minimum interval (ms) the grid ticker must wait between frame sends.
/// `0` = no floor (send at the full 16 ms tick / ~60 fps), for short bursts so
/// latency stays low. The two floors give the WebView main thread breathing room:
///  - `input_recent` (user typing under CPU saturation) → ~20 fps, the most
///    aggressive floor, so keystroke dispatch + echo aren't stuck behind output.
///  - sustained animation (grid dirty ≥ 6 consecutive ticks, e.g. a spinner TUI)
///    → ~30 fps.
///
/// Typing wins over sustained because it's the latency-critical case.
fn grid_send_min_interval_ms(input_recent: bool, dirty_run: u32) -> u64 {
    const SUSTAINED_DIRTY_TICKS: u32 = 6;
    const SUSTAINED_MIN_INTERVAL_MS: u64 = 33; // ~30 fps while animating
    const INPUT_MIN_INTERVAL_MS: u64 = 50; // ~20 fps while typing under load
    if input_recent {
        INPUT_MIN_INTERVAL_MS
    } else if dirty_run >= SUSTAINED_DIRTY_TICKS {
        SUSTAINED_MIN_INTERVAL_MS
    } else {
        0
    }
}

/// Stamp the per-session last-input timestamp (epoch ms). Read by the grid
/// ticker to throttle frame sends while the user types under CPU saturation,
/// keeping the WebView/browser main thread free for keystroke dispatch + echo.
/// Called from every interactive input entry point (desktop `write_pty` +
/// HTTP/PWA `write_to_session`).
pub(crate) fn stamp_input_ms(state: &AppState, session_id: &str) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    state
        .last_input_ms
        .entry(session_id.to_string())
        .or_insert_with(|| std::sync::atomic::AtomicU64::new(0))
        .store(now_ms, std::sync::atomic::Ordering::Relaxed);
}

pub(crate) fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    paused: Arc<AtomicBool>,
    session_id: String,
    state: Arc<AppState>,
    tuic_session: Option<String>,
) {
    let silence = Arc::new(Mutex::new(SilenceState::new()));
    let running = Arc::new(AtomicBool::new(true));

    state
        .silence_states
        .insert(session_id.clone(), silence.clone());
    state.shell_states.insert(
        session_id.clone(),
        std::sync::atomic::AtomicU8::new(SHELL_NULL),
    );

    spawn_silence_timer(
        silence.clone(),
        running.clone(),
        session_id.clone(),
        state.clone(),
    );

    // Frame ticker: decouples PTY read() from frame serialization.
    // Reader sets dirty flag; ticker serializes+sends at fixed interval.
    // Coalesces rapid writes (spinner erase+rewrite) into a single frame.
    let frame_dirty = Arc::new(AtomicBool::new(false));
    state
        .grid_frame_dirty
        .insert(session_id.clone(), frame_dirty.clone());
    let ticker_running = running.clone();
    let ticker_dirty = frame_dirty.clone();
    let ticker_state = state.clone();
    let ticker_sid = session_id.clone();
    std::thread::spawn(move || {
        // Frame serialize+emit is the Rust side of the echo→render path; keep it
        // in the high QoS band so output stays live under a saturating build.
        raise_thread_for_interactive_io();
        const TICK: std::time::Duration = std::time::Duration::from_millis(16);
        // Safety net: if in_flight stays true for this long (~500 ms),
        // force-reset it so frame delivery resumes. Prevents permanent blank
        // terminal when the frontend fails to ack (crash, corrupt frame, etc.).
        const MAX_IN_FLIGHT_MS: u64 = 500;
        // After this many consecutive force-resets, back off for STUCK_PAUSE_MS
        // to let the JS event loop drain the Tauri channel backlog before
        // sending more frames. Kept short (1s, chunked) so a transient JS stall
        // — e.g. a repo-changed git/IPC burst that blocks the WebView thread for
        // ~1-2s — doesn't freeze an otherwise-healthy terminal for the full
        // pause. The loop re-applies the back-off if the frontend is still
        // behind, so persistent saturation still gets cumulative backpressure.
        const MAX_STUCK_BEFORE_PAUSE: u32 = 3;
        const STUCK_PAUSE_MS: u64 = 1_000;
        // Send-rate floors live in grid_send_min_interval_ms() (unit-tested).
        // How long after a keystroke the typing-throttle stays armed.
        const INPUT_THROTTLE_WINDOW_MS: u64 = 150;
        const LOAD_SATURATION_RATIO: f64 = 1.0; // 1-min load >= cores
        const LOAD_SAMPLE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
        let mut stuck_since: Option<std::time::Instant> = None;
        let mut stuck_count: u32 = 0;
        let mut dirty_run: u32 = 0;
        let mut last_sent: Option<std::time::Instant> = None;
        let mut last_load_check: Option<std::time::Instant> = None;
        let mut system_saturated = false;
        while ticker_running.load(Ordering::Relaxed) {
            std::thread::sleep(TICK);
            if !ticker_dirty.swap(false, Ordering::Relaxed) {
                // Idle tick: leave sustained-animation mode so the next burst
                // (keystroke, fresh output) gets full 60 fps low-latency response.
                dirty_run = 0;
                continue;
            }
            dirty_run = dirty_run.saturating_add(1);
            let in_flight = ticker_state
                .grid_frame_in_flight
                .get(&ticker_sid)
                .map(|f| f.load(Ordering::Relaxed))
                .unwrap_or(false);
            if in_flight {
                let now = std::time::Instant::now();
                let since = stuck_since.get_or_insert(now);
                let elapsed = now.duration_since(*since).as_millis() as u64;
                if elapsed > MAX_IN_FLIGHT_MS {
                    stuck_count += 1;
                    tracing::warn!(
                        session_id = %ticker_sid,
                        elapsed_ms = elapsed,
                        stuck_count,
                        "grid_frame_in_flight stuck, force-resetting"
                    );
                    if let Some(flag) = ticker_state.grid_frame_in_flight.get(&ticker_sid) {
                        flag.store(false, Ordering::Relaxed);
                    }
                    stuck_since = None;
                    if stuck_count >= MAX_STUCK_BEFORE_PAUSE {
                        // Back off to let JS drain the channel backlog before retrying.
                        // Sleep in short chunks so (a) a recovered frontend resumes
                        // within ~one chunk rather than the full pause, and (b) session
                        // close isn't delayed up to the full pause on shutdown.
                        stuck_count = 0;
                        let mut waited = 0u64;
                        while waited < STUCK_PAUSE_MS && ticker_running.load(Ordering::Relaxed) {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            waited += 100;
                        }
                    }
                    ticker_dirty.store(true, Ordering::Relaxed);
                    continue;
                } else {
                    ticker_dirty.store(true, Ordering::Relaxed);
                    continue;
                }
            } else {
                stuck_since = None;
                stuck_count = 0;
            }
            // Adaptive frame-rate floor: a TUI that animates continuously (e.g.
            // grok's spinner repaints its whole bordered UI and walks the cursor
            // around every tick) keeps the grid dirty 100% of the time, so the
            // ticker would emit ~50 multi-KB frames/s. The in_flight gate prevents
            // queue overflow but NOT WebView main-thread starvation — it paints
            // flat-out and never yields to input/console, so the UI looks frozen.
            // Once dirtiness is sustained, cap the send rate to ~30 fps to give the
            // JS thread breathing room. Short bursts stay at the full 60 fps tick.
            let now = std::time::Instant::now();
            // Refresh the machine-saturation gate ~once/sec (cheap getloadavg).
            if last_load_check.is_none_or(|t| now.duration_since(t) >= LOAD_SAMPLE_INTERVAL) {
                system_saturated = system_load_per_core() >= LOAD_SATURATION_RATIO;
                last_load_check = Some(now);
            }
            // Typing-under-load throttle: only when saturated AND the user typed
            // recently. now_epoch_ms() is computed only on the saturated path.
            let input_recent = system_saturated && {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                ticker_state
                    .last_input_ms
                    .get(&ticker_sid)
                    .map(|ts| {
                        now_ms.saturating_sub(ts.load(Ordering::Relaxed)) < INPUT_THROTTLE_WINDOW_MS
                    })
                    .unwrap_or(false)
            };
            // Pick the send-rate floor: typing-under-load (~20 fps) wins, else the
            // sustained-animation floor (~30 fps), else full 60 fps for short bursts.
            let min_interval = grid_send_min_interval_ms(input_recent, dirty_run);
            if min_interval > 0
                && let Some(last) = last_sent
                && (now.duration_since(last).as_millis() as u64) < min_interval
            {
                ticker_dirty.store(true, Ordering::Relaxed); // keep pending for a later tick
                continue;
            }
            if let Some(vt) = ticker_state.vt_log_buffers.get(&ticker_sid) {
                let mut g = vt.lock();
                if let Some(p) = ticker_state.pending_scroll.get(&ticker_sid) {
                    let target = p.swap(-1, Ordering::Relaxed);
                    if target >= 0 {
                        g.grid_scroll_to_offset(target as usize);
                    }
                }
                let frame = g.serialize_dirty_rows();
                drop(g);
                send_grid_frame(&ticker_state, &ticker_sid, frame);
                last_sent = Some(now);
            }
        }
        // Final flush after reader exits
        if let Some(vt) = ticker_state.vt_log_buffers.get(&ticker_sid) {
            let frame = vt.lock().serialize_dirty_rows();
            send_grid_frame(&ticker_state, &ticker_sid, frame);
        }
        ticker_state.grid_frame_dirty.remove(&ticker_sid);
    });

    std::thread::spawn(move || {
        // PTY reader drives byte intake → echo; keep it above default-QoS builds.
        raise_thread_for_interactive_io();
        let sid_for_panic = session_id.clone();
        let state_for_panic = state.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut buf = [0u8; 65536];
            let mut utf8_buf = Utf8ReadBuffer::new();
            let mut esc_buf = EscapeAwareBuffer::new();
            let session_cwd: Option<String> = state
                .sessions
                .get(&session_id)
                .and_then(|s| s.lock().cwd.clone());
            let mut processor = ChunkProcessor::new(session_cwd, tuic_session);
            // pty-output is emitted only for frontend activity detection (the canvas
            // renders from grid frames and discards the text). Emitting it per-chunk
            // flooded the WebView main thread under output storms (`yes`), starving
            // keydown so Ctrl+C never reached write_pty. Throttle to ~10/s — enough for
            // the activity dot / lastDataAt, no flood.
            // DEFERRED (2026-06-16) — cleaner: compute activity fully in Rust and drop
            // pty-output in desktop entirely (frontend-only-renders rule). Needs moving
            // Terminal.tsx activity/lastDataAt onto an existing throttled signal.
            // Only the desktop build emits (and throttles) pty-output; the headless
            // remote build never touches this, so gate it to avoid an unused_mut warning.
            #[cfg(feature = "desktop")]
            let mut last_pty_output_emit: Option<std::time::Instant> = None;
            loop {
                while paused.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        state.metrics.bytes_emitted.fetch_add(n, Ordering::Relaxed);
                        // Flight recorder: keep the last PTY_RAW_RING_CAP raw bytes
                        // (pre-transform) so a wild rendering corruption can be
                        // dumped and replayed offline (story 056-7545).
                        {
                            let ring = state.pty_raw_rings.entry(session_id.clone()).or_default();
                            let mut ring = ring.lock();
                            ring.extend(&buf[..n]);
                            if ring.len() > PTY_RAW_RING_CAP {
                                let excess = ring.len() - PTY_RAW_RING_CAP;
                                ring.drain(..excess);
                            }
                        }
                        let utf8_data = utf8_buf.push(&buf[..n]);
                        let esc_data = esc_buf.push(&utf8_data);
                        let (kitty_clean, kitty_actions) = strip_kitty_sequences(&esc_data);
                        if kitty_clean.contains("1049l") && !kitty_clean.contains("\x1b[?1049l") {
                            tracing::error!(source = "terminal", session_id = %session_id,
                            "DECRST leak: kitty_clean has bare '1049l' without ESC[? prefix. \
                             esc_data({} bytes)={:?}, kitty_clean({} bytes)={:?}, actions={:?}",
                            esc_data.len(), esc_data.as_bytes().iter().take(200).collect::<Vec<_>>(),
                            kitty_clean.len(), kitty_clean.as_bytes().iter().take(200).collect::<Vec<_>>(),
                            kitty_actions);
                        }
                        let data = kitty_clean;

                        process_kitty_actions(&kitty_actions, &session_id, &state);

                        if let Some(processed) =
                            processor.process_chunk(&data, &silence, &session_id, &state)
                            && let Some(xterm_data) = processor.transform_xterm(processed)
                        {
                            let clamped_data = xterm_data;

                            let agent_active = state
                                .session_states
                                .get(&session_id)
                                .map(|s| s.agent_type.is_some())
                                .unwrap_or(false);
                            if !processor.in_alt_buffer
                                && !agent_active
                                && clamped_data.as_bytes().contains(&0x1b)
                            {
                                let anomalies = detect_anomalous_sequences(&clamped_data);
                                for label in &anomalies {
                                    tracing::warn!(source = "terminal", session_id = %session_id, "Anomalous ANSI sequence: {label}");
                                }
                            }

                            // Emit pty-output for frontend activity detection, THROTTLED.
                            // Root cause of the `yes`-flood Ctrl+C wedge (2026-06-16):
                            // this event fired per read() chunk (thousands/s under a flood).
                            // Each one is a Tauri event the WebView main thread must
                            // deserialize+dispatch; the storm of short tasks starved the
                            // event loop so keydown never ran → Ctrl+C never reached
                            // write_pty (verified: 0 write_pty calls during flood, normal
                            // when throttled). The canvas renders from grid frames and
                            // discards this text (handlePtyData ignores `data`), so dropping
                            // intermediate chunks is safe — we only need a periodic "output
                            // happened" pulse for the activity dot / lastDataAt.
                            #[cfg(feature = "desktop")]
                            {
                                let should_emit = last_pty_output_emit
                                    .map(|t| t.elapsed() >= std::time::Duration::from_millis(100))
                                    .unwrap_or(true);
                                if should_emit && let Some(app) = state.app_handle.read().as_ref() {
                                    let _ = app.emit(
                                        &format!("pty-output-{session_id}"),
                                        PtyOutput {
                                            session_id: session_id.clone(),
                                            data: clamped_data,
                                        },
                                    );
                                    last_pty_output_emit = Some(std::time::Instant::now());
                                }
                            }
                        }

                        frame_dirty.store(true, Ordering::Relaxed);
                    }
                    Err(e) => {
                        tracing::error!(session_id = %session_id, "PTY reader error: {e}");
                        break;
                    }
                }
            }
            running.store(false, Ordering::Relaxed);

            if try_shell_transition(&state, &session_id, SHELL_BUSY, SHELL_IDLE, false) {
                emit_shell_state(&state, &session_id, "idle");
                // EOF bypass: should_transition_idle was not called, so force-clear
                // active_sub_tasks to avoid leaving the frontend notification gate
                // in an inconsistent state after process crash/exit.
                let needs_clear = state
                    .session_states
                    .get_mut(&session_id)
                    .filter(|e| e.active_sub_tasks > 0)
                    .map(|mut e| {
                        e.active_sub_tasks = 0;
                    })
                    .is_some();
                if needs_clear {
                    emit_active_subtasks(&state, &session_id, 0, "");
                }
            }

            let remaining = flush_eof(&mut utf8_buf, &mut esc_buf, &session_id, &state);
            #[cfg(feature = "desktop")]
            if !remaining.is_empty()
                && let Some(app) = state.app_handle.read().as_ref()
            {
                let _ = app.emit(
                    &format!("pty-output-{session_id}"),
                    PtyOutput {
                        session_id: session_id.clone(),
                        data: remaining,
                    },
                );
            }

            state.emit_pty_event(crate::state::AppEvent::PtyExit {
                session_id: session_id.clone(),
            });
            #[cfg(feature = "desktop")]
            if let Some(app) = state.app_handle.read().as_ref() {
                let _ = app.emit(
                    &format!("pty-exit-{session_id}"),
                    serde_json::json!({ "session_id": session_id }),
                );
            }
            tracing::info!(source = "pty", session_id = %session_id, "Session closed: process exited");
            state.emit_pty_event(crate::state::AppEvent::SessionClosed {
                session_id: session_id.clone(),
                reason: "process_exit".to_string(),
            });
            #[cfg(feature = "desktop")]
            if let Some(app) = state.app_handle.read().as_ref() {
                let agent_type = state
                    .session_states
                    .get(&session_id)
                    .and_then(|s| s.agent_type.clone());
                let _ = app.emit(
                    "session-closed",
                    serde_json::json!({
                        "session_id": session_id,
                        "reason": "process_exit",
                        "agent_type": agent_type,
                    }),
                );
            }

            mark_session_exited(&session_id, &state);
        })); // end catch_unwind
        if let Err(panic_info) = result {
            let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic payload".to_string()
            };
            tracing::error!(session_id = %sid_for_panic, "READER THREAD PANICKED: {msg}");
            mark_session_exited(&sid_for_panic, &state_for_panic);
        }
    });
}

/// Create a new PTY session with optional worktree
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn create_pty(
    _app: AppHandle,
    state: State<'_, Arc<AppState>>,
    config: PtyConfig,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    let pty_system = native_pty_system();

    let shell = resolve_shell(config.shell);

    // Guard against invalid dimensions from zero-sized windows
    let rows = config.rows.max(24);
    let cols = config.cols.max(80);

    // Retry PTY spawn up to 3 times with increasing delay (Story 059)
    let max_retries = 3;
    let mut last_err = String::new();
    let mut pair_and_child = None;

    for attempt in 0..max_retries {
        let pair = match pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(p) => p,
            Err(e) => {
                last_err = format!("Failed to open PTY (attempt {}): {}", attempt + 1, e);
                if attempt < max_retries - 1 {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        100 * (attempt as u64 + 1),
                    ))
                    .await;
                }
                continue;
            }
        };

        let mut cmd = build_shell_command(&shell);

        if let Some(ref cwd) = config.cwd {
            let cwd = crate::cli::expand_tilde(cwd);
            // Don't convert drive paths for WSL — cmd.cwd() sets the Windows
            // process CWD via CreateProcessW, which can't resolve Linux paths.
            // Windows translates drive paths to /mnt/... automatically when
            // spawning wsl.exe. (GitHub #27)
            cmd.cwd(cwd);
        }

        // Inject OSC 133 shell integration (command block markers)
        crate::shell_integration::inject(&state.data_dir, &shell, &mut cmd);

        // Inject stable session UUID so agents can use it for session binding
        // (e.g. `claude --session-id $TUIC_SESSION`, then `claude --resume $TUIC_SESSION`)
        if let Some(ref tuic_session) = config.tuic_session {
            cmd.env("TUIC_SESSION", tuic_session);
            cmd.env(
                "TUIC_CONFIG_DIR",
                crate::config::config_dir().to_string_lossy().as_ref(),
            );
        }

        // Inject env flags (feature flags configured in Settings → Agents)
        for (key, value) in &config.env {
            cmd.env(key, value);
        }

        match pair.slave.spawn_command(cmd) {
            Ok(child) => {
                pair_and_child = Some((pair, child));
                break;
            }
            Err(e) => {
                last_err = format!("Failed to spawn shell (attempt {}): {}", attempt + 1, e);
                if attempt < max_retries - 1 {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        100 * (attempt as u64 + 1),
                    ))
                    .await;
                }
            }
        }
    }

    let (pair, child) = pair_and_child.ok_or(last_err)?;
    lower_pty_child_priority(child.process_id());

    let tuic_session = config.tuic_session.clone();

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    // Store session (master handle kept for resize support)
    let paused = Arc::new(AtomicBool::new(false));
    state.sessions.insert(
        session_id.clone(),
        Mutex::new(PtySession {
            writer,
            master: pair.master,
            _child: child,
            paused: paused.clone(),
            worktree: None,
            cwd: config.cwd,
            display_name: None,
            shell: shell.clone(),
        }),
    );
    state.assign_term_alias(&session_id);
    state.metrics.total_spawned.fetch_add(1, Ordering::Relaxed);
    state
        .metrics
        .active_sessions
        .fetch_add(1, Ordering::Relaxed);

    // Create ring buffer and VT log buffer for this session
    state.output_buffers.insert(
        session_id.clone(),
        Mutex::new(OutputRingBuffer::new(OUTPUT_RING_BUFFER_CAPACITY)),
    );
    let mut vt_log = VtLogBuffer::new(24, 220, VT_LOG_BUFFER_CAPACITY);
    if let Some(colors) = state.ansi_colors.read().as_ref() {
        vt_log.set_ansi_colors(colors);
    }
    state
        .vt_log_buffers
        .insert(session_id.clone(), Mutex::new(vt_log));
    let (grid_watch_tx, _) = tokio::sync::watch::channel(Vec::new());
    state.grid_watch.insert(session_id.clone(), grid_watch_tx);
    state
        .last_output_ms
        .insert(session_id.clone(), std::sync::atomic::AtomicU64::new(0));
    state
        .terminal_rows
        .insert(session_id.clone(), std::sync::atomic::AtomicU16::new(rows));
    let mut ss = crate::state::SessionState::default();
    if config.agent_type.is_some() {
        ss.agent_type = config.agent_type;
        ss.hook_instrumented = hook_instrumented_for(
            &crate::config::load_agents_config(),
            ss.agent_type.as_deref(),
        );
    }
    state.session_states.insert(session_id.clone(), ss);

    spawn_reader_thread(
        reader,
        paused,
        session_id.clone(),
        state.inner().clone(),
        tuic_session,
    );

    Ok(session_id)
}

/// Spawn a headless PTY session for agent orchestration (no Tauri command context).
/// Extracts AppHandle from `state.app_handle` and creates a minimal session.
pub(crate) async fn spawn_session_for_agent(
    state: &Arc<AppState>,
    cwd: Option<String>,
    display_name: Option<String>,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();
    let pty_system = native_pty_system();
    let rows: u16 = 24;
    let cols: u16 = 80;

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let shell = resolve_shell(None);
    let mut cmd = build_shell_command(&shell);

    if let Some(ref dir) = cwd {
        let expanded = crate::cli::expand_tilde(dir);
        cmd.cwd(expanded);
    }

    crate::shell_integration::inject(&state.data_dir, &shell, &mut cmd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;
    lower_pty_child_priority(child.process_id());

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let paused = Arc::new(AtomicBool::new(false));
    state.sessions.insert(
        session_id.clone(),
        Mutex::new(PtySession {
            writer,
            master: pair.master,
            _child: child,
            paused: paused.clone(),
            worktree: None,
            cwd,
            display_name: display_name.clone(),
            shell: shell.clone(),
        }),
    );
    state.assign_term_alias(&session_id);
    state.metrics.total_spawned.fetch_add(1, Ordering::Relaxed);
    state
        .metrics
        .active_sessions
        .fetch_add(1, Ordering::Relaxed);

    state.output_buffers.insert(
        session_id.clone(),
        Mutex::new(OutputRingBuffer::new(OUTPUT_RING_BUFFER_CAPACITY)),
    );
    let mut vt_log = VtLogBuffer::new(rows, cols, VT_LOG_BUFFER_CAPACITY);
    if let Some(colors) = state.ansi_colors.read().as_ref() {
        vt_log.set_ansi_colors(colors);
    }
    state
        .vt_log_buffers
        .insert(session_id.clone(), Mutex::new(vt_log));
    let (grid_watch_tx, _) = tokio::sync::watch::channel(Vec::new());
    state.grid_watch.insert(session_id.clone(), grid_watch_tx);
    state
        .last_output_ms
        .insert(session_id.clone(), AtomicU64::new(0));
    state
        .terminal_rows
        .insert(session_id.clone(), std::sync::atomic::AtomicU16::new(rows));
    state
        .session_states
        .insert(session_id.clone(), crate::state::SessionState::default());

    let _ = state
        .event_bus
        .send(crate::state::AppEvent::SessionCreated {
            session_id: session_id.clone(),
            cwd: state
                .sessions
                .get(&session_id)
                .and_then(|s| s.lock().cwd.clone()),
            agent_type: None,
            display_name: display_name.clone(),
        });
    #[cfg(feature = "desktop")]
    if let Some(ref a) = *state.app_handle.read() {
        let _ = a.emit(
            "session-created",
            serde_json::json!({
                "session_id": session_id,
                "display_name": display_name,
            }),
        );
    }

    spawn_reader_thread(reader, paused, session_id.clone(), state.clone(), None);

    Ok(session_id)
}

/// Create a PTY session with a dedicated git worktree
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn create_pty_with_worktree(
    _app: AppHandle,
    state: State<'_, Arc<AppState>>,
    pty_config: PtyConfig,
    worktree_config: WorktreeConfig,
) -> Result<WorktreeResult, String> {
    let pty_rows = pty_config.rows.max(24);
    let _pty_cols = pty_config.cols.max(80);
    // Create the worktree first
    let worktrees_dir = crate::worktree::resolve_worktree_dir_for_repo(
        std::path::Path::new(&worktree_config.base_repo),
        &state.worktrees_dir,
    );
    // Run the blocking git worktree calls off the async executor so a slow
    // checkout (LFS, large repo) doesn't stall other Tauri commands.
    // Uses the stale-recovery wrapper so orphaned directories are cleaned up
    // and retried automatically (single retry, no background task — PTY
    // creation is synchronous from the caller's perspective).
    let worktree = {
        let d = worktrees_dir.clone();
        let c = worktree_config.clone();
        tokio::task::spawn_blocking(move || create_worktree_with_stale_recovery(&d, &c, None))
            .await
            .map_err(|e| format!("create_worktree task panic: {e}"))??
    };
    let worktree_path = worktree.path.clone();

    // Wrap PTY creation so we can clean up the worktree on failure
    let pty_result = (|| -> Result<_, String> {
        let session_id = Uuid::new_v4().to_string();
        let pty_system = native_pty_system();

        // Guard against invalid dimensions from zero-sized windows
        let rows = pty_config.rows.max(24);
        let cols = pty_config.cols.max(80);

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        let shell = resolve_shell(pty_config.shell);

        let mut cmd = build_shell_command(&shell);
        cmd.cwd(&worktree_path);

        // Inject OSC 133 shell integration (command block markers)
        crate::shell_integration::inject(&state.data_dir, &shell, &mut cmd);

        // Inject env flags (feature flags configured in Settings → Agents)
        for (key, value) in &pty_config.env {
            cmd.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {e}"))?;
        lower_pty_child_priority(child.process_id());

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

        Ok((session_id, pair.master, child, writer, reader, shell))
    })();

    let (session_id, master, child, writer, reader, shell) = match pty_result {
        Ok(result) => result,
        Err(e) => {
            // Clean up the worktree since PTY creation failed
            if let Err(cleanup_err) = remove_worktree_internal(&worktree, false) {
                tracing::warn!("Failed to cleanup worktree after PTY failure: {cleanup_err}");
            }
            return Err(e);
        }
    };

    let branch = worktree.branch.clone();
    let worktree_cwd = Some(worktree.path.to_string_lossy().to_string());

    // Store session with worktree info (master handle kept for resize support)
    let paused = Arc::new(AtomicBool::new(false));
    state.sessions.insert(
        session_id.clone(),
        Mutex::new(PtySession {
            writer,
            master,
            _child: child,
            paused: paused.clone(),
            worktree: Some(worktree),
            cwd: worktree_cwd,
            display_name: None,
            shell,
        }),
    );
    state.assign_term_alias(&session_id);
    state.metrics.total_spawned.fetch_add(1, Ordering::Relaxed);
    state
        .metrics
        .active_sessions
        .fetch_add(1, Ordering::Relaxed);

    // Create ring buffer, VT log buffer, and diff renderer for this session
    state.output_buffers.insert(
        session_id.clone(),
        Mutex::new(OutputRingBuffer::new(OUTPUT_RING_BUFFER_CAPACITY)),
    );
    let mut vt_log = VtLogBuffer::new(24, 220, VT_LOG_BUFFER_CAPACITY);
    if let Some(colors) = state.ansi_colors.read().as_ref() {
        vt_log.set_ansi_colors(colors);
    }
    state
        .vt_log_buffers
        .insert(session_id.clone(), Mutex::new(vt_log));
    let (grid_watch_tx, _) = tokio::sync::watch::channel(Vec::new());
    state.grid_watch.insert(session_id.clone(), grid_watch_tx);
    state
        .last_output_ms
        .insert(session_id.clone(), std::sync::atomic::AtomicU64::new(0));
    state.terminal_rows.insert(
        session_id.clone(),
        std::sync::atomic::AtomicU16::new(pty_rows),
    );
    let mut ss = crate::state::SessionState::default();
    if pty_config.agent_type.is_some() {
        ss.agent_type = pty_config.agent_type;
        ss.hook_instrumented = hook_instrumented_for(
            &crate::config::load_agents_config(),
            ss.agent_type.as_deref(),
        );
    }
    state.session_states.insert(session_id.clone(), ss);

    spawn_reader_thread(
        reader,
        paused,
        session_id.clone(),
        state.inner().clone(),
        None,
    );

    Ok(WorktreeResult {
        session_id,
        worktree_path: worktree_path.to_string_lossy().to_string(),
        branch,
    })
}

/// List all active worktrees
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn list_worktrees(state: State<'_, Arc<AppState>>) -> Vec<serde_json::Value> {
    state
        .sessions
        .iter()
        .filter_map(|entry| {
            let session = entry.value().lock();
            session.worktree.as_ref().map(|wt| {
                serde_json::json!({
                    "session_id": entry.key(),
                    "name": wt.name,
                    "path": wt.path.to_string_lossy(),
                    "branch": wt.branch,
                    "base_repo": wt.base_repo.to_string_lossy(),
                })
            })
        })
        .collect()
}

/// Write data to a PTY session
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn write_pty(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
    // Keystroke delivery to the PTY: run on the high QoS band so the write (and
    // thus the echo round-trip) isn't starved by a saturating build. Idempotent
    // per call; bumps whichever blocking-pool thread serves this keystroke.
    raise_thread_for_interactive_io();
    // Restore cursor if hidden — Ink-based agents send DECTCEM hide for
    // spinners but may not send CNORM when returning to the prompt.
    // Best-effort try_lock: this is cosmetic (touches the local grid, not the PTY)
    // and MUST NOT block input delivery. Under an output flood the ticker
    // (serialize_dirty_rows) and reader thrash this same vt lock; a blocking lock
    // here would starve input. If contended, skip — the next frame restores the
    // cursor anyway.
    if let Some(vt) = state.vt_log_buffers.get(&session_id)
        && let Some(mut vt) = vt.try_lock()
        && !vt.is_cursor_visible()
    {
        vt.process(b"\x1b[?25h");
    }

    if let Some(entry) = state.sessions.get(&session_id) {
        tracing::trace!(session_id = %session_id, data_len = data.len(), "write_pty");
        if data.contains("\x1b[?1049") || data.contains("\x1b[?1047") || data.contains("\x1b[?47l") || data.contains("\x1b[?25h") {
            tracing::error!(source = "terminal", session_id = %session_id,
                "write_pty received DEC private mode sequences! data({} bytes)={:?}",
                data.len(), data.as_bytes().iter().take(200).collect::<Vec<_>>());
        }
        let t0 = std::time::Instant::now();
        {
            let mut session = entry.lock();
            let lock_ms = t0.elapsed().as_millis();
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Failed to write to PTY: {e}"))?;
            session
                .writer
                .flush()
                .map_err(|e| format!("Failed to flush PTY: {e}"))?;
            let total_ms = t0.elapsed().as_millis();
            if total_ms > 100 {
                tracing::warn!(session_id = %session_id, lock_ms = %lock_ms, total_ms = %total_ms,
                    data_len = %data.len(), "write_pty SLOW — lock or write blocked");
            }
        }

        // Stamp last-input time so the grid ticker can throttle frame sends while
        // the user types under CPU saturation (keeps the WebView thread free for
        // keystroke dispatch + echo).
        stamp_input_ms(&state, &session_id);
        crate::state::resolve_choice_prompt_input(&state, &session_id, &data);

        // Feed input through the line buffer to reconstruct user-typed lines
        // Release both the inner mutex and DashMap entry guard before callbacks
        // below. In particular, flush_pending_injections -> should_inject_now
        // reads input_buffers again; retaining input_entry there self-deadlocks
        // this shard and can park the entire IPC Tokio runtime under load.
        let (actions, buffer_content) = {
            let input_entry = state
                .input_buffers
                .entry(session_id.clone())
                .or_insert_with(|| parking_lot::Mutex::new(InputLineBuffer::new()));
            let mut buf = input_entry.lock();
            let actions = buf.feed(&data);
            let buffer_content = buf.content();
            (actions, buffer_content)
        };
        let mut line_submitted = false;
        for action in actions {
            match action {
                InputAction::Line(content) => {
                    line_submitted = true;
                    if !content.is_empty() {
                        note_submitted_input(&state, &session_id);
                        // Store as last relevant prompt if >= 10 words
                        let word_count = content.split_whitespace().count();
                        if word_count >= 10 {
                            state.last_prompts.insert(session_id.clone(), content.clone());
                        }
                        // Keystroke-reconstructed: no grid context, so no prompt
                        // row (line = -1). The scrollbar marker uses the OSC 7770
                        // state=busy path's absolute line instead.
                        let parsed = ParsedEvent::UserInput { content, line: -1 };
                        // Broadcast to SSE/WebSocket consumers
                        if let Ok(json) = serde_json::to_value(&parsed) {
                            state.emit_pty_event(crate::state::AppEvent::PtyParsed {
                                session_id: session_id.clone(),
                                parsed: json,
                            });
                        }
                        // Tauri IPC for desktop backward compat
                        let _ = app.emit(
                            &format!("pty-parsed-{session_id}"),
                            &parsed,
                        );

                        // Suppress silence-based question detection for user-typed lines.
                        // The PTY will echo this input back — without suppression, a line
                        // ending with `?` would be mistaken for an agent question prompt.
                        if let Some(ss) = state.silence_states.get(&session_id) {
                            ss.lock().suppress_user_input();
                        }
                    }
                }
                InputAction::Interrupt => {
                    line_submitted = true;
                    if let Some(ss) = state.silence_states.get(&session_id) {
                        ss.lock().note_interrupt_requested();
                    }
                }
            }
        }
        // Codex advertises Escape as its normal interrupt key. A bare Escape is
        // only intent evidence; it never flips idle until the agent redraws an
        // interrupted/ready prompt. CSI-prefixed navigation keys are excluded.
        if data == "\x1b"
            && let Some(ss) = state.silence_states.get(&session_id)
        {
            ss.lock().note_interrupt_requested();
        }

        // On any line submit (Enter or Ctrl+C) reset the tool-error dedup
        // memory: the user is explicitly engaging again, so a recurrence of
        // the same failure in a later turn must be allowed to notify.
        // Mirrors `OutputParser`'s reset of `last_api_error_match` on UserInput.
        if line_submitted
            && let Some(ss) = state.silence_states.get(&session_id)
        {
            let mut sl = ss.lock();
            sl.reset_tool_error_memory();
            sl.reset_suggest_memory();
        }

        // Track slash command mode: true when the input buffer starts with /
        // Fallback: when ESC is sent before "/" (TerminalKeybar's handleSlash),
        // the InputLineBuffer consumes "/" as an unknown escape-sequence suffix
        // and never inserts it. Detect bare "/" writes that the buffer missed.
        let in_slash = if line_submitted {
            false
        } else {
            buffer_content.starts_with('/') || (buffer_content.is_empty() && data == "/")
        };
        state
            .slash_mode
            .entry(session_id.clone())
            .or_insert_with(|| std::sync::atomic::AtomicBool::new(false))
            .store(in_slash, std::sync::atomic::Ordering::Relaxed);

        if buffer_content.is_empty() {
            flush_pending_injections(&state, &session_id);
        }

        Ok(())
    } else {
        Err("Session not found".to_string())
    }
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Return the current content of the input line buffer for a PTY session.
/// Empty string when the user has not started typing.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_input_buffer_content(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> String {
    state
        .input_buffers
        .get(&session_id)
        .map(|entry| entry.lock().content())
        .unwrap_or_default()
}

/// Get the last relevant user prompt (>= 10 words) for a PTY session.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_last_prompt(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Option<String> {
    state.last_prompts.get(&session_id).map(|v| v.clone())
}

/// Get the current shell state for a PTY session.
/// Used by the frontend on remount to sync state missed while unsubscribed.
/// Returns "busy", "idle", or null (session never produced output / removed).
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_shell_state(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Option<String> {
    state
        .shell_states
        .get(&session_id)
        .map(|atom| shell_state_str(atom.load(std::sync::atomic::Ordering::Relaxed)).to_string())
}

/// Return the classified shell family for a PTY session.
/// Lets the frontend pick the correct control sequences (e.g. Ctrl-U as
/// line-kill for POSIX readline vs. literal-char on cmd.exe/PowerShell)
/// without re-deriving the classification on every keystroke.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_session_shell_family(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Option<ShellFamily> {
    state
        .sessions
        .get(&session_id)
        .map(|entry| classify_shell(&entry.lock().shell))
}

/// Shared resize core for the Tauri command and the HTTP route (story 056-7545).
///
/// Order matters: the grid must adopt the new dimensions BEFORE the PTY ioctl
/// delivers SIGWINCH to the child. With the old PTY-first order the child could
/// repaint for the new width while the grid still wrapped at the old one (the
/// window grows with vt-lock contention under bursty output); wide lines then
/// autowrapped in the narrow grid, breaking Ink's cursor-up arithmetic and
/// stranding intermediate render rows in scrollback as duplicated blocks.
///
/// Same-dims calls are a no-op (returns None): they would otherwise deliver a
/// gratuitous SIGWINCH (full Ink repaint) per redundant caller (MCP/HTTP/multi
/// -client — the desktop frontend already guards, others don't).
///
/// Returns the post-resize full frame to flush, if the grid was resized.
pub(crate) fn resize_session_core(
    state: &AppState,
    session_id: &str,
    rows: u16,
    cols: u16,
) -> Result<Option<Vec<u8>>, String> {
    if rows == 0 || cols == 0 {
        return Err("Invalid dimensions: rows and cols must be > 0".to_string());
    }
    // Serialize the whole grid+PTY resize for this session under one lock so two
    // concurrent differing resizes (Tauri `resize_pty` + HTTP route) cannot interleave
    // their two critical sections and leave the grid and PTY at mismatched dimensions
    // (CONC-B, story 100-e303). Clone the Arc and drop the DashMap Ref before locking
    // so we never hold a `resize_locks` shard guard across the resize.
    let resize_lock = state
        .resize_locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new((0, 0))))
        .clone();
    let mut applied = resize_lock.lock();
    // Seed the last-applied dims from the live grid the first time we see this session:
    // at creation the grid and PTY share the openpty size, so a first resize that only
    // matches the startup dims no-ops instead of firing a gratuitous SIGWINCH. `(0, 0)`
    // is the never-applied sentinel (real dims are guarded > 0 above).
    if *applied == (0, 0)
        && let Some(vt_log) = state.vt_log_buffers.get(session_id)
    {
        let vt = vt_log.lock();
        *applied = (vt.grid_screen_lines() as u16, vt.grid_columns() as u16);
    }
    // No-op guard compares against the last dims that actually reached the PTY, not just
    // the grid: a prior call that resized the grid but then failed `master.resize` leaves
    // them divergent, and a grid-only guard would skip the PTY forever (CONC-B criterion 2).
    if *applied == (rows, cols) {
        return Ok(None);
    }
    // Pass shell_state so reflow can be smarter: idle → All, busy → HistoryOnly.
    let shell_state = state
        .shell_states
        .get(session_id)
        .map(|a| a.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(SHELL_NULL);
    // Resize the grid and capture a fresh full frame, holding the vt lock so no
    // PTY chunk can land between the check and the resize. `resize_with_shell_state`
    // marks the grid fully damaged, so `serialize_dirty_rows` yields the whole
    // viewport. The caller must flush it: the reader thread only sends frames on
    // PTY data or the ticker, so a resize/zoom over idle or static content would
    // otherwise leave the viewport blank until a scroll forces
    // `terminal_request_frame`. If the grid already matches (PTY-only retry after a
    // prior `master.resize` failure) skip the grid work but still re-apply the PTY.
    let resize_frame = match state.vt_log_buffers.get(session_id) {
        Some(vt_log) => {
            let mut vt = vt_log.lock();
            if vt.grid_screen_lines() == rows as usize && vt.grid_columns() == cols as usize {
                None
            } else {
                vt.resize_with_shell_state(rows, cols, shell_state);
                Some(vt.serialize_dirty_rows())
            }
        }
        None => None,
    };
    // Update terminal rows for cursor-up clamping in the reader thread.
    if let Some(r) = state.terminal_rows.get(session_id) {
        r.store(rows, Ordering::Relaxed);
    }
    // Mark resize in silence state so the reader thread suppresses re-parsed events
    // from the shell's prompt redraw triggered by SIGWINCH.
    if let Some(ss) = state.silence_states.get(session_id) {
        ss.lock().on_resize();
    }
    // Only now signal the child (TIOCSWINSZ → SIGWINCH): everything it repaints
    // from here on meets a grid that already wraps at the new width.
    let entry = state
        .sessions
        .get(session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    entry
        .lock()
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {e}"))?;
    // Record the dims only now that they've reached the PTY, still under `applied`, so
    // a racing resize either waits behind this lock or observes a consistent value.
    // On a `master.resize` failure above we return via `?` WITHOUT updating `applied`,
    // so a later retry re-applies the PTY instead of no-opping on a grid-only match.
    *applied = (rows, cols);
    Ok(resize_frame)
}

/// Enable or disable VT100 diff rendering for a PTY session.
/// Resize a PTY session
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn resize_pty(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let resize_frame = resize_session_core(&state, &session_id, rows, cols)?;
    // Flush the post-resize frame so the viewport repaints without waiting for the
    // next PTY data event (fixes blank screen after zoom on static content).
    if let Some(frame) = resize_frame {
        send_grid_frame(&state, &session_id, frame);
    }
    Ok(())
}

/// Apply theme ANSI colors (indices 0-15) to all terminal grids.
/// Each color is a `[r, g, b]` triple. Called by the frontend when the theme changes.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn set_ansi_colors(
    state: State<'_, Arc<AppState>>,
    colors: [[u8; 3]; 16],
) -> Result<(), String> {
    *state.ansi_colors.write() = Some(colors);
    for entry in state.vt_log_buffers.iter() {
        entry.value().lock().set_ansi_colors(&colors);
    }
    Ok(())
}

/// Pause PTY reader thread (flow control: frontend buffer full)
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn pause_pty(state: State<'_, Arc<AppState>>, session_id: String) -> Result<(), String> {
    let entry = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    entry.lock().paused.store(true, Ordering::Relaxed);
    state
        .metrics
        .pauses_triggered
        .fetch_add(1, Ordering::Relaxed);
    tracing::debug!(session_id = %session_id, "PTY reader paused (flow control)");
    Ok(())
}

/// Resume PTY reader thread (flow control: frontend buffer drained)
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn resume_pty(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<(), String> {
    let entry = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    entry.lock().paused.store(false, Ordering::Relaxed);
    #[cfg(unix)]
    if let Err(e) = wake_session(&state, &session_id) {
        tracing::debug!(session_id = %session_id, error = %e, "Wake on resume (may not be in standby)");
    }
    tracing::debug!(session_id = %session_id, "PTY reader resumed (flow control)");
    Ok(())
}

/// Periodically checks all sessions for standby eligibility.
/// A session enters standby when:
/// 1. standby_timeout_minutes > 0
/// 2. session_visibility == false (tab not focused)
/// 3. shell_state == SHELL_IDLE
/// 4. idle duration >= timeout
/// 5. not already in standby
/// 6. startup_settled == true
#[cfg(unix)]
fn background_activity_blocks_standby(state: &AppState, session_id: &str) -> bool {
    state
        .session_states
        .get(session_id)
        .is_some_and(|session| session.background_work || session.has_pending_background_probe())
}

#[cfg(unix)]
pub(crate) fn spawn_standby_checker(state: Arc<AppState>) {
    use std::time::Duration;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let timeout_min = state.config.read().standby_timeout_minutes;
            if timeout_min == 0 {
                // Standby disabled: wake any sessions still parked (SIGSTOP'd)
                // from a previous non-zero timeout. Otherwise their stopped
                // badge persists until the user manually focuses each tab
                // (to-test.md:236, story 095).
                wake_all_standby(&state);
                continue;
            }
            let timeout_ms = u64::from(timeout_min) * 60_000;
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            let vis_count = state.session_visibility.len();
            let sessions_count = state.sessions.len();
            tracing::trace!(
                vis_count,
                sessions_count,
                timeout_min,
                "Standby checker tick"
            );

            for entry in state.session_visibility.iter() {
                let session_id = entry.key();
                let visible = *entry.value();
                if visible {
                    continue;
                }
                if state.standby_sessions.contains_key(session_id.as_str()) {
                    continue;
                }

                let shell_raw = state
                    .shell_states
                    .get(session_id.as_str())
                    .map(|a| a.load(Ordering::Acquire));
                let is_idle = shell_raw == Some(SHELL_IDLE);
                if !is_idle {
                    continue;
                }

                // For agents with a verified ready-screen adapter, a silence-only
                // idle is not strong enough to SIGSTOP the process group. Require
                // explicit Stop/OSC or a stable ready screen. Legacy agents that
                // lack an adapter retain their prior timeout behavior.
                let is_agent = state
                    .session_states
                    .get(session_id.as_str())
                    .map(|s| s.agent_type.is_some())
                    .unwrap_or(false);
                if is_agent && !idle_is_confirmed(&state, session_id.as_str()) {
                    tracing::trace!(
                        session_id = session_id.as_str(),
                        "Standby skipped: agent idle is heuristic-only"
                    );
                    continue;
                }
                if background_activity_blocks_standby(&state, session_id.as_str()) {
                    tracing::trace!(
                        session_id = session_id.as_str(),
                        "Standby skipped: background work or probe pending"
                    );
                    continue;
                }

                let idle_since = state
                    .shell_state_since_ms
                    .get(session_id.as_str())
                    .map(|a| a.load(Ordering::Acquire))
                    .unwrap_or(now_ms);
                let idle_ms = now_ms.saturating_sub(idle_since);
                if idle_ms < timeout_ms {
                    continue;
                }

                let settled = state
                    .silence_states
                    .get(session_id.as_str())
                    .map(|e| e.lock().startup_settled)
                    .unwrap_or(false);
                if !settled {
                    continue;
                }

                tracing::debug!(
                    session_id = session_id.as_str(),
                    idle_ms,
                    "Standby: all conditions met, stopping"
                );
                if let Err(e) = standby_session(&state, session_id) {
                    tracing::warn!(session_id, error = %e, "Standby failed");
                }
            }
        }
    });
}

/// SIGSTOP the entire process group of a session.
/// Returns Ok(true) if stopped, Ok(false) if already in standby or session gone.
#[cfg(unix)]
pub(crate) fn standby_session(state: &AppState, session_id: &str) -> Result<bool, String> {
    if state.standby_sessions.contains_key(session_id) {
        return Ok(false);
    }
    // Serialize the final eligibility check with background-work updates. This
    // closes the gap between the periodic check above and the actual SIGSTOP.
    let silence = state
        .silence_states
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(SilenceState::new())))
        .clone();
    let _lifecycle_guard = silence.lock();
    if background_activity_blocks_standby(state, session_id) {
        return Ok(false);
    }
    let pgid = {
        let entry = state
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let session = entry.value().lock();
        session
            .master
            .process_group_leader()
            .ok_or_else(|| "No process group leader".to_string())?
    };
    if pgid <= 1 || pgid == unsafe { libc::getpgid(0) } {
        return Err(format!("Unsafe pgid {pgid} — refusing SIGSTOP"));
    }
    let ret = unsafe { libc::kill(-pgid, libc::SIGSTOP) };
    if ret != 0 {
        return Err(format!(
            "SIGSTOP failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    state.standby_sessions.insert(session_id.to_string(), now);
    tracing::info!(session_id, pgid, "Session entered standby (SIGSTOP)");
    emit_standby_event(state, session_id, true);
    Ok(true)
}

/// SIGCONT a session in standby. Returns Ok(true) if woken, Ok(false) if not in standby.
#[cfg(unix)]
pub(crate) fn wake_session(state: &AppState, session_id: &str) -> Result<bool, String> {
    if state.standby_sessions.remove(session_id).is_none() {
        return Ok(false);
    }
    let pgid = {
        let entry = state
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session not found: {session_id}"))?;
        let session = entry.value().lock();
        session
            .master
            .process_group_leader()
            .ok_or_else(|| "No process group leader".to_string())?
    };
    let ret = unsafe { libc::kill(-pgid, libc::SIGCONT) };
    if ret != 0 {
        return Err(format!(
            "SIGCONT failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    tracing::info!(session_id, pgid, "Session woken from standby (SIGCONT)");
    emit_standby_event(state, session_id, false);
    Ok(true)
}

/// Wake every session currently in standby. Used when the user disables standby
/// (timeout=0) so already-parked sessions resume instead of staying SIGSTOP'd.
/// Returns the number of sessions for which a wake was attempted.
///
/// Keys are collected into a Vec first: `wake_session` calls
/// `standby_sessions.remove`, and mutating a DashMap while holding an `iter()`
/// shard guard on the same map deadlocks. A session killed between the snapshot
/// and the wake is handled by `wake_session` (removes its entry, then returns
/// Err on the missing session — no panic).
#[cfg(unix)]
pub(crate) fn wake_all_standby(state: &AppState) -> usize {
    let parked: Vec<String> = state
        .standby_sessions
        .iter()
        .map(|e| e.key().clone())
        .collect();
    for session_id in &parked {
        if let Err(e) = wake_session(state, session_id) {
            tracing::warn!(session_id, error = %e, "Standby wake-all (timeout=0) failed");
        }
    }
    parked.len()
}

#[cfg(unix)]
fn emit_standby_event(state: &AppState, session_id: &str, standby: bool) {
    #[cfg(feature = "desktop")]
    if let Some(ref app) = *state.app_handle.read() {
        let _ = app.emit(
            "session-standby",
            serde_json::json!({
                "session_id": session_id,
                "standby": standby,
            }),
        );
    }
}

#[cfg(all(test, unix))]
mod standby_tests {
    use super::*;

    /// timeout=0 must wake ALL parked sessions. Entries with no live session
    /// (the "killed between listing and wake" case) must not panic — each is
    /// removed from the map before wake_session errors on the missing session.
    #[test]
    fn wake_all_standby_clears_every_parked_session() {
        let state = crate::state::tests_support::make_test_app_state();
        state.standby_sessions.insert("gone-1".to_string(), 111);
        state.standby_sessions.insert("gone-2".to_string(), 222);
        state.standby_sessions.insert("gone-3".to_string(), 333);

        let attempted = wake_all_standby(&state);

        assert_eq!(attempted, 3, "wake attempted for every parked session");
        assert!(
            state.standby_sessions.is_empty(),
            "standby map must be empty after wake-all even when the sessions are gone"
        );
    }

    /// Empty standby map is a no-op — no panic, nothing to wake.
    #[test]
    fn wake_all_standby_empty_is_noop() {
        let state = crate::state::tests_support::make_test_app_state();
        assert_eq!(wake_all_standby(&state), 0);
        assert!(state.standby_sessions.is_empty());
    }

    /// After a timeout=0 wake-all, standby can re-arm normally when the user
    /// sets a positive timeout again — wake_all_standby sets no persistent
    /// "disabled" flag, it only clears the current standby set.
    #[test]
    fn wake_all_standby_leaves_map_ready_to_rearm() {
        let state = crate::state::tests_support::make_test_app_state();
        state.standby_sessions.insert("gone-1".to_string(), 111);
        wake_all_standby(&state);
        assert!(state.standby_sessions.is_empty());

        // Re-arming (as the checker would on the next tick with timeout>0) works.
        state.standby_sessions.insert("re-armed".to_string(), 444);
        assert_eq!(state.standby_sessions.len(), 1);
    }
}

/// Query current kitty keyboard protocol flags for a session.
/// Returns 0 if the session has no kitty state (protocol not activated).
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_kitty_flags(state: State<'_, Arc<AppState>>, session_id: String) -> u32 {
    state
        .kitty_states
        .get(&session_id)
        .map(|entry| entry.lock().current_flags())
        .unwrap_or(0)
}

/// SIGKILL the foreground process group of a PTY session.
///
/// An agent (e.g. claude) runs as a *grandchild* inside the PTY's shell and, under
/// job control, sits in its own foreground process group. SIGKILL on the shell
/// alone leaves that group orphaned — the cloned reader fd keeps the pty master
/// open, so the kernel never delivers SIGHUP to the foreground group, and the
/// agent is reparented to init and keeps running. killpg nukes the agent plus
/// every descendant in one shot. The shell (the session leader, in its own
/// process group) is reaped separately by the caller's `_child.kill()`.
#[cfg(unix)]
fn kill_foreground_process_group(session: &PtySession, session_id: &str) {
    let Some(pgid) = session.master.process_group_leader() else {
        return;
    };
    // Never signal pid <= 1 or our own group — that would take down TUIC itself.
    if pgid <= 1 || pgid == unsafe { libc::getpgid(0) } {
        tracing::warn!(session_id, pgid, "Refusing killpg on unsafe pgid");
        return;
    }
    if unsafe { libc::kill(-pgid, libc::SIGKILL) } != 0 {
        let err = std::io::Error::last_os_error();
        // ESRCH just means the group already exited — not worth a warning.
        if err.raw_os_error() != Some(libc::ESRCH) {
            tracing::warn!(session_id, pgid, "killpg(SIGKILL) failed: {err}");
        }
    }
}

/// Close a PTY session core: sends Ctrl-C, waits briefly for graceful exit,
/// captures the exit code for the tombstone, and leaves `output_buffers` +
/// `vt_log_buffers` + `last_output_ms` + `exit_codes` alive so post-mortem
/// MCP reads can still return final output and exit status.
///
/// Shared between the Tauri `close_pty` command and the MCP `close` action —
/// both paths must tombstone identically, or post-mortem reads break.
/// Returns the worktree path when `cleanup_worktree` is true and the session
/// had one, so the caller can run `remove_worktree_internal` outside this fn.
pub(crate) fn close_pty_core(
    state: &AppState,
    session_id: &str,
    cleanup_worktree: bool,
) -> Option<crate::state::WorktreeInfo> {
    let (_, session_mutex) = state.sessions.remove(session_id)?;
    state
        .metrics
        .active_sessions
        .fetch_sub(1, Ordering::Relaxed);
    let mut session = session_mutex.into_inner();

    // Send Ctrl-C (0x03) to give the process a chance to clean up
    let _ = session.writer.write_all(&[0x03]);
    let _ = session.writer.flush();

    // Wait up to 100ms for process to exit gracefully
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
    loop {
        match session._child.try_wait() {
            Ok(Some(_)) => break, // Process exited cleanly
            Ok(None) if std::time::Instant::now() >= deadline => break,
            _ => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    }

    // If the child is still alive after the grace window, force-kill it.
    // Without this, agents that ignore Ctrl-C (e.g. claude) become orphans —
    // the cloned reader fd keeps the pty master alive, the slave never sees
    // EOF, and the reader thread spins forever.
    if matches!(session._child.try_wait(), Ok(None)) {
        // Nuke the agent's foreground process group first; SIGKILL on the shell
        // alone leaves the agent (a grandchild) orphaned. See
        // kill_foreground_process_group.
        #[cfg(unix)]
        kill_foreground_process_group(&session, session_id);

        if let Err(e) = session._child.kill() {
            tracing::warn!(session_id = %session_id, "close_pty_core SIGKILL fallback failed: {e}");
        }
        // Brief wait so try_wait can observe the termination and record the code.
        let kill_deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
        loop {
            match session._child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() >= kill_deadline => break,
                _ => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        }
    }

    // Capture exit code for the tombstone before dropping the child handle.
    if let Ok(Some(status)) = session._child.try_wait() {
        state
            .exit_codes
            .insert(session_id.to_string(), status.exit_code() as i32);
    }

    // Preserve output_buffers, vt_log_buffers, last_output_ms, exit_codes.
    // Tombstone sweeper reaps them after TOMBSTONE_TTL_MS.
    tombstone_transient_cleanup(session_id, state);

    let worktree_to_cleanup = if cleanup_worktree {
        session.worktree.clone()
    } else {
        None
    };

    // Drop session to release file handles (forcibly kills if still running)
    drop(session);

    worktree_to_cleanup
}

/// Force-kill a PTY session and tombstone it. Used by the MCP `kill` action.
/// Unlike `close_pty_core`, skips the Ctrl-C grace period — sends SIGKILL
/// immediately. The child exits near-instantly so `try_wait` captures the
/// exit code before the tombstone is stamped.
pub(crate) fn kill_pty_core(state: &AppState, session_id: &str) -> bool {
    let Some((_, session_mutex)) = state.sessions.remove(session_id) else {
        return false;
    };
    state
        .metrics
        .active_sessions
        .fetch_sub(1, Ordering::Relaxed);
    let mut session = session_mutex.into_inner();

    // Nuke the agent's foreground process group first; SIGKILL on the shell
    // alone leaves the agent (a grandchild) orphaned. See
    // kill_foreground_process_group.
    #[cfg(unix)]
    kill_foreground_process_group(&session, session_id);

    if let Err(e) = session._child.kill() {
        tracing::warn!(session_id = %session_id, "SIGKILL failed: {e}");
    }

    // Give the kernel a brief window to reap the child so try_wait sees it.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
    loop {
        match session._child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => break,
            _ => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    }

    if let Ok(Some(status)) = session._child.try_wait() {
        state
            .exit_codes
            .insert(session_id.to_string(), status.exit_code() as i32);
    }

    tombstone_transient_cleanup(session_id, state);
    drop(session);
    true
}

/// Close a PTY session with graceful shutdown and optional worktree cleanup.
/// Sends Ctrl-C (0x03) and waits briefly for the process to exit cleanly
/// before forcibly dropping handles.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn close_pty(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    cleanup_worktree: bool,
) -> Result<(), String> {
    if let Some(worktree) = close_pty_core(&state, &session_id, cleanup_worktree)
        && let Err(e) = remove_worktree_internal(&worktree, false)
    {
        tracing::warn!("Failed to cleanup worktree: {e}");
    }
    Ok(())
}

/// Look up the process name for a given PID using OS-native syscalls.
/// On macOS uses `proc_pidpath`, on Linux reads `/proc/{pid}/comm`.
/// Returns None if the lookup fails.
#[cfg(target_os = "macos")]
pub(crate) fn process_name_from_pid(pid: u32) -> Option<String> {
    let mut buf = [0u8; libc::MAXPATHLEN as usize];
    // SAFETY: proc_pidpath writes into the provided buffer up to buffersize bytes.
    // The buffer is stack-allocated with known size. pid is a valid u32 cast to i32.
    let ret = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if ret <= 0 {
        return None;
    }
    let path = std::str::from_utf8(&buf[..ret as usize]).ok()?;
    if let Some(agent_type) = classify_agent_name_or_path(path) {
        return Some(agent_type.to_string());
    }
    Some(normalized_process_name(path).to_string())
}

#[cfg(target_os = "linux")]
pub(crate) fn process_name_from_pid(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(windows)]
pub(crate) fn process_name_from_pid(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32, Process32First, Process32Next, TH32CS_SNAPPROCESS,
    };

    // SAFETY: CreateToolhelp32Snapshot/Process32First/Process32Next are Windows API
    // functions that operate on a process snapshot handle. We zero-initialize the
    // PROCESSENTRY32 struct and set dwSize before use (required by the API). The
    // snapshot handle is closed via CloseHandle before returning. All pointer
    // arguments point to stack-local owned memory with valid lifetimes.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return None;
        }

        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;

        let mut found = None;
        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID == pid {
                    // szExeFile is a [i8; 260] (MAX_PATH) null-terminated C string
                    let name_bytes: Vec<u8> = entry
                        .szExeFile
                        .iter()
                        .take_while(|&&b| b != 0)
                        .map(|&b| b as u8)
                        .collect();
                    // Use from_utf8_lossy to handle non-ASCII process names
                    // (e.g. apps with accented characters) instead of silently dropping them
                    let name = String::from_utf8_lossy(&name_bytes);
                    // Strip .exe suffix for consistent matching with classify_agent
                    let name = name.strip_suffix(".exe").unwrap_or(&name).to_string();
                    found = Some(name);
                    break;
                }
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);
        found
    }
}

/// Walk the process tree from `root_pid` and return the deepest descendant PID.
/// On Windows, this finds the "foreground" process in a PTY session by following
/// Normalize a path by resolving `.` and `..` components logically
/// (without requiring the path to exist on disk).
fn normalize_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut result = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            other => result.push(other),
        }
    }
    result
}

#[cfg(test)]
mod normalize_path_tests {
    use super::normalize_path;
    use std::path::Path;

    #[test]
    fn resolves_parent_segments() {
        let p = normalize_path(Path::new("/a/b/../../c/d"));
        assert_eq!(p, Path::new("/c/d"));
    }

    #[test]
    fn resolves_worktree_relative_plan() {
        let p = normalize_path(Path::new(
            "/home/user/repo__wt/feat/../../repo/plans/foo.md",
        ));
        assert_eq!(p, Path::new("/home/user/repo/plans/foo.md"));
    }

    #[test]
    fn strips_dot_segments() {
        let p = normalize_path(Path::new("/a/./b/./c"));
        assert_eq!(p, Path::new("/a/b/c"));
    }

    #[test]
    fn preserves_clean_path() {
        let p = normalize_path(Path::new("/home/user/plans/bar.md"));
        assert_eq!(p, Path::new("/home/user/plans/bar.md"));
    }
}

/// the chain: shell → agent CLI (e.g. claude.exe).
#[cfg(windows)]
pub(crate) fn deepest_descendant_pid(root_pid: u32) -> Option<u32> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32, Process32First, Process32Next, TH32CS_SNAPPROCESS,
    };

    // SAFETY: Same API contract as process_name_from_pid above. We take a full
    // process snapshot, iterate it to collect (pid, parent_pid) pairs into owned
    // Vecs, then close the handle. The PROCESSENTRY32 struct is zero-initialized
    // with dwSize set before the first call, satisfying the API precondition.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            return None;
        }

        // Collect all (pid, parent_pid) pairs and build parent->children map
        let mut children_map: std::collections::HashMap<u32, Vec<u32>> =
            std::collections::HashMap::new();
        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;

        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                children_map
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);

        // Walk from root_pid to the deepest single child — O(depth) via HashMap
        let mut current = root_pid;
        while let Some([only_child]) = children_map.get(&current).map(Vec::as_slice) {
            current = *only_child;
        }

        Some(current)
    }
}

/// Map a process name to a known agent type, or None for non-agent processes.
pub(crate) fn classify_agent(process_name: &str) -> Option<&'static str> {
    match process_name {
        "claude" => Some("claude"),
        "gemini" => Some("gemini"),
        "opencode" => Some("opencode"),
        "aider" => Some("aider"),
        "codex" => Some("codex"),
        "amp" => Some("amp"),
        "cursor-agent" => Some("cursor"),
        "goose" => Some("goose"),
        "grok" => Some("grok"),
        "droid" => Some("droid"),
        _ => None,
    }
}

/// Get the foreground process of a PTY session and classify it as a known agent.
/// Returns the agent name (e.g. "claude") or None if the foreground process is
/// not a recognized agent or the session doesn't exist.
///
/// When the foreground is a non-shell process that `classify_agent` doesn't
/// recognise (custom aliases, symlinks, wrapper scripts like "C2"), falls back
/// to the pre-set `session_states.agent_type` so run-config launches are
/// detected correctly without hardcoding every possible alias.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_session_foreground_process(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Option<String> {
    const SHELLS: &[&str] = &[
        "zsh",
        "bash",
        "fish",
        "sh",
        "dash",
        "ksh",
        "csh",
        "tcsh",
        "nushell",
        "nu",
        "powershell",
        "pwsh",
        "cmd",
    ];

    let (detected, fg_is_shell) = {
        let entry = state.sessions.get(&session_id)?;
        let session = entry.value().lock();
        #[cfg(not(windows))]
        {
            let pgid = session.master.process_group_leader()?;
            let name = process_name_from_pid(pgid as u32)?;
            let is_shell = SHELLS.contains(&name.as_str());
            (classify_agent(&name).map(|s| s.to_string()), is_shell)
        }
        #[cfg(windows)]
        {
            let child_pid = session._child.process_id()?;
            let leaf = deepest_descendant_pid(child_pid)?;
            let name = process_name_from_pid(leaf)?;
            let is_shell = SHELLS.contains(&name.as_str());
            (classify_agent(&name).map(|s| s.to_string()), is_shell)
        }
    };

    // Fallback: unrecognised non-shell foreground + pre-set agent type → use preset.
    // Covers custom commands (aliases, symlinks, wrappers) from run configs.
    let effective = detected.clone().or_else(|| {
        if fg_is_shell {
            return None;
        }
        state
            .session_states
            .get(&session_id)
            .and_then(|s| s.agent_type.clone())
    });

    // Mirror the detected agent type into session_states so the PTY reader's
    // `agent_active_for_parse` check flips on and plain-prefix structured
    // tokens (`intent:`, `action:`, `suggest:`) start being parsed. Without
    // this sync, sessions started by running `claude` inside a plain shell
    // (as opposed to via the /agent spawn route) never enable plain-prefix
    // parsing, so intents never rename the tab.
    //
    // Sticky: only set on Some, never clear on None. Foreground-pgid sampling
    // is inherently flaky during subprocess transitions — when claude spawns a
    // short-lived grandchild (git, sed, rg) the pgid leader briefly points to
    // that unrecognized binary and classify_agent returns None. Writing that
    // None back would flip agent_active off and drop the very next
    // `suggest:`/`intent:` token even though claude is still the live agent.
    // Frontend useAgentPolling.ts applies the same stickiness (streak +
    // source=idle) on its store mirror; backend must match or the parser
    // gates off while the UI still shows the agent active. Session teardown
    // clears session_states entirely, so no explicit reset is needed here.
    if let Some(mut entry) = state.session_states.get_mut(&session_id)
        && effective.is_some()
        && entry.agent_type != effective
    {
        entry.agent_type = effective.clone();
        entry.hook_instrumented = hook_instrumented_for(
            &crate::config::load_agents_config(),
            entry.agent_type.as_deref(),
        );
    }

    effective
}

/// Get the PID of the deepest foreground process in a PTY session.
///
/// On Unix: uses the process group leader to find the foreground process.
/// On Windows: walks the process tree from the child PID to the deepest descendant.
///
/// Returns `None` if the session doesn't exist or the process has exited.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_session_leaf_pid(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Option<u32> {
    let entry = state.sessions.get(&session_id)?;
    let session = entry.value().lock();
    #[cfg(not(windows))]
    {
        let pgid = session.master.process_group_leader()?;
        Some(pgid as u32)
    }
    #[cfg(windows)]
    {
        let child_pid = session._child.process_id()?;
        deepest_descendant_pid(child_pid)
    }
}

/// Check if a PTY session has a non-shell foreground process running.
/// Returns the process name (e.g. "htop", "node", "claude") or None if
/// the foreground is the shell itself (zsh, bash, fish, etc.).
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn has_foreground_process(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Option<String> {
    const SHELLS: &[&str] = &[
        "zsh",
        "bash",
        "fish",
        "sh",
        "dash",
        "ksh",
        "csh",
        "tcsh",
        "nushell",
        "nu",
        "powershell",
        "pwsh",
        "cmd",
    ];
    let entry = state.sessions.get(&session_id)?;
    // Extract pid under lock, then drop before the blocking syscall
    #[cfg(not(windows))]
    let pid = {
        let session = entry.value().lock();
        let pgid = session.master.process_group_leader()?;
        u32::try_from(pgid).ok()?
    };
    #[cfg(windows)]
    let pid = {
        let session = entry.value().lock();
        let child_pid = session._child.process_id()?;
        deepest_descendant_pid(child_pid)?
    };
    let name = process_name_from_pid(pid)?;
    if SHELLS.contains(&name.as_str()) {
        None
    } else {
        Some(name)
    }
}

/// Debug: diagnose agent detection for a PTY session.
/// Returns each step of the detection pipeline so failures can be pinpointed.
/// Diagnostic-only command — no frontend caller; kept as a debug escape hatch
/// for investigating agent classification mismatches in production.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn debug_agent_detection(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> serde_json::Value {
    let entry = match state.sessions.get(&session_id) {
        Some(e) => e,
        None => {
            return serde_json::json!({ "error": "session not found", "session_id": session_id });
        }
    };
    let session = entry.value().lock();

    #[cfg(not(windows))]
    {
        let raw_fd = session.master.as_raw_fd();
        let pgid = session.master.process_group_leader();
        let name = pgid.and_then(|p| process_name_from_pid(p as u32));
        let classified = name.as_deref().and_then(classify_agent);
        serde_json::json!({
            "session_id": session_id,
            "master_raw_fd": raw_fd,
            "process_group_leader": pgid,
            "process_name": name,
            "classified_agent": classified,
            "child_pid": session._child.process_id(),
        })
    }
    #[cfg(windows)]
    {
        let child_pid = session._child.process_id();
        let leaf = child_pid.and_then(deepest_descendant_pid);
        let name = leaf.and_then(process_name_from_pid);
        let classified = name.as_deref().and_then(classify_agent);
        serde_json::json!({
            "session_id": session_id,
            "child_pid": child_pid,
            "leaf_pid": leaf,
            "process_name": name,
            "classified_agent": classified,
        })
    }
}

/// Get orchestrator stats
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_orchestrator_stats(state: State<'_, Arc<AppState>>) -> OrchestratorStats {
    state.orchestrator_stats()
}

/// Get PTY session metrics for observability
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_session_metrics(state: State<'_, Arc<AppState>>) -> serde_json::Value {
    state.session_metrics_json()
}

/// Check if we can spawn a new session
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn can_spawn_session(state: State<'_, Arc<AppState>>) -> bool {
    state.sessions.len() < MAX_CONCURRENT_SESSIONS
}

/// Info about an active PTY session for frontend reconnection
#[derive(Clone, Serialize)]
pub(crate) struct ActiveSessionInfo {
    session_id: String,
    cwd: Option<String>,
    worktree_path: Option<String>,
    worktree_branch: Option<String>,
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<crate::state::SessionState>,
}

/// Update the working directory of a running PTY session.
/// Called from the frontend when an OSC 7 escape sequence is detected,
/// keeping the Rust-side cwd in sync for restart recovery.
// DEFERRED (2026-05-14) — wire to frontend OSC 7 handler (handleTerminalCwdChange).
// Without this, restart recovery uses stale launch-time cwd.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn update_session_cwd(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    cwd: String,
) -> Result<(), String> {
    let path = std::path::Path::new(&cwd);
    if !path.is_absolute() {
        return Err("cwd must be an absolute path".into());
    }
    if cwd.contains('\0') {
        return Err("cwd must not contain null bytes".into());
    }
    let entry = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    entry.lock().cwd = Some(cwd);
    Ok(())
}

/// Set the display name of a PTY session (syncs tab title to backend for PWA visibility).
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn set_session_name(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    name: Option<String>,
) -> Result<(), String> {
    let entry = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {session_id}"))?;
    entry.lock().display_name = name;
    Ok(())
}

/// List all active PTY sessions for reconnection after frontend reload
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn list_active_sessions(state: State<'_, Arc<AppState>>) -> Vec<ActiveSessionInfo> {
    state
        .sessions
        .iter()
        .map(|entry| {
            let session_id = entry.key().clone();
            let session = entry.value().lock();
            ActiveSessionInfo {
                session_id,
                cwd: session.cwd.clone(),
                worktree_path: session
                    .worktree
                    .as_ref()
                    .map(|w| w.path.to_string_lossy().to_string()),
                worktree_branch: session.worktree.as_ref().and_then(|w| w.branch.clone()),
                display_name: session.display_name.clone(),
                state: state.session_state_with_shell(entry.key()),
            }
        })
        .collect()
}

/// Per-process resource usage for the process manager modal.
#[derive(Clone, Serialize)]
pub(crate) struct ProcessStats {
    pub(crate) session_id: Option<String>,
    pub(crate) name: String,
    pub(crate) pid: u32,
    pub(crate) rss_kb: u64,
    pub(crate) cpu_pct: f32,
}

/// Collect CPU/memory stats for TUIC itself and all PTY child process trees.
pub(crate) fn collect_process_stats(state: &AppState) -> Vec<ProcessStats> {
    let mut pids: Vec<(Option<String>, String, u32)> = Vec::new();

    // TUIC's own process
    let own_pid = std::process::id();
    pids.push((None, "FastAF".to_string(), own_pid));

    // Collect child PIDs from all PTY sessions
    for entry in state.sessions.iter() {
        let session_id = entry.key().clone();
        let session = entry.value().lock();
        let display = session
            .display_name
            .clone()
            .unwrap_or_else(|| session_id.chars().take(8).collect());

        #[cfg(not(windows))]
        let child_pid = session.master.process_group_leader().map(|p| p as u32);
        #[cfg(windows)]
        let child_pid = session._child.process_id();

        if let Some(pid) = child_pid {
            pids.push((Some(session_id.clone()), display.clone(), pid));
            // Walk descendants
            if let Some(descendants) = collect_descendant_pids(pid) {
                for dpid in descendants {
                    let name = process_name_from_pid(dpid).unwrap_or_else(|| format!("pid:{dpid}"));
                    pids.push((Some(session_id.clone()), name, dpid));
                }
            }
        }
    }

    if pids.is_empty() {
        return vec![];
    }

    let pid_list: Vec<u32> = pids.iter().map(|(_, _, p)| *p).collect();
    let stats_map = query_process_stats(&pid_list);

    pids.into_iter()
        .map(|(sid, name, pid)| {
            let (rss_kb, cpu_pct) = stats_map.get(&pid).copied().unwrap_or((0, 0.0));
            ProcessStats {
                session_id: sid,
                name,
                pid,
                rss_kb,
                cpu_pct,
            }
        })
        .collect()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn get_process_stats(state: State<'_, Arc<AppState>>) -> Vec<ProcessStats> {
    collect_process_stats(&state)
}

/// Collect all descendant PIDs of a process (excluding the root itself).
fn collect_descendant_pids(root: u32) -> Option<Vec<u32>> {
    #[cfg(not(windows))]
    {
        let output = std::process::Command::new("ps")
            .args(["-eo", "pid,ppid"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let mut parent_map: std::collections::HashMap<u32, Vec<u32>> =
            std::collections::HashMap::new();
        for line in text.lines().skip(1) {
            let mut parts = line.split_whitespace();
            let pid: u32 = parts.next()?.parse().ok()?;
            let ppid: u32 = parts.next()?.parse().ok()?;
            parent_map.entry(ppid).or_default().push(pid);
        }
        let mut result = Vec::new();
        let mut stack = vec![root];
        while let Some(p) = stack.pop() {
            if let Some(children) = parent_map.get(&p) {
                for &child in children {
                    result.push(child);
                    stack.push(child);
                }
            }
        }
        Some(result)
    }
    #[cfg(windows)]
    {
        // On Windows, deepest_descendant_pid already walks the tree.
        // Reuse the snapshot logic to collect all descendants.
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap.is_null() {
            return None;
        }
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut parent_map: std::collections::HashMap<u32, Vec<u32>> =
            std::collections::HashMap::new();
        if unsafe { Process32FirstW(snap, &mut entry) } != 0 {
            loop {
                parent_map
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
                if unsafe { Process32NextW(snap, &mut entry) } == 0 {
                    break;
                }
            }
        }
        let _ = unsafe { CloseHandle(snap) };
        let mut result = Vec::new();
        let mut stack = vec![root];
        while let Some(p) = stack.pop() {
            if let Some(children) = parent_map.get(&p) {
                for &child in children {
                    result.push(child);
                    stack.push(child);
                }
            }
        }
        Some(result)
    }
}

/// Query RSS (KB) and CPU% for a batch of PIDs using `ps` on Unix.
#[cfg(not(windows))]
fn query_process_stats(pids: &[u32]) -> std::collections::HashMap<u32, (u64, f32)> {
    let mut map = std::collections::HashMap::new();
    if pids.is_empty() {
        return map;
    }
    let pid_args: Vec<String> = pids.iter().map(|p| p.to_string()).collect();
    let Ok(output) = std::process::Command::new("ps")
        .args(["-o", "pid,rss,%cpu", "-p"])
        .arg(pid_args.join(","))
        .output()
    else {
        return map;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3
            && let (Ok(pid), Ok(rss), Ok(cpu)) = (
                parts[0].parse::<u32>(),
                parts[1].parse::<u64>(),
                parts[2].parse::<f32>(),
            )
        {
            map.insert(pid, (rss, cpu));
        }
    }
    map
}

/// Query RSS (KB) and CPU% for a batch of PIDs on Windows.
#[cfg(windows)]
fn query_process_stats(pids: &[u32]) -> std::collections::HashMap<u32, (u64, f32)> {
    let mut map = std::collections::HashMap::new();
    for &pid in pids {
        if let Some((rss, cpu)) = query_single_process_windows(pid) {
            map.insert(pid, (rss, cpu));
        }
    }
    map
}

#[cfg(windows)]
fn query_single_process_windows(pid: u32) -> Option<(u64, f32)> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut mem_info: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    mem_info.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let ok = unsafe {
        GetProcessMemoryInfo(
            handle,
            &mut mem_info,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }
    let rss_kb = mem_info.WorkingSetSize / 1024;
    Some((rss_kb as u64, 0.0))
}

#[derive(Debug, Clone, Serialize)]
pub struct VtLogChunk {
    pub lines: Vec<crate::state::LogLine>,
    pub screen: Vec<crate::state::LogLine>,
    pub total_lines: usize,
    pub oldest: usize,
}

/// Returns scrollback log lines and current screen rows for a session.
///
/// This is the desktop IPC equivalent of the PWA WebSocket `format=log` path.
/// `lines` are finalized scrollback lines (each appears once, oldest first).
/// `screen` is the current visible screen with agent chrome trimmed.
/// Desktop IPC equivalent of PWA WebSocket format=log — no frontend caller yet.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn read_vt_log(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> VtLogChunk {
    let limit = limit.unwrap_or(200);
    let Some(vt_log) = state.vt_log_buffers.get(&session_id) else {
        return VtLogChunk {
            lines: vec![],
            screen: vec![],
            total_lines: 0,
            oldest: 0,
        };
    };
    let (lines, raw_rows, screen_log, total_lines, oldest) = {
        let buf = vt_log.lock();
        let off = offset.unwrap_or_else(|| buf.total_lines().saturating_sub(limit));
        let (lines, _) = buf.lines_since_owned(off, limit);
        let raw_rows = buf.screen_rows();
        let screen_log = buf.screen_log_lines();
        let total_lines = buf.total_lines();
        let oldest = buf.oldest_offset();
        (lines, raw_rows, screen_log, total_lines, oldest)
    };
    // Chrome cutoff runs outside the lock — no contention with PTY reader.
    let refs: Vec<&str> = raw_rows.iter().map(|s| s.as_str()).collect();
    let cutoff = crate::chrome::find_chrome_cutoff(&refs).unwrap_or(raw_rows.len());
    let screen: Vec<crate::state::LogLine> = screen_log.into_iter().take(cutoff).collect();

    VtLogChunk {
        lines,
        screen,
        total_lines,
        oldest,
    }
}

/// Send a grid frame via the session's channel and mark it in-flight.
/// Also publishes to the watch channel for WebSocket subscribers.
pub(crate) fn send_grid_frame(state: &AppState, session_id: &str, frame: Vec<u8>) {
    if frame.is_empty() {
        return;
    }
    let needs_watch = state
        .grid_watch
        .get(session_id)
        .is_some_and(|tx| tx.receiver_count() > 0);

    if needs_watch && let Some(watch_tx) = state.grid_watch.get(session_id) {
        let _ = watch_tx.send(frame.clone());
    }
    #[cfg(feature = "desktop")]
    if let Some(ch) = state.grid_channels.get(session_id) {
        if let Some(flag) = state.grid_frame_in_flight.get(session_id) {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        let _ = ch.send(frame);
    }
}

/// Register a Tauri Channel for binary grid frame streaming on a session.
/// The frontend calls this once per terminal; subsequent PTY output triggers
/// `serialize_dirty_rows()` on the session's TerminalGrid and sends the result
/// via the channel. Replaces any previously registered channel for the session.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn subscribe_terminal_grid(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    channel: tauri::ipc::Channel<Vec<u8>>,
) {
    state
        .grid_frame_in_flight
        .insert(session_id.clone(), Arc::new(AtomicBool::new(false)));
    state
        .pending_scroll
        .insert(session_id.clone(), Arc::new(AtomicI64::new(-1)));
    state.grid_channels.insert(session_id, channel);
}

/// Acknowledge that the frontend has painted the last grid frame.
/// Clears the in-flight flag so the ticker can send the next frame.
/// The ticker (16ms interval) is the sole normal damage-driven frame sender.
/// The ack path only releases the backpressure gate. This caps frame rate at
/// ~60Hz and prevents the tight ack→flush→ack loop that saturated the main thread.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn ack_terminal_frame(state: State<'_, Arc<AppState>>, session_id: String) {
    if let Some(flag) = state.grid_frame_in_flight.get(&session_id) {
        flag.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Request a full frame for a session (used after subscribe to get initial state).
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_request_frame(state: State<'_, Arc<AppState>>, session_id: String) {
    if let Some(vt) = state.vt_log_buffers.get(&session_id) {
        let frame = {
            let mut vt = vt.lock();
            vt.grid_force_full_damage();
            vt.serialize_dirty_rows()
        };
        send_grid_frame(&state, &session_id, frame);
    }
}

/// Unregister the grid channel for a session (called by the frontend on unmount).
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn unsubscribe_terminal_grid(state: State<'_, Arc<AppState>>, session_id: String) {
    state.grid_channels.remove(&session_id);
    state.grid_frame_in_flight.remove(&session_id);
    state.pending_scroll.remove(&session_id);
}

/// Exit alternate screen via the terminal grid (display side only, never touches PTY stdin).
/// Only injects the exit sequences when the grid is actually in alternate-screen mode,
/// preventing escape leaks into the shell when the agent already cleaned up normally.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_exit_alt_screen(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> bool {
    if let Some(vt) = state.vt_log_buffers.get(&session_id) {
        let (was_alt, frame) = {
            let mut vt = vt.lock();
            if !vt.is_alternate_screen() {
                return false;
            }
            vt.process(b"\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?25h\x1b[0m");
            (true, vt.serialize_dirty_rows())
        };
        if was_alt {
            send_grid_frame(&state, &session_id, frame);
        }
        was_alt
    } else {
        false
    }
}

// --- Scroll commands ---

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_scroll(state: State<'_, Arc<AppState>>, session_id: String, delta: i32) {
    if let Some(vt) = state.vt_log_buffers.get(&session_id) {
        let frame = {
            let mut vt = vt.lock();
            vt.grid_scroll(delta);
            vt.serialize_dirty_rows()
        };
        send_grid_frame(&state, &session_id, frame);
    }
}

/// Coalesced scroll: record the target absolute display offset and mark the grid
/// dirty so the frame ticker applies it under the lock it already holds. Crucially
/// takes NO vt lock here, so scrolling never contends with the PTY output processor.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_scroll_to_offset(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    offset: usize,
) {
    if let Some(p) = state.pending_scroll.get(&session_id) {
        p.store(offset as i64, std::sync::atomic::Ordering::Relaxed);
    }
    if let Some(d) = state.grid_frame_dirty.get(&session_id) {
        d.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Fetch a range of styled rows by absolute index, to fill the frontend's
/// client-side row cache for smooth local scroll rendering. Read-only; called in
/// background chunks as the viewport approaches uncached rows, not per frame.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_styled_rows(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    start: usize,
    count: usize,
) -> Vec<u8> {
    state
        .vt_log_buffers
        .get(&session_id)
        .map(|vt| vt.lock().grid_serialize_styled_range(start, count))
        .unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_scroll_to(state: State<'_, Arc<AppState>>, session_id: String, line: usize) {
    if let Some(vt) = state.vt_log_buffers.get(&session_id) {
        let frame = {
            let mut vt = vt.lock();
            vt.grid_scroll_to_line(line);
            vt.serialize_dirty_rows()
        };
        send_grid_frame(&state, &session_id, frame);
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_get_block_rows(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    start_line: usize,
    end_line: usize,
) -> Vec<String> {
    state
        .vt_log_buffers
        .get(&session_id)
        .map(|vt| vt.lock().read_rows_in_range(start_line, end_line))
        .unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_scroll_info(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> (usize, usize, usize) {
    state
        .vt_log_buffers
        .get(&session_id)
        .map(|vt| {
            let vt = vt.lock();
            (
                vt.grid_display_offset(),
                vt.grid_total_lines(),
                vt.grid_screen_lines(),
            )
        })
        .unwrap_or((0, 0, 0))
}

// --- Search command ---

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_search(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    query: String,
) -> Vec<crate::terminal_grid::SearchMatch> {
    match state.vt_log_buffers.get(&session_id) {
        Some(vt) => {
            let buf = vt.lock();
            let is_alt = buf.is_alternate_screen();
            let results = buf.grid_search(&query);
            tracing::info!(
                session_id = %session_id,
                query = %query,
                is_alt_screen = is_alt,
                result_count = results.len(),
                history_size = buf.grid_history_size(),
                screen_lines = buf.grid_screen_lines(),
                "terminal_search"
            );
            results
        }
        None => {
            tracing::warn!(session_id = %session_id, query = %query, "terminal_search: session not found in vt_log_buffers");
            Vec::new()
        }
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_search_buffer(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    query: String,
) -> Vec<crate::terminal_grid::BufferSearchMatch> {
    state
        .vt_log_buffers
        .get(&session_id)
        .map(|vt| vt.lock().grid_search_buffer(&query))
        .unwrap_or_default()
}

// --- Row text command ---

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_get_row_text(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    row: usize,
) -> String {
    state
        .vt_log_buffers
        .get(&session_id)
        .map(|vt| vt.lock().grid_get_row_text(row))
        .unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_get_logical_line(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    row: usize,
) -> (usize, String) {
    state
        .vt_log_buffers
        .get(&session_id)
        .map(|vt| vt.lock().grid_get_logical_line(row))
        .unwrap_or((row, String::new()))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_get_selection_text(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    start_row: usize,
    start_col: usize,
    end_row: usize,
    end_col: usize,
) -> String {
    state
        .vt_log_buffers
        .get(&session_id)
        .map(|vt| {
            vt.lock()
                .grid_get_selection_text(start_row, start_col, end_row, end_col)
        })
        .unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_get_lines(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    start: usize,
    end: usize,
) -> Vec<String> {
    state
        .vt_log_buffers
        .get(&session_id)
        .map(|vt| vt.lock().grid_get_lines(start, end))
        .unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_get_cursor_line(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> String {
    state
        .vt_log_buffers
        .get(&session_id)
        .map(|vt| vt.lock().grid_get_cursor_line())
        .unwrap_or_default()
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_hyperlink_at(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    row: usize,
    col: usize,
) -> Option<String> {
    state
        .vt_log_buffers
        .get(&session_id)
        .and_then(|vt| vt.lock().grid_hyperlink_at(row, col))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn terminal_hyperlink_span(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    row: usize,
    col: usize,
) -> Option<(usize, usize, String)> {
    state
        .vt_log_buffers
        .get(&session_id)
        .and_then(|vt| vt.lock().grid_hyperlink_span(row, col))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn set_session_visible(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    visible: bool,
) -> Result<(), String> {
    state.session_visibility.insert(session_id.clone(), visible);
    #[cfg(unix)]
    if visible && let Err(e) = wake_session(&state, &session_id) {
        tracing::warn!(session_id, error = %e, "Wake on focus failed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The interactive-path threads raise their QoS to USER_INTERACTIVE. Verify
    /// the syscall actually takes effect by reading the class back on the same
    /// thread (default QoS for a fresh test thread is *not* USER_INTERACTIVE).
    #[cfg(target_os = "macos")]
    #[test]
    fn raises_thread_to_user_interactive_qos() {
        // Run on a dedicated thread so we don't leave the test runner's worker
        // permanently bumped.
        let observed = std::thread::spawn(|| {
            raise_thread_for_interactive_io();
            thread_qos::current_qos_class()
        })
        .join()
        .expect("qos probe thread panicked");
        // QOS_CLASS_USER_INTERACTIVE == 0x21.
        assert_eq!(
            observed, 0x21,
            "thread QoS was not raised to USER_INTERACTIVE"
        );
    }

    #[test]
    fn grid_send_min_interval_policy() {
        // Short burst, no typing → no floor: full-speed for low latency.
        assert_eq!(grid_send_min_interval_ms(false, 0), 0);
        assert_eq!(grid_send_min_interval_ms(false, 5), 0);
        // Sustained animation (dirty ≥ 6 ticks), no typing → ~30 fps floor.
        assert_eq!(grid_send_min_interval_ms(false, 6), 33);
        assert_eq!(grid_send_min_interval_ms(false, 1000), 33);
        // Typing under load → ~20 fps floor, regardless of dirty_run (even a
        // short burst), because keystroke latency is what we protect.
        assert_eq!(grid_send_min_interval_ms(true, 0), 50);
        assert_eq!(grid_send_min_interval_ms(true, 1000), 50);
        // Typing floor must be the more aggressive (larger interval) of the two.
        assert!(grid_send_min_interval_ms(true, 1000) > grid_send_min_interval_ms(false, 1000));
    }

    #[test]
    fn system_load_per_core_is_non_negative_and_finite() {
        // Links libc getloadavg/sysconf on Unix; returns 0.0 elsewhere. Either
        // way it must be a sane, non-negative, finite ratio.
        let v = system_load_per_core();
        assert!(v.is_finite());
        assert!(v >= 0.0);
    }

    #[test]
    fn clean_action_required_title_strips_marker_spinner_and_separators() {
        // Real grok permission-prompt title (captured live).
        assert_eq!(
            clean_action_required_title(
                "⚠ Action Required - ⠙ - Running: echo hello - Execute Shell Command"
            ),
            "Running: echo hello - Execute Shell Command"
        );
    }

    #[test]
    fn clean_action_required_title_handles_each_spinner_frame() {
        // Title repaints with a different braille frame each tick; cleaned output is stable.
        for frame in ["⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇"] {
            assert_eq!(
                clean_action_required_title(&format!("⚠ Action Required - {frame} - Running: ls")),
                "Running: ls"
            );
        }
    }

    #[test]
    fn clean_action_required_title_fallback_when_empty() {
        assert_eq!(
            clean_action_required_title("⚠ Action Required - ⠙ - "),
            "grok is awaiting approval"
        );
    }

    #[test]
    fn test_parse_signal_number_killed() {
        assert_eq!(parse_signal_number("Killed: 9"), 9);
    }

    #[test]
    fn test_parse_signal_number_interrupt() {
        assert_eq!(parse_signal_number("Interrupt: 2"), 2);
    }

    #[test]
    fn test_parse_signal_number_format_variant() {
        assert_eq!(parse_signal_number("Signal 15"), 15);
    }

    #[test]
    fn test_parse_signal_number_unknown() {
        assert_eq!(parse_signal_number("unknown signal"), 0);
    }

    #[test]
    fn test_parse_osc133_exit_code() {
        assert_eq!(parse_osc133_exit_code('D', "0"), Some(0));
        assert_eq!(parse_osc133_exit_code('D', "127"), Some(127));
        assert_eq!(parse_osc133_exit_code('D', ""), None);
        assert_eq!(parse_osc133_exit_code('A', "0"), None);
    }

    #[test]
    fn test_classify_agent_claude() {
        assert_eq!(classify_agent("claude"), Some("claude"));
    }

    #[test]
    fn test_classify_agent_gemini() {
        assert_eq!(classify_agent("gemini"), Some("gemini"));
    }

    #[test]
    fn test_classify_agent_aider() {
        assert_eq!(classify_agent("aider"), Some("aider"));
    }

    #[test]
    fn test_classify_agent_codex() {
        assert_eq!(classify_agent("codex"), Some("codex"));
    }

    #[test]
    fn test_classify_agent_opencode() {
        assert_eq!(classify_agent("opencode"), Some("opencode"));
    }

    #[test]
    fn test_classify_agent_goose() {
        assert_eq!(classify_agent("goose"), Some("goose"));
    }

    #[test]
    fn test_classify_agent_droid() {
        assert_eq!(classify_agent("droid"), Some("droid"));
    }

    #[test]
    fn test_classify_agent_unknown_returns_none() {
        assert_eq!(classify_agent("bash"), None);
        assert_eq!(classify_agent("zsh"), None);
        assert_eq!(classify_agent("node"), None);
        assert_eq!(classify_agent("python"), None);
        assert_eq!(classify_agent("vim"), None);
    }

    // --- parse_osc7_cwd tests (story 1558-81bb) ---

    #[test]
    fn osc7_simple_path() {
        assert_eq!(
            parse_osc7_cwd("file://hostname/Users/me"),
            Ok("/Users/me".into())
        );
    }

    #[test]
    fn osc7_empty_hostname() {
        assert_eq!(parse_osc7_cwd("file:///home/user"), Ok("/home/user".into()));
    }

    #[test]
    fn osc7_localhost() {
        assert_eq!(
            parse_osc7_cwd("file://localhost/tmp/foo"),
            Ok("/tmp/foo".into())
        );
    }

    #[test]
    fn osc7_trailing_slash_stripped() {
        assert_eq!(
            parse_osc7_cwd("file:///home/user/"),
            Ok("/home/user".into())
        );
    }

    #[test]
    fn osc7_root_path_preserved() {
        assert_eq!(parse_osc7_cwd("file:///"), Ok("/".into()));
    }

    #[test]
    fn osc7_percent_encoded_space() {
        assert_eq!(
            parse_osc7_cwd("file:///home/user/my%20project"),
            Ok("/home/user/my project".into()),
        );
    }

    #[test]
    fn osc7_percent_encoded_special_chars() {
        assert_eq!(
            parse_osc7_cwd("file:///tmp/%E2%9C%93"),
            Ok("/tmp/\u{2713}".into()),
        );
    }

    #[test]
    fn osc7_missing_scheme() {
        assert!(parse_osc7_cwd("/home/user").is_err());
    }

    #[test]
    fn osc7_wrong_scheme() {
        assert!(parse_osc7_cwd("http://localhost/foo").is_err());
    }

    #[test]
    fn osc7_invalid_percent_encoding() {
        assert!(parse_osc7_cwd("file:///home/%GG").is_err());
    }

    // --- classify_shell tests (story 1274-2e38) ---

    #[test]
    fn classify_shell_bare_posix_basenames() {
        for s in [
            "sh", "bash", "zsh", "fish", "dash", "ksh", "ash", "tcsh", "csh", "mksh",
        ] {
            assert_eq!(classify_shell(s), ShellFamily::Posix, "{s}");
        }
    }

    #[test]
    fn classify_shell_absolute_posix_paths() {
        for s in [
            "/bin/bash",
            "/usr/bin/zsh",
            "/opt/homebrew/bin/fish",
            "/usr/local/bin/sh",
        ] {
            assert_eq!(classify_shell(s), ShellFamily::Posix, "{s}");
        }
    }

    #[test]
    fn classify_shell_windows_native() {
        for s in [
            "cmd",
            "cmd.exe",
            "C:\\Windows\\System32\\cmd.exe",
            "powershell",
            "powershell.exe",
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "pwsh",
            "pwsh.exe",
        ] {
            assert_eq!(classify_shell(s), ShellFamily::WindowsNative, "{s}");
        }
    }

    /// Critical regression case for story 1274-2e38: Git Bash / Cygwin / MSYS
    /// ship `bash.exe` on Windows and DO support Ctrl-U. Classifying by host
    /// OS would wrongly skip the prefix here; classifying by shell basename
    /// correctly keeps them in the Posix family.
    #[test]
    fn classify_shell_git_bash_on_windows_is_posix() {
        for s in [
            "bash.exe",
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
            "C:/Program Files/Git/bin/bash.exe",
            "C:\\cygwin64\\bin\\bash.exe",
            "C:\\msys64\\usr\\bin\\bash.exe",
        ] {
            assert_eq!(classify_shell(s), ShellFamily::Posix, "{s}");
        }
    }

    #[test]
    fn classify_shell_wsl_is_posix() {
        for s in [
            "wsl",
            "wsl.exe",
            "wsl.exe -d Ubuntu",
            "C:\\Windows\\System32\\wsl.exe",
        ] {
            assert_eq!(classify_shell(s), ShellFamily::Posix, "{s}");
        }
    }

    #[test]
    fn classify_shell_case_insensitive() {
        assert_eq!(classify_shell("BASH.EXE"), ShellFamily::Posix);
        assert_eq!(classify_shell("Cmd.Exe"), ShellFamily::WindowsNative);
        assert_eq!(classify_shell("PowerShell.exe"), ShellFamily::WindowsNative);
    }

    #[test]
    fn classify_shell_ignores_trailing_arguments() {
        // Arguments after the first whitespace must not affect classification.
        assert_eq!(classify_shell("bash --login"), ShellFamily::Posix);
        assert_eq!(
            classify_shell("powershell.exe -NoProfile"),
            ShellFamily::WindowsNative
        );
    }

    #[test]
    fn classify_shell_unknown_for_other_binaries() {
        // Intentionally unknown — callers should fall back to a safe default.
        for s in ["python", "node", "/usr/bin/env", "", "   "] {
            assert_eq!(classify_shell(s), ShellFamily::Unknown, "{s:?}");
        }
    }

    // --- SilenceState tests ---

    #[test]
    fn test_silence_state_no_pending_returns_none() {
        let mut s = SilenceState::new();
        assert!(s.check_silence().is_none());
    }

    #[test]
    fn test_tool_error_no_candidate_returns_none() {
        let mut s = SilenceState::new();
        assert!(s.check_tool_error().is_none());
    }

    #[test]
    fn test_tool_error_fires_after_silence_threshold() {
        let mut s = SilenceState::new();
        s.mark_tool_error_candidate("Error: Exit code 128".to_string());
        // Force last_output_at past the threshold to simulate silence.
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_tool_error(),
            Some("Error: Exit code 128".to_string())
        );
        // Dedup: second call returns None (already emitted).
        assert!(s.check_tool_error().is_none());
    }

    #[test]
    fn test_tool_error_recovery_clears_candidate() {
        let mut s = SilenceState::new();
        s.mark_tool_error_candidate("Error: Exit code 1".to_string());
        s.clear_tool_error_on_recovery();
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(
            s.check_tool_error().is_none(),
            "recovery must clear pending tool error"
        );
    }

    #[test]
    fn test_tool_error_does_not_refire_same_line_after_recovery() {
        // Reproduces the scroll-induced re-fire bug: once an error has been
        // surfaced, scrolling the Ink TUI viewport re-introduces the error line
        // in `changed_rows`. `clear_tool_error_on_recovery` must NOT re-enable
        // notification for a line the user already saw.
        let mut s = SilenceState::new();
        s.mark_tool_error_candidate("Error: Exit code 1".to_string());
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_tool_error(),
            Some("Error: Exit code 1".to_string()),
            "first occurrence must fire"
        );

        // Agent produced real output → recovery.
        s.clear_tool_error_on_recovery();

        // Viewport scrolls, same error line reappears in changed_rows.
        s.mark_tool_error_candidate("Error: Exit code 1".to_string());
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(
            s.check_tool_error().is_none(),
            "same error line must not refire after recovery (scroll-induced)"
        );
    }

    #[test]
    fn test_tool_error_different_line_fires_after_first() {
        let mut s = SilenceState::new();
        s.mark_tool_error_candidate("Error: Exit code 1".to_string());
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        let _ = s.check_tool_error();
        s.clear_tool_error_on_recovery();

        // A different error appears in a later turn — must still fire.
        s.mark_tool_error_candidate("Error: Exit code 128".to_string());
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_tool_error(),
            Some("Error: Exit code 128".to_string()),
            "distinct error text must not be suppressed by prior surface"
        );
    }

    #[test]
    fn test_tool_error_refires_after_memory_reset() {
        // After the user submits a line (explicit re-engagement), a recurrence
        // of the same failure in a new turn must notify again.
        let mut s = SilenceState::new();
        s.mark_tool_error_candidate("Error: Exit code 1".to_string());
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(s.check_tool_error().is_some());

        s.reset_tool_error_memory();

        s.mark_tool_error_candidate("Error: Exit code 1".to_string());
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_tool_error(),
            Some("Error: Exit code 1".to_string()),
            "after user input, same error text must be allowed to notify again"
        );
    }

    #[test]
    fn test_is_retry_line_matches_connection_retries() {
        // Claude subagent SDK retry loop (the reported false-idle scenario).
        assert!(is_retry_line(
            "  Unable to connect to API (ECONNRESET) · Retrying in 0s · attempt 6/10"
        ));
        assert!(is_retry_line(
            "Teammate @spinach-mail-validate failed: API Error: Unable to connect to API (ConnectionRefused)"
        ));
        // Goose/Aider stream-error retry form.
        assert!(is_retry_line(
            "⚠  stream error: exceeded retry limit, last status: 401; retrying 5/5 in 3s…"
        ));
        // Non-retry prose / code must NOT latch busy — the N/M counter is required.
        assert!(!is_retry_line(
            "I'll be retrying the request in a moment if it fails."
        ));
        assert!(!is_retry_line(
            "let retrying = true; // attempt to reconnect"
        ));
        assert!(!is_retry_line(
            "Successfully connected to the API endpoint."
        ));
    }

    #[test]
    fn test_api_retry_hold_active_then_expires() {
        let mut s = SilenceState::new();
        assert!(!s.is_api_retry_active(), "no hold armed initially");
        s.mark_api_retry();
        assert!(s.is_api_retry_active(), "hold active right after arming");
        // Simulate the hold window elapsing.
        s.api_retry_hold_until =
            Some(std::time::Instant::now() - std::time::Duration::from_millis(1));
        assert!(
            !s.is_api_retry_active(),
            "hold self-expires after AGENT_RETRY_HOLD"
        );
    }

    #[test]
    fn test_api_retry_blocks_ready_screen_confirm() {
        // Claude Code keeps its `❯` prompt visible while auto-retrying, so a stable
        // ready screen would otherwise confirm idle after AGENT_READY_CONFIRM. The
        // retry hold must refuse that confirmation.
        let mut s = SilenceState::new();
        s.mark_api_retry();
        // Force the ready prompt to look long-stable.
        s.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM * 2);
        assert!(
            !s.note_ready_screen(),
            "ready screen must not confirm idle while an API retry is in flight"
        );

        // Once the hold expires, the same stable ready prompt confirms idle.
        s.api_retry_hold_until =
            Some(std::time::Instant::now() - std::time::Duration::from_millis(1));
        s.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM * 2);
        assert!(
            s.note_ready_screen(),
            "ready screen confirms idle after the retry hold expires"
        );
    }

    #[test]
    fn test_api_retry_hold_cleared_on_recovery_and_user_input() {
        let mut s = SilenceState::new();
        s.mark_api_retry();
        // Real non-error output → agent recovered.
        s.clear_tool_error_on_recovery();
        assert!(!s.is_api_retry_active(), "recovery releases the retry hold");

        s.mark_api_retry();
        // User re-engages (submitted a line / Ctrl+C).
        s.reset_tool_error_memory();
        assert!(
            !s.is_api_retry_active(),
            "user input releases the retry hold"
        );
    }

    #[test]
    fn test_tool_error_mark_is_idempotent_while_pending() {
        let mut s = SilenceState::new();
        s.mark_tool_error_candidate("Error: Exit code 1".to_string());
        // Second mark for the same line while still pending → no-op.
        s.mark_tool_error_candidate("Error: Exit code 1".to_string());
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(s.check_tool_error(), Some("Error: Exit code 1".to_string()));
    }

    // --- is_tool_error_line tests ---

    #[test]
    fn test_tool_error_matches_claude_code_format() {
        // Claude Code prefixes tool-result rows with `⎿ `.
        assert!(is_tool_error_line("⎿  Error: Exit code 1"));
        assert!(is_tool_error_line("  ⎿  Error: Exit code 127"));
    }

    #[test]
    fn test_tool_error_matches_bare_format() {
        assert!(is_tool_error_line("Error: Exit code 1"));
        assert!(is_tool_error_line("  Error: Exit code 128"));
    }

    #[test]
    fn test_tool_error_rejects_source_code_literal() {
        // Exact string that triggered the false-positive in Boss's session:
        // the test file's own content displayed in a terminal armed a red
        // notification because the unanchored regex matched inside a string
        // literal. These must never fire.
        assert!(!is_tool_error_line(
            r#"s.mark_tool_error_candidate("Error: Exit code 2".to_string());"#
        ));
        assert!(!is_tool_error_line(
            r#"assert_eq!(s.check_tool_error(), Some("Error: Exit code 1".to_string()));"#
        ));
        assert!(!is_tool_error_line(
            r#"3895          s.mark_tool_error_candidate("Error: Exit code 2".to_string"#
        ));
    }

    #[test]
    fn test_tool_error_rejects_markdown_mention() {
        // Commit messages, docs, release notes that quote the error text.
        assert!(!is_tool_error_line(
            r#"fix: resolve "Error: Exit code 1" in claude tool pipeline"#
        ));
    }

    #[test]
    fn test_tool_error_allows_box_drawing_variations() {
        // Other box-drawing chars Claude uses for tool-call hierarchy rows.
        assert!(is_tool_error_line("╰  Error: Exit code 2"));
        assert!(is_tool_error_line("│  Error: Exit code 5"));
    }

    // --- Suggest backend-gating tests ---

    #[test]
    fn test_suggest_drain_returns_parked_items() {
        let mut s = SilenceState::new();
        s.mark_suggest_candidate(vec!["alpha".to_string(), "beta".to_string()], 0);
        assert_eq!(
            s.drain_pending_suggest(),
            Some(vec!["alpha".to_string(), "beta".to_string()])
        );
    }

    #[test]
    fn test_suggest_drain_consumes_items() {
        let mut s = SilenceState::new();
        s.mark_suggest_candidate(vec!["a".to_string()], 0);
        let _ = s.drain_pending_suggest();
        assert!(
            s.drain_pending_suggest().is_none(),
            "second drain must return None — single-shot semantics"
        );
    }

    #[test]
    fn test_suggest_drain_none_when_nothing_parked() {
        let mut s = SilenceState::new();
        assert!(s.drain_pending_suggest().is_none());
    }

    #[test]
    fn test_suggest_newer_items_overwrite_older() {
        let mut s = SilenceState::new();
        s.mark_suggest_candidate(vec!["old".to_string()], 0);
        s.mark_suggest_candidate(vec!["new1".to_string(), "new2".to_string()], 0);
        assert_eq!(
            s.drain_pending_suggest(),
            Some(vec!["new1".to_string(), "new2".to_string()]),
            "latest parked set must win (agent updated suggestions mid-turn)"
        );
    }

    #[test]
    fn test_suggest_reset_on_user_input() {
        let mut s = SilenceState::new();
        s.mark_suggest_candidate(vec!["stale".to_string()], 0);
        s.reset_suggest_memory();
        assert!(
            s.drain_pending_suggest().is_none(),
            "user input must drop pending suggest so it doesn't fire across turns"
        );
    }

    #[test]
    fn test_suggest_empty_items_ignored() {
        let mut s = SilenceState::new();
        s.mark_suggest_candidate(vec![], 0);
        assert!(
            s.pending_suggest_items.is_none(),
            "empty items must not park"
        );
        assert!(s.drain_pending_suggest().is_none());
    }

    #[test]
    fn test_tool_error_suppressed_while_spinner_active() {
        let mut s = SilenceState::new();
        s.mark_tool_error_candidate("Error: Exit code 2".to_string());
        s.last_status_line_at = Some(std::time::Instant::now());
        s.last_output_at = std::time::Instant::now()
            - SILENCE_TOOL_ERROR_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(
            s.check_tool_error().is_none(),
            "spinner active means agent still working — no notification"
        );
    }

    #[test]
    fn test_silence_state_pending_but_too_soon() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        // Just set — not enough time has passed
        assert!(s.check_silence().is_none());
    }

    #[test]
    fn test_silence_state_pending_after_threshold() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        // Simulate time passing by backdating last_output_at
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(s.check_silence(), Some("Continue?".to_string()));
    }

    #[test]
    fn test_silence_state_no_double_emission() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(s.check_silence().is_some());
        // Second check should return None (already emitted)
        assert!(s.check_silence().is_none());
    }

    #[test]
    fn test_silence_state_regex_suppresses_timer() {
        let mut s = SilenceState::new();
        // regex_found_question = true means instant detection already fired
        s.on_chunk(
            true,
            Some("Would you like to proceed?".to_string()),
            false,
            false,
            false,
        );
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(s.check_silence().is_none());
    }

    #[test]
    fn test_silence_state_regex_clears_prior_pending() {
        let mut s = SilenceState::new();
        // Silence detector has a pending question from an earlier chunk
        s.on_chunk(
            false,
            Some("Earlier question?".to_string()),
            false,
            false,
            false,
        );
        assert!(s.pending_question_line.is_some());
        // Regex fires on a different event — no question line in this chunk
        s.on_chunk(true, None, false, false, false);
        assert!(
            s.pending_question_line.is_none(),
            "prior pending should be cleared when regex fires"
        );
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(s.check_silence().is_none());
    }

    #[test]
    fn test_silence_state_non_question_output_preserves_pending() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        // Non-`?` output (spinners, prompts, decorations) must NOT clear pending.
        s.on_chunk(false, None, false, false, false);
        s.on_chunk(false, None, false, false, false);
        s.on_chunk(false, None, false, false, false);
        // Standard 10s threshold fires normally
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(s.check_silence(), Some("Continue?".to_string()));
    }

    #[test]
    fn test_silence_state_new_question_replaces_old() {
        let mut s = SilenceState::new();
        s.on_chunk(
            false,
            Some("First question?".to_string()),
            false,
            false,
            false,
        );
        s.on_chunk(
            false,
            Some("Second question?".to_string()),
            false,
            false,
            false,
        );
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(s.check_silence(), Some("Second question?".to_string()));
    }

    #[test]
    fn test_silence_state_suppress_user_input() {
        let mut s = SilenceState::new();
        // User types a line ending with `?` — PTY will echo it back
        s.on_chunk(
            false,
            Some("c'è ancora una storia?".to_string()),
            false,
            false,
            false,
        );
        // write_pty detects user input and suppresses
        s.suppress_user_input();
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        // Should NOT fire — the question was typed by the user
        assert!(s.check_silence().is_none());
    }

    #[test]
    fn test_silence_state_suppress_echo_after_user_input() {
        let mut s = SilenceState::new();
        // write_pty detects user input and suppresses BEFORE the echo arrives
        s.suppress_user_input();
        // PTY echoes the user's text back — this should NOT re-enable detection
        s.on_chunk(
            false,
            Some("lo hai mai provato?".to_string()),
            false,
            false,
            false,
        );
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        // Should NOT fire — the echo window blocks re-enabling
        assert!(
            s.check_silence().is_none(),
            "PTY echo after suppress should not trigger question detection"
        );
    }

    #[test]
    fn test_silence_state_suppress_echo_expires() {
        let mut s = SilenceState::new();
        s.suppress_user_input();
        // Expire the echo suppress window with a past deadline (not None,
        // which means "never suppressed" — a different code path).
        s.suppress_echo_until =
            Some(std::time::Instant::now() - std::time::Duration::from_millis(1));
        // Agent asks a genuine question after the window expires
        s.on_chunk(
            false,
            Some("Would you like to proceed?".to_string()),
            false,
            false,
            false,
        );
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        // Should fire — this is a real agent question
        assert_eq!(
            s.check_silence(),
            Some("Would you like to proceed?".to_string())
        );
    }

    #[test]
    fn test_silence_state_spinner_suppresses_question() {
        let mut s = SilenceState::new();
        // Agent prints a `?`-line alongside a status-line/spinner in the same chunk
        s.on_chunk(
            false,
            Some("Want me to proceed?".to_string()),
            true,
            false,
            false,
        );
        // Simulate 10s+ of silence
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        // Should NOT emit question — spinner was recently active
        assert_eq!(s.check_silence(), None, "spinner active → no question");
    }

    #[test]
    fn test_silence_state_spinner_expired_allows_question() {
        let mut s = SilenceState::new();
        s.on_chunk(
            false,
            Some("Want me to proceed?".to_string()),
            true,
            false,
            false,
        );
        // Spinner was active but long ago (>10s, matching SILENCE_QUESTION_THRESHOLD)
        s.last_status_line_at =
            Some(std::time::Instant::now() - std::time::Duration::from_secs(12));
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        // Spinner expired, question should fire
        assert_eq!(s.check_silence(), Some("Want me to proceed?".to_string()));
    }

    #[test]
    fn test_silence_state_spinner_within_10s_suppresses() {
        let mut s = SilenceState::new();
        s.on_chunk(
            false,
            Some("Want me to proceed?".to_string()),
            true,
            false,
            false,
        );
        // Spinner was 8s ago — still within the 10s window
        s.last_status_line_at = Some(std::time::Instant::now() - std::time::Duration::from_secs(8));
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_silence(),
            None,
            "spinner within 10s should suppress question"
        );
    }

    // --- Status-line-only chunk tests ---

    #[test]
    fn test_silence_state_status_line_only_does_not_reset_silence() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        // Backdate last_output_at to simulate 10s of silence
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        // Mode-line timer tick: status_line_only = true, should NOT reset last_output_at
        s.on_chunk(false, None, true, true, false);
        // The silence threshold should still be met
        assert_eq!(
            s.check_silence(),
            Some("Continue?".to_string()),
            "status_line_only chunks must not reset the silence timer"
        );
    }

    #[test]
    fn test_silence_state_mode_line_ticks_do_not_suppress_question() {
        // Reproduces the bug: Claude Code asks a question, then the mode line
        // keeps updating every ~1s while waiting for input. Status-line-only chunks
        // were keeping `is_spinner_active()` true forever, preventing question
        // detection even after 10s of silence.
        let mut s = SilenceState::new();
        // Agent outputs question + status line in same chunk (not status-line-only)
        s.on_chunk(
            false,
            Some("Vuoi fare un commit?".to_string()),
            true,
            false,
            false,
        );

        // Simulate 10s+ passing: both last_output_at and last_status_line_at
        // age beyond the threshold (in real life, wall-clock time handles this).
        let past = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        s.last_output_at = past;
        s.last_status_line_at = Some(past);

        // Mode-line-only ticks keep coming — they must NOT refresh either timer.
        for _ in 0..10 {
            s.on_chunk(false, None, true, true, false);
        }

        // After 10s+ of silence, the question MUST be detected even though
        // mode-line ticks kept coming in.
        assert_eq!(
            s.check_silence(),
            Some("Vuoi fare un commit?".to_string()),
            "mode-line-only ticks must not keep is_spinner_active() alive"
        );
    }

    #[test]
    fn test_silence_state_mode_line_ticks_do_not_stale_question() {
        // Regression: mode-line timer ticks (status_line_only=true) were incrementing
        // output_chunks_after_question, clearing the pending question as "stale"
        // before the silence timer could detect it.
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Procedo?".to_string()), true, false, false);

        // Simulate 15 mode-line ticks (> STALE_QUESTION_CHUNKS=10)
        for _ in 0..15 {
            s.on_chunk(false, None, true, true, false);
        }

        // pending_question_line must still be present — mode-line ticks are not real output
        assert_eq!(
            s.pending_question_line.as_deref(),
            Some("Procedo?"),
            "mode-line-only ticks must not count toward staleness"
        );

        // Backdate to simulate silence threshold reached
        let past = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        s.last_output_at = past;
        s.last_status_line_at = Some(past);

        assert_eq!(
            s.check_silence(),
            Some("Procedo?".to_string()),
            "question must be detectable after mode-line-only ticks"
        );
    }

    #[test]
    fn test_silence_state_regular_chunk_resets_silence() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        // Backdate to simulate 10s silence
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        // Regular (non-status-line) chunk resets the timer
        s.on_chunk(false, None, false, false, false);
        // Now we need to wait another 10s — should NOT fire yet
        assert_eq!(
            s.check_silence(),
            None,
            "regular chunk should reset silence timer"
        );
    }

    #[test]
    fn test_silence_state_suggest_only_does_not_stale_question() {
        // A suggest-only chunk (protocol token, not real output) must not
        // increment output_chunks_after_question or reset the silence timer.
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        // 15 suggest-only chunks — should NOT stale the pending question
        for _ in 0..15 {
            s.on_chunk(false, None, false, false, true);
        }
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_silence(),
            Some("Continue?".to_string()),
            "suggest-only chunks must not count toward question staleness"
        );
    }

    // --- is_chrome_row / chrome_only classification tests ---

    #[test]
    fn test_chrome_only_empty_changed_rows_is_chrome() {
        // Empty changed_rows means the chunk produced no visible change
        // (cursor blink, OSC title update, mouse report). It must count as
        // chrome-only so periodic re-emits don't latch the shell to busy.
        let rows: Vec<ChangedRow> = vec![];
        assert!(
            compute_chrome_only(&rows, false, false, false),
            "empty changed_rows should be chrome_only (no real output)"
        );
    }

    #[test]
    fn test_chrome_only_plain_text_is_not_chrome() {
        let rows = make_rows(&["I will edit the file for you."]);
        let chrome_only = !rows.is_empty() && rows.iter().all(|r| is_chrome_row(&r.text));
        assert!(
            !chrome_only,
            "plain text without chrome markers is not chrome"
        );
    }

    #[test]
    fn test_chrome_only_statusline_with_text_rows_is_not_chrome() {
        let rows = make_rows(&[
            "\u{23F5}\u{23F5} auto mode",
            "Here is the code change:",
            "  fn main() {",
            "    println!(\"hello\");",
        ]);
        let chrome_only = !rows.is_empty() && rows.iter().all(|r| is_chrome_row(&r.text));
        assert!(!chrome_only, "mode-line + text rows should not be chrome");
    }

    #[test]
    fn test_chrome_only_single_statusline_row_is_chrome() {
        let rows = make_rows(&["\u{23F5}\u{23F5} auto mode"]);
        let chrome_only = !rows.is_empty() && rows.iter().all(|r| is_chrome_row(&r.text));
        assert!(chrome_only, "single mode-line row should be chrome");
    }

    #[test]
    fn test_chrome_only_wrapped_statusline_is_chrome() {
        let rows = make_rows(&[
            "\u{23F5}\u{23F5} bypass permissions on",
            "\u{273B} Cogitated 3m 47s",
        ]);
        let chrome_only = !rows.is_empty() && rows.iter().all(|r| is_chrome_row(&r.text));
        assert!(chrome_only, "wrapped mode-line rows should all be chrome");
    }

    #[test]
    fn test_chrome_only_subtasks_row_is_chrome() {
        let rows = make_rows(&["\u{203A}\u{203A} bypass permissions on \u{00B7} 1 local agent"]);
        let chrome_only = !rows.is_empty() && rows.iter().all(|r| is_chrome_row(&r.text));
        assert!(chrome_only, "subtask mode-line row should be chrome");
    }

    #[test]
    fn test_chrome_only_codex_spinner_is_chrome() {
        let rows = make_rows(&["\u{2022} Boot"]);
        let chrome_only = !rows.is_empty() && rows.iter().all(|r| is_chrome_row(&r.text));
        assert!(chrome_only, "Codex spinner row should be chrome");
    }

    #[test]
    fn test_chrome_only_gemini_braille_spinner_is_chrome() {
        // Gemini braille spinner chars (U+2800-28FF) are now in is_chrome_row
        let rows = make_rows(&["\u{280B} Connecting to MCP servers..."]);
        let chrome_only = !rows.is_empty() && rows.iter().all(|r| is_chrome_row(&r.text));
        assert!(chrome_only, "Gemini braille spinner should be chrome");
    }

    #[test]
    fn test_chrome_only_tool_progress_spinner_is_chrome() {
        let rows = make_rows(&["\u{25D0} Bash: .../b... | \u{2713} Bash \u{00D7}9"]);
        let chrome_only = !rows.is_empty() && rows.iter().all(|r| is_chrome_row(&r.text));
        assert!(chrome_only, "CC tool progress spinner should be chrome");
        assert!(
            crate::chrome::is_spinner_row(&rows[0].text),
            "CC tool progress spinner should be detected as spinner (keepalive)"
        );
    }

    // --- chrome_only full formula tests (mirrors process_chunk logic) ---

    /// Helper: compute chrome_only using the same formula as process_chunk.
    fn compute_chrome_only(
        rows: &[ChangedRow],
        has_status_line: bool,
        regex_found_question: bool,
        last_q_line: bool,
    ) -> bool {
        let all_chrome_markers = rows.iter().all(|r| is_chrome_row(&r.text));
        let no_real_output = rows.iter().all(|r| {
            is_chrome_row(&r.text)
                || r.text.trim().is_empty()
                || crate::chrome::is_separator_line(&r.text)
                || crate::chrome::is_prompt_line(&r.text)
        });
        !regex_found_question
            && !last_q_line
            && (rows.is_empty() || all_chrome_markers || (has_status_line && no_real_output))
    }

    #[test]
    fn test_chrome_only_formula_timer_tick_only() {
        // CC timer tick: only the timer row changed
        let rows = make_rows(&["\u{273B} Cogitated 3m 47s"]);
        assert!(
            compute_chrome_only(&rows, true, false, false),
            "timer-only tick should be chrome_only"
        );
    }

    #[test]
    fn test_chrome_only_formula_timer_plus_separator() {
        // CC timer tick + separator repaint (ESC[2J full redraw)
        let rows = make_rows(&[
            "────────────────────────────────────",
            "\u{273B} Cogitated 3m 48s",
        ]);
        assert!(
            compute_chrome_only(&rows, true, false, false),
            "timer + separator should be chrome_only"
        );
    }

    #[test]
    fn test_chrome_only_formula_timer_plus_prompt_and_separator() {
        // CC timer tick + prompt + separator (full bottom chrome zone)
        let rows = make_rows(&[
            "────────────────────────────────────",
            "❯",
            "────────────────────────────────────",
            "\u{23F5}\u{23F5} auto mode",
            "\u{273B} Cogitated 3m 48s",
        ]);
        assert!(
            compute_chrome_only(&rows, true, false, false),
            "timer + prompt + separator + mode-line should be chrome_only"
        );
    }

    #[test]
    fn test_chrome_only_formula_timer_plus_blank_rows() {
        // CC timer tick with blank rows (padding in TUI)
        let rows = make_rows(&["", "\u{273B} Cogitated 3m 48s", ""]);
        assert!(
            compute_chrome_only(&rows, true, false, false),
            "timer + blank rows should be chrome_only"
        );
    }

    #[test]
    fn test_chrome_only_formula_real_output_not_chrome() {
        // Real agent output mixed with status line
        let rows = make_rows(&["I will edit the file for you.", "\u{273B} Cogitated 3m 48s"]);
        assert!(
            !compute_chrome_only(&rows, true, false, false),
            "real text + timer should NOT be chrome_only"
        );
    }

    #[test]
    fn test_chrome_only_formula_question_line_not_chrome() {
        // Even if all chrome, a pending question line disables chrome_only
        let rows = make_rows(&["\u{273B} Cogitated 3m 48s"]);
        assert!(
            !compute_chrome_only(&rows, true, false, true),
            "chrome with pending question should NOT be chrome_only"
        );
    }

    // --- Spinner → busy gate tests (mirrors process_chunk transition logic) ---

    /// The busy transition gate `(!chrome_only || has_spinner)` must be true
    /// when changed_rows contain an active spinner, even when chrome_only is true.
    #[test]
    fn test_spinner_only_chunk_can_trigger_busy() {
        let rows = make_rows(&["\u{2022} Working (1m 31s \u{2022} esc to interrupt)"]);
        let chrome_only = compute_chrome_only(&rows, false, false, false);
        let has_spinner =
            chrome_only && rows.iter().any(|r| crate::chrome::is_spinner_row(&r.text));
        assert!(chrome_only, "Codex spinner is chrome_only");
        assert!(has_spinner, "Codex spinner is detected as spinner");
        assert!(
            !chrome_only || has_spinner,
            "spinner-only chunk must pass the busy transition gate"
        );
    }

    #[test]
    fn test_static_chrome_cannot_trigger_busy() {
        let rows = make_rows(&["\u{23F5}\u{23F5} auto mode"]);
        let chrome_only = compute_chrome_only(&rows, false, false, false);
        let has_spinner =
            chrome_only && rows.iter().any(|r| crate::chrome::is_spinner_row(&r.text));
        assert!(chrome_only, "mode-line is chrome_only");
        assert!(!has_spinner, "mode-line is NOT a spinner");
        assert!(
            chrome_only && !has_spinner,
            "static chrome must NOT pass the busy transition gate"
        );
    }

    /// Build ChangedRows for a subset of a full screen, mirroring how the VT
    /// reader reports only the rows a chunk actually repainted (`row_index`
    /// preserved against the full screen).
    fn changed_at(screen: &[&str], indices: &[usize]) -> Vec<ChangedRow> {
        indices
            .iter()
            .map(|&i| ChangedRow {
                row_index: i,
                text: screen[i].to_string(),
            })
            .collect()
    }

    /// Mirror process_chunk's chrome-cutoff filter (pty.rs ~1996): drop changed
    /// rows at or below the footer cutoff, keeping only the content zone.
    fn filter_below_cutoff(screen: &[&str], changed: Vec<ChangedRow>) -> Vec<ChangedRow> {
        if changed.is_empty() {
            return changed;
        }
        match crate::chrome::find_chrome_cutoff(screen) {
            Some(cutoff) => changed
                .into_iter()
                .filter(|r| r.row_index < cutoff)
                .collect(),
            None => changed,
        }
    }

    /// Regression for the false-busy "flap" (root cause + agnostic fix,
    /// 2026-06-17). Claude Code repaints its whole input area periodically.
    /// Positionally, EVERYTHING below the second separator of the input box is
    /// chrome — status bar, mode line, usage gauge — regardless of its glyphs.
    /// The user's custom HUD renders a context gauge (`█░`) and a mode line
    /// (`·`) there; `is_spinner_row` reads those glyphs as a live spinner.
    ///
    /// The fix is positional, not glyph-based: spinner keepalive runs on the
    /// SAME post-cutoff `changed_rows` as everything else. A repaint that only
    /// touches footer rows below the cutoff yields an EMPTY post-filter set →
    /// chrome_only with no spinner → no busy transition. Agnostic to whatever
    /// the user puts in their status bar. These are the exact rows captured
    /// from the live flapping instance.
    #[test]
    fn test_statusbar_repaint_below_cutoff_does_not_flap_busy() {
        let sep = "────────────────────────────────────────────────────────────────────────";
        let screen: Vec<&str> = vec![
            "Here is the answer to your question.",
            "",
            sep,
            "❯",
            sep,
            "[Opus 4.8 (1M) | Team] █░░░░░░░░░ 6% | gh-metrics git:(master)",
            "5h: 21% (50m) | 7d: 23% | $31.00 | 📅 $199.70 | 13h",
            "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
        ];
        // The periodic repaint re-emits only the footer rows (indices 5-7).
        let changed = changed_at(&screen, &[5, 6, 7]);
        let filtered = filter_below_cutoff(&screen, changed);
        assert!(
            filtered.is_empty(),
            "all-footer repaint must yield an empty post-cutoff set"
        );
        let chrome_only = compute_chrome_only(&filtered, true, false, false);
        let has_spinner = chrome_only
            && filtered
                .iter()
                .any(|r| crate::chrome::is_spinner_row(&r.text));
        assert!(chrome_only, "empty post-cutoff set is chrome_only");
        assert!(
            !(!chrome_only || has_spinner),
            "statusbar repaint must NOT pass the busy transition gate (no flap)"
        );
    }

    /// Companion to the flap regression: a REAL working spinner renders ABOVE
    /// the input separator (in the content zone), so it survives the chrome
    /// cutoff and the post-filter spinner check fires — keeping the agent alive.
    /// Otherwise the agent false-idles mid-think (the dangerous direction the
    /// single-path design prevents). This is what makes the positional fix safe:
    /// no supported agent renders a genuine working spinner below the separator.
    #[test]
    fn test_content_zone_spinner_still_keeps_alive() {
        let cc_sep = "────────────────────────────────────────────────────────────────────────";
        let gem_sep =
            "─────────────────────────────────────────────────────────────────────────────────";
        let gem_top =
            "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀";
        let gem_bot =
            "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▀▀";
        // (full screen, index of the working spinner row). Spinner is ABOVE the
        // input separator in every case — verified against the cutoff tests.
        let cases: Vec<(Vec<&str>, usize)> = vec![
            // Claude Code: dingbat thinking spinner in the transcript zone.
            (
                vec![
                    "✻ Cogitating… (3m 47s · ↓ 2.2k tokens)",
                    "",
                    cc_sep,
                    "❯",
                    cc_sep,
                    "[Opus 4.8 (1M) | Team] █░░░░░░░░░ 6% | gh-metrics git:(master)",
                ],
                0,
            ),
            // Gemini CLI: braille spinner above the separator (live layout).
            (
                vec![
                    "✦ I will read the package.json file.",
                    " ⠴ Check tool-specific usage stats… (esc to cancel, 14s)",
                    gem_sep,
                    " Shift+Tab to accept edits",
                    gem_top,
                    " >   Type your message or @path/to/file",
                    gem_bot,
                    " workspace (/directory)          branch          sandbox",
                ],
                1,
            ),
        ];
        for (screen, spinner_idx) in &cases {
            let changed = changed_at(screen, &[*spinner_idx]);
            let filtered = filter_below_cutoff(screen, changed);
            assert!(
                filtered.iter().any(|r| r.row_index == *spinner_idx),
                "content-zone spinner at row {spinner_idx} must survive the cutoff: {:?}",
                screen[*spinner_idx]
            );
            let chrome_only = compute_chrome_only(&filtered, false, false, false);
            let has_spinner = chrome_only
                && filtered
                    .iter()
                    .any(|r| crate::chrome::is_spinner_row(&r.text));
            assert!(
                !chrome_only || has_spinner,
                "content-zone spinner {:?} must pass the busy transition gate",
                screen[*spinner_idx]
            );
        }
    }

    /// Aider during generation has NO bottom input box (prompt_toolkit has
    /// returned), so `find_chrome_cutoff` finds no separator/prompt and returns
    /// None → nothing is filtered → the Knight Rider spinner survives and keeps
    /// the agent alive. This is why the positional fix does not false-idle Aider
    /// even though its spinner is a bare block run.
    #[test]
    fn test_aider_generation_spinner_keeps_alive() {
        let screen: Vec<&str> = vec![
            "Applied edit to src/main.rs",
            "█░  Waiting for openrouter/anthropic/claude-sonnet-4.5",
        ];
        assert_eq!(
            crate::chrome::find_chrome_cutoff(&screen),
            None,
            "Aider generation view has no input box → no cutoff"
        );
        let changed = changed_at(&screen, &[1]);
        let filtered = filter_below_cutoff(&screen, changed);
        assert!(
            filtered.iter().any(|r| r.row_index == 1),
            "Knight Rider spinner must survive (no cutoff to drop it)"
        );
        let chrome_only = !filtered.is_empty() && filtered.iter().all(|r| is_chrome_row(&r.text));
        // Aider's Knight Rider bar leads its row, so the structural is_spinner_row
        // matches it (#446-596f).
        let has_spinner = chrome_only
            && filtered
                .iter()
                .any(|r| crate::chrome::is_spinner_row(&r.text));
        assert!(
            !chrome_only || has_spinner,
            "Aider Knight Rider spinner must pass the busy transition gate"
        );
    }

    // --- Presence-driven working-status keepalive (Codex frozen-TUI false-idle) ---

    /// Codex freezes its TUI during a child subprocess (long `cargo`/`git`): the
    /// grid stops changing for minutes, so the change-driven spinner keepalive
    /// cannot refresh `last_output_ms` and the idle timer would falsely flip
    /// idle. The presence guard must still see the `• Working (… esc to
    /// interrupt)` line in the content zone and hold the agent busy.
    #[test]
    fn test_codex_frozen_working_line_holds_busy() {
        // Real layout (mirrors the live capture): the working line sits directly
        // above the `›` input prompt, with the model footer below it.
        let screen: Vec<String> = vec![
            "• Ran cargo test -p agent2-transport --locked".into(),
            "  └     Blocking waiting for file lock on package cache".into(),
            "    … +30 lines (ctrl + t to view transcript)".into(),
            "• Working (14m 56s • esc to interrupt)".into(),
            "› Improve documentation in @filename".into(),
            "  gpt-5.5 high · ~/Gits/LS/agent2".into(),
        ];
        assert_eq!(
            detect_codex_screen_activity(&screen),
            AgentScreenActivity::Working,
            "a frozen Codex working line above the prompt must keep the agent busy"
        );
    }

    /// When Codex finishes a turn the working line is gone (only the ready
    /// prompt remains) → the presence guard must NOT hold busy, so the idle
    /// timer is free to transition busy→idle normally.
    #[test]
    fn test_codex_ready_prompt_allows_idle() {
        let screen: Vec<String> = vec![
            "• Done. Added deny.toml and updated Cargo.toml.".into(),
            "› Improve documentation in @filename".into(),
            "  gpt-5.5 high · ~/Gits/LS/agent2".into(),
        ];
        assert_eq!(
            detect_codex_screen_activity(&screen),
            AgentScreenActivity::Ready,
            "a ready prompt with no working line must allow the idle transition"
        );
    }

    /// Regression: Codex separators divide tool output from the answer; they are
    /// not prompt-box chrome. The old presence helper applied find_chrome_cutoff,
    /// chose this separator over the later prompt, and discarded Working.
    #[test]
    fn test_codex_working_after_tool_separator_is_detected() {
        let screen: Vec<String> = vec![
            "• Ran cargo test --workspace".into(),
            "────────────────────────────────────────────────────────".into(),
            "• I am checking the remaining failures.".into(),
            "• Working (2m 55s • esc to interrupt)".into(),
            "› Add tests for the activity detector".into(),
            "  gpt-5.5 high · ~/repo".into(),
        ];
        let refs: Vec<&str> = screen.iter().map(String::as_str).collect();
        assert_eq!(
            crate::chrome::find_chrome_cutoff(&refs),
            Some(1),
            "fixture must reproduce the misleading generic cutoff"
        );
        assert_eq!(
            detect_codex_screen_activity(&screen),
            AgentScreenActivity::Working
        );
    }

    #[test]
    fn test_codex_historical_working_far_from_prompt_does_not_latch_busy() {
        let mut screen = vec!["• Working (1m • esc to interrupt)".to_string()];
        screen.extend((0..8).map(|n| format!("old transcript row {n}")));
        screen.push("› Ready for the next request".into());
        screen.push("  gpt-5.5 high · ~/repo".into());
        assert_eq!(
            detect_codex_screen_activity(&screen),
            AgentScreenActivity::Ready
        );
    }

    // ---------------------------------------------------------------------
    // Stuck-busy battery (#446-596f).
    //
    // Symptom history: sessions pinned BUSY forever by STATIC glyphs the screen
    // classifier read as a live spinner — a completed-turn summary (`✻ Sautéed
    // for 1m 25s`), a `· run /mcp` hint, a wiz HUD `░░` bar. Each glyph fix
    // regressed differently (a hash-based liveness gate blocked re-latching but
    // never demoted the Working classification, so the idle path stayed
    // unreachable).
    //
    // Definitive design: "if the text above the input area moves, the agent is
    // active — period." BUSY is latched/kept ONLY by movement (post-cutoff
    // `changed_rows` are text-equality diffed, so a frozen glyph produces no
    // ChangedRow and is inert by construction), by user submission, and by
    // hooks. The Claude/Gemini/Aider screen classifiers are PROMPT-based only
    // (Ready/Unknown, never Working), so a static glyph can never mask the
    // ready prompt or hold the idle path hostage. Codex is the one deliberate
    // exception: its presence-based `• Working (… esc to interrupt)` line holds
    // BUSY while its TUI legitimately freezes during a child process — accepted
    // policy: for Codex we prefer false-BUSY over false-IDLE.
    // ---------------------------------------------------------------------

    /// A representative Claude idle screen: assistant output, a summary/spinner
    /// line, a blank gap, then the input prompt.
    fn claude_screen_with(mid_line: &str) -> Vec<String> {
        vec![
            "⏺ Fixed the bug and ran the tests — all green.".into(),
            "".into(),
            "  Searched for 1 pattern, read 1 file (ctrl+o to expand)".into(),
            "".into(),
            mid_line.into(),
            "".into(),
            "❯ ".into(),
            "".into(),
        ]
    }

    /// The classifier no longer distinguishes summary from live spinner — it
    /// does not look at glyphs at all. A visible empty composer is Ready
    /// regardless of what static decoration sits above it; the idle path is
    /// always reachable.
    #[test]
    fn claude_classifier_is_prompt_based_never_working() {
        for mid in [
            "✻ Sautéed for 1m 25s",                 // completed-turn summary
            "✻ Sautéing… (12s · esc to interrupt)", // spinner frame (frozen render)
            "✳ Ideated for 2m 9s · 1 local agent still running",
            "· Proofed for 1m 14s (↓ 1.6k tokens)",
            "✽ Sautéed for 12s",
        ] {
            let screen = claude_screen_with(mid);
            assert_eq!(
                detect_claude_screen_activity(&screen),
                AgentScreenActivity::Ready,
                "{mid:?}: a visible empty ❯ composer is Ready — no glyph can mask it"
            );
        }
    }

    /// During real work Claude hides its prompt box: without a ❯ the screen is
    /// Unknown (never a heuristic idle source); BUSY is held by spinner/output
    /// movement in the reader, not by classification.
    #[test]
    fn claude_working_screen_without_prompt_is_unknown() {
        let screen: Vec<String> = vec![
            "⏺ Editing src/main.rs…".into(),
            "".into(),
            "✻ Sautéing… (12s · esc to interrupt)".into(),
            "".into(),
        ];
        assert_eq!(
            detect_claude_screen_activity(&screen),
            AgentScreenActivity::Unknown
        );
    }

    /// Live 2026-07-19 regression: Claude echoes the submitted argv prompt as a
    /// `❯ task` transcript row. While the turn is still running that historical
    /// row can remain inside the bottom scan window beside an animated spinner;
    /// it is not the empty composer and must never confirm idle.
    #[test]
    fn claude_submitted_prompt_row_is_not_a_ready_composer() {
        for prompt in [
            "❯ Read-only review the Windows native smoke scope",
            "  ❯ draft text not yet submitted",
        ] {
            let screen = vec![
                prompt.to_string(),
                "⏺ Reading 1 file…".into(),
                "✻ Boogieing…".into(),
            ];
            assert_eq!(
                detect_claude_screen_activity(&screen),
                AgentScreenActivity::Unknown,
                "only Claude's empty composer is Ready: {prompt:?}"
            );
        }
    }

    /// THE core invariant of the movement design: a byte-identical repaint of a
    /// frozen "spinner" line produces NO ChangedRow (text-equality diff in
    /// `TerminalGrid::process`), so it can never pass the reader's busy gate —
    /// while a genuinely animating frame always does.
    #[test]
    fn frozen_summary_repaint_produces_no_movement() {
        let mut grid = crate::terminal_grid::TerminalGrid::new(24, 80, 1000);
        let frame = "\x1b[H\x1b[2K\u{273B} Saut\u{00E9}ed for 1m 25s";
        let first = grid.process(frame.as_bytes());
        assert!(
            first.iter().any(|r| crate::chrome::is_spinner_row(&r.text)),
            "first paint of the line IS movement"
        );
        let repaint = grid.process(frame.as_bytes());
        assert!(
            repaint.is_empty(),
            "byte-identical repaint must produce no ChangedRow → no busy evidence"
        );
        let animated =
            grid.process("\x1b[H\x1b[2K\u{273B} Saut\u{00E9}ing\u{2026} (13s)".as_bytes());
        assert!(
            animated
                .iter()
                .any(|r| crate::chrome::is_spinner_row(&r.text)),
            "an animating spinner frame IS movement and keeps/latches BUSY"
        );
    }

    /// A real captured Claude idle screen: the `▐▛███▜▌` welcome banner (█ art),
    /// the empty `❯` input box framed by separators, and a wiz status-line HUD
    /// whose progress bar is a run of `░`/`█` block glyphs. Nothing here is an
    /// animated spinner — the turn is over and Claude waits for input.
    fn claude_idle_with_banner_and_hud() -> Vec<String> {
        vec![
            "╭─── Claude Code v2.1.202 ──────────────────────────────╮".into(),
            "│                   ▐▛███▜▌                   │ What's new".into(),
            "│                  ▝▜█████▛▘                  │ Forked subagents".into(),
            "│      Opus 4.8 (1M context) · Claude Team    │           ".into(),
            "╰───────────────────────────────────────────────────────╯".into(),
            "".into(),
            " ⚠ 2 MCP servers need authentication · run /mcp".into(),
            "".into(),
            "───────────────────────────────────────────────────────────".into(),
            "❯ ".into(),
            "───────────────────────────────────────────────────────────".into(),
            "  [Opus 4.8 (1M) | Team] ░░░░░░░░░░ 0% | cerebro | [C1 S33]".into(),
            "  5h: 52% (52m) | 7d: 18% (22h) | $0 | 📅 $124.01 | 13m".into(),
            "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents".into(),
        ]
    }

    /// #446-596f regression: block-glyph art (the welcome banner) and a status-
    /// line HUD progress bar (`░░░░`) are NOT Claude's animated spinner. Claude's
    /// spinner is dingbats (✻ ✳ ✶) / middle-dot `·`; solid blocks appear only in
    /// static art. Before the fix, `is_spinner_row` matched `█`/`░`, so an idle
    /// Claude prompt read Working and the session never returned to idle.
    #[test]
    fn claude_idle_with_wiz_hud_is_ready_not_working() {
        let screen = claude_idle_with_banner_and_hud();
        assert_eq!(
            detect_claude_screen_activity(&screen),
            AgentScreenActivity::Ready,
            "an idle Claude prompt under banner art, a `· run /mcp` hint and a \
             live wiz HUD is Ready, not Working"
        );
    }

    /// The wiz HUD ticks every second (elapsed timer, token counts), so the old
    /// frozen-signature liveness gate could not save us — the bar is genuinely
    /// changing. The only robust cut is that block glyphs are not a spinner.
    #[test]
    fn wiz_hud_progress_bar_is_not_a_claude_spinner() {
        let hud = "  [Opus 4.8 (1M) | Team] ██░░░░░░░░ 17% | cerebro".to_string();
        assert!(
            !crate::chrome::is_spinner_row(&hud),
            "a status-line progress bar is not an animated spinner"
        );
    }

    /// Guardrail: the fix must NOT break Aider, whose real "Knight Rider" spinner
    /// IS a run of block glyphs that LEADS its row, so the structural
    /// `is_spinner_row` still matches it — its movement latches/keeps BUSY via
    /// the reader gate. Classification stays prompt-based: mid-generation Aider
    /// has no input box, so the screen is Unknown (never a false Ready).
    #[test]
    fn aider_knight_rider_block_spinner_still_movement_evidence() {
        assert!(
            crate::chrome::is_spinner_row("░░░█░░░░░░"),
            "Aider's Knight Rider block spinner leads the row → still a spinner"
        );
        let generating: Vec<String> =
            vec!["Applied edit to src/main.rs".into(), "░░░█░░░░░░".into()];
        assert_eq!(
            detect_aider_screen_activity(&generating),
            AgentScreenActivity::Unknown,
            "no input box during generation → Unknown, BUSY held by movement"
        );
    }

    #[test]
    fn codex_working_is_presence_based_by_policy() {
        // Codex Working comes from the "esc to interrupt" status line presence,
        // NOT from movement: its TUI legitimately freezes for minutes while a
        // child process (cargo, git) runs. Accepted policy: prefer false-BUSY
        // over false-IDLE for Codex.
        let working = vec![
            "• Ran cargo test --workspace".to_string(),
            "• Working (2m 55s • esc to interrupt)".into(),
            "› Add tests".into(),
            "  gpt-5.6 high · ~/repo".into(),
        ];
        assert_eq!(
            detect_codex_screen_activity(&working),
            AgentScreenActivity::Working
        );
    }

    #[test]
    fn test_agent_ready_requires_stable_observation() {
        let mut silence = SilenceState::new();
        assert!(!silence.note_ready_screen());
        assert!(!silence.idle_confirmed);
        silence.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        assert!(silence.note_ready_screen());
        assert!(silence.idle_confirmed);
    }

    #[test]
    fn test_old_ready_prompt_cannot_cancel_new_submission_before_activity() {
        let mut silence = SilenceState::new();
        silence.note_user_submission(true);
        silence.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        assert!(!silence.note_ready_screen());
        assert!(silence.explicit_busy);
        assert!(!silence.idle_confirmed);

        silence.note_real_activity();
        silence.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        assert!(silence.note_ready_screen());
        assert!(silence.idle_confirmed);
    }

    #[test]
    fn test_stable_ready_prompt_recovers_missed_hook_idle_after_activity() {
        let mut silence = SilenceState::new();
        silence.note_user_submission(true);
        silence.note_explicit_state(SHELL_BUSY, true);
        silence.note_real_activity();
        silence.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        assert!(silence.note_ready_screen());
        assert!(!silence.explicit_busy);
        assert!(!silence.hook_busy);
        assert!(silence.idle_confirmed);
    }

    #[test]
    fn test_hook_busy_cannot_be_overridden_before_turn_activity() {
        let mut silence = SilenceState::new();
        silence.note_user_submission(true);
        silence.note_explicit_state(SHELL_BUSY, true);
        silence.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        assert!(!silence.note_ready_screen());
        assert!(silence.explicit_busy);
        assert!(silence.hook_busy);
        assert!(!silence.idle_confirmed);
    }

    #[test]
    fn test_fresh_hook_busy_blocks_ready_after_prior_recovery() {
        let mut silence = SilenceState::new();
        silence.note_user_submission(true);
        silence.note_explicit_state(SHELL_BUSY, true);
        silence.note_real_activity();
        silence.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        assert!(silence.note_ready_screen());

        silence.note_explicit_state(SHELL_BUSY, true);
        silence.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        assert!(!silence.note_ready_screen());
        assert!(silence.explicit_busy);
        assert!(silence.hook_busy);
        assert!(!silence.idle_confirmed);
    }

    #[test]
    fn test_working_row_cannot_relatch_a_declared_completed_turn() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "completed-working-row";
        state.session_states.insert(
            session_id.into(),
            crate::state::SessionState {
                agent_type: Some("codex".into()),
                ..Default::default()
            },
        );
        state.shell_states.insert(
            session_id.into(),
            std::sync::atomic::AtomicU8::new(SHELL_IDLE),
        );
        let mut lifecycle = SilenceState::new();
        lifecycle.confirm_idle();
        lifecycle.mark_suggest_candidate(vec!["Review diff".into()], 0);
        let lifecycle = Arc::new(Mutex::new(lifecycle));

        apply_working_evidence(
            &state,
            &lifecycle,
            session_id,
            now_epoch_ms(),
            "working-screen",
        );

        assert_eq!(
            state
                .shell_states
                .get(session_id)
                .unwrap()
                .load(std::sync::atomic::Ordering::Acquire),
            SHELL_IDLE
        );
        assert!(lifecycle.lock().idle_confirmed);
    }

    #[test]
    fn test_declared_completion_turns_stale_working_screen_into_ready_evidence() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "completed-working-timer";
        agent_session(&state, session_id, SHELL_BUSY);
        {
            let mut session = state.session_states.get_mut(session_id).unwrap();
            session.agent_type = Some("codex".into());
            session.background_probe_satisfied_turn_epoch = Some(session.turn_epoch);
        }
        let lifecycle = state.silence_states.get(session_id).unwrap().clone();
        {
            let mut lifecycle = lifecycle.lock();
            lifecycle.mark_suggest_candidate(vec!["Review diff".into()], 0);
            lifecycle.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        }

        let screen_activity = completion_adjusted_screen_activity(
            &state,
            &lifecycle,
            session_id,
            AgentScreenActivity::Working,
        );
        let transition = try_timer_idle_transition(
            &state,
            &lifecycle,
            session_id,
            screen_activity,
            Some("codex"),
            Some(0),
        );

        assert!(transition.screen_confirms_idle);
        assert!(transition.transitioned);
        assert_eq!(
            state
                .shell_states
                .get(session_id)
                .unwrap()
                .load(std::sync::atomic::Ordering::Acquire),
            SHELL_IDLE
        );
    }

    #[test]
    fn test_interrupt_request_plus_interrupted_screen_confirms_idle() {
        let mut silence = SilenceState::new();
        silence.note_explicit_state(SHELL_BUSY, true);
        silence.note_interrupt_requested();
        assert!(silence.note_interrupted_screen());
        assert!(!silence.explicit_busy);
        assert!(silence.idle_confirmed);
    }

    #[test]
    fn test_ctrl_c_alone_never_confirms_idle() {
        let mut silence = SilenceState::new();
        silence.note_explicit_state(SHELL_BUSY, true);
        silence.note_interrupt_requested();
        assert!(silence.explicit_busy);
        assert!(!silence.idle_confirmed);
    }

    #[test]
    fn test_working_screen_recovers_idle_to_busy() {
        use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "codex-false-idle";
        state
            .shell_states
            .insert(sid.into(), AtomicU8::new(SHELL_IDLE));
        state.last_output_ms.insert(sid.into(), AtomicU64::new(1));
        let silence = Arc::new(Mutex::new(SilenceState::new()));
        state.silence_states.insert(sid.into(), silence.clone());

        apply_working_evidence(&state, &silence, sid, now_epoch_ms(), "working-screen");

        assert_eq!(
            state.shell_states.get(sid).unwrap().load(Ordering::Acquire),
            SHELL_BUSY
        );
        assert!(!silence.lock().idle_confirmed);
    }

    #[test]
    fn test_explicit_idle_outvotes_stale_working_screen() {
        use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "codex-stale-working";
        state
            .shell_states
            .insert(sid.into(), AtomicU8::new(SHELL_IDLE));
        state.last_output_ms.insert(sid.into(), AtomicU64::new(1));
        let mut sl = SilenceState::new();
        sl.note_explicit_state(SHELL_IDLE, true);
        let silence = Arc::new(Mutex::new(sl));
        state.silence_states.insert(sid.into(), silence.clone());

        apply_working_evidence(&state, &silence, sid, now_epoch_ms(), "working-screen");

        assert_eq!(
            state.shell_states.get(sid).unwrap().load(Ordering::Acquire),
            SHELL_IDLE
        );
        assert!(silence.lock().idle_confirmed);
    }

    #[test]
    fn test_explicit_busy_suppresses_silence_question_until_idle() {
        let mut silence = SilenceState::new();
        silence.note_explicit_state(SHELL_BUSY, true);
        silence.last_output_at = std::time::Instant::now() - SILENCE_QUESTION_THRESHOLD;
        silence.pending_question_line = Some("Continue?".into());
        assert!(!silence.is_silent());
        silence.note_explicit_state(SHELL_IDLE, true);
        assert!(silence.is_silent());
    }

    #[test]
    fn test_other_agent_screen_adapters_are_prompt_based() {
        // Classification is prompt-based only (#446-596f): no prompt → Unknown
        // (BUSY is movement-driven in the reader), prompt → Ready. Gemini keeps
        // its prompt on screen even mid-work, so a working Gemini classifies
        // Ready — harmless, because its braille spinner repaints every second
        // and each movement resets `ready_since`, so the 1.5s ready confirm
        // never completes while it is genuinely working.
        let claude_working = vec!["✻ Cogitating… (12s)".into()];
        let claude_ready = vec!["Answer complete".into(), "❯".into()];
        let gemini_working_prompt_visible = vec![
            "⠴ Checking files… (esc to cancel, 14s)".into(),
            "────────────────────────".into(),
            "> Type your message".into(),
        ];
        let gemini_ready = vec!["> Type your message".into()];
        let aider_working = vec!["█░  Waiting for model".into()];
        let aider_ready = vec!["Tokens: 10k sent".into(), ">".into()];

        for (agent, rows, expected) in [
            ("claude", claude_working, AgentScreenActivity::Unknown),
            ("claude", claude_ready, AgentScreenActivity::Ready),
            (
                "gemini",
                gemini_working_prompt_visible,
                AgentScreenActivity::Ready,
            ),
            ("gemini", gemini_ready, AgentScreenActivity::Ready),
            ("aider", aider_working, AgentScreenActivity::Unknown),
            ("aider", aider_ready, AgentScreenActivity::Ready),
        ] {
            assert_eq!(detect_agent_screen_activity(Some(agent), &rows), expected);
        }
    }

    #[derive(Clone, Copy)]
    enum SanitizedTraceStep {
        Submit,
        RealActivity,
        WorkingScreen,
        ReadyScreen,
        UnknownScreen,
    }

    fn replay_sanitized_agent_trace(agent: &str, steps: &[SanitizedTraceStep]) -> SilenceState {
        let mut silence = SilenceState::new();
        silence.confirm_idle();
        for step in steps {
            match step {
                SanitizedTraceStep::Submit => silence.note_user_submission(true),
                SanitizedTraceStep::RealActivity => silence.note_real_activity(),
                SanitizedTraceStep::WorkingScreen => {
                    let rows = if agent == "codex" {
                        vec!["• Working".to_string(), "› sanitized prompt".to_string()]
                    } else {
                        vec!["sanitized animated output".to_string()]
                    };
                    if detect_agent_screen_activity(Some(agent), &rows)
                        == AgentScreenActivity::Working
                    {
                        silence.note_working_screen();
                    }
                }
                SanitizedTraceStep::ReadyScreen => {
                    let rows = match agent {
                        "codex" => vec!["sanitized final".into(), "› sanitized prompt".into()],
                        "claude" => vec!["sanitized final".into(), "❯".into()],
                        "gemini" => vec!["> Type your message".into()],
                        "aider" => vec![">".into()],
                        _ => Vec::new(),
                    };
                    if detect_agent_screen_activity(Some(agent), &rows)
                        == AgentScreenActivity::Ready
                    {
                        silence.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
                        silence.note_ready_screen();
                    }
                }
                SanitizedTraceStep::UnknownScreen => silence.note_unknown_screen(),
            }
        }
        silence
    }

    #[test]
    fn sanitized_codex_and_claude_trace_replay_requires_post_submit_consumption() {
        // Sanitized from the 2026-07-18 live sequence: ready prompt → injected
        // checkpoint → working/real output → final protocol text → ready prompt.
        // Repository paths, prompts, and response content are intentionally omitted.
        for agent in ["codex", "claude"] {
            let completed = replay_sanitized_agent_trace(
                agent,
                &[
                    SanitizedTraceStep::Submit,
                    SanitizedTraceStep::WorkingScreen,
                    SanitizedTraceStep::RealActivity,
                    SanitizedTraceStep::ReadyScreen,
                ],
            );
            assert!(completed.idle_confirmed, "{agent} completed trace");

            let silent = replay_sanitized_agent_trace(
                agent,
                &[
                    SanitizedTraceStep::Submit,
                    SanitizedTraceStep::ReadyScreen,
                    SanitizedTraceStep::ReadyScreen,
                ],
            );
            assert!(
                !silent.idle_confirmed,
                "{agent} silent/no-op submission must remain conservative without positive consumption"
            );

            let partial_redraw = replay_sanitized_agent_trace(
                agent,
                &[
                    SanitizedTraceStep::Submit,
                    SanitizedTraceStep::UnknownScreen,
                    SanitizedTraceStep::ReadyScreen,
                ],
            );
            assert!(
                !partial_redraw.idle_confirmed,
                "{agent} partial/alternate-screen redraw must not prove consumption"
            );
        }
    }

    fn process(pid: u32, parent_pid: u32, name: &str, command: &str) -> ProcessTreeEntry {
        ProcessTreeEntry {
            pid,
            parent_pid,
            name: name.to_string(),
            command: command.to_string(),
        }
    }

    #[test]
    fn sanitized_background_command_keeps_agent_working_across_adapters() {
        // Sanitized from the 2026-07-19 live Codex sequence. The same lifecycle
        // contract applies to Claude: a ready composer is not proof that an
        // autonomous background command has completed.
        for (index, agent) in ["codex", "claude"].into_iter().enumerate() {
            let session_root = 100 + index as u32 * 100;
            let agent_pid = session_root + 1;
            let processes = vec![
                process(session_root, 1, "zsh", "zsh"),
                process(agent_pid, session_root, agent, agent),
                process(
                    agent_pid + 1,
                    agent_pid,
                    "rtk",
                    "rtk env CARGO_BUILD_JOBS=4 cargo test --locked -p agent2-core",
                ),
                process(agent_pid + 2, agent_pid + 1, "cargo", "cargo test --locked"),
                process(
                    agent_pid + 3,
                    agent_pid + 2,
                    "agent2_core-test",
                    "target/debug/deps/agent2_core-test",
                ),
            ];
            let root = agent_process_root(session_root, agent, &processes).unwrap();
            assert_eq!(root, agent_pid, "{agent} adapter root");
            assert!(
                has_meaningful_descendant(root, &processes),
                "{agent} must retain autonomous work while cargo descendants live"
            );

            let silence = replay_sanitized_agent_trace(
                agent,
                &[
                    SanitizedTraceStep::Submit,
                    SanitizedTraceStep::RealActivity,
                    SanitizedTraceStep::ReadyScreen,
                ],
            );
            assert!(silence.idle_confirmed, "{agent} composer is terminal-ready");

            let state = crate::state::tests_support::make_test_app_state();
            let sid = format!("background-{agent}");
            state.session_states.insert(
                sid.clone(),
                crate::state::SessionState {
                    agent_type: Some(agent.to_string()),
                    background_work: true,
                    ..Default::default()
                },
            );
            state
                .shell_states
                .insert(sid.clone(), std::sync::atomic::AtomicU8::new(SHELL_IDLE));
            state
                .silence_states
                .insert(sid.clone(), Arc::new(Mutex::new(silence)));

            let snapshot = state.session_state_with_shell(&sid).unwrap();
            assert_eq!(snapshot.shell_state.as_deref(), Some("idle"));
            assert_eq!(snapshot.agent_state.as_deref(), Some("working"));
            assert!(
                should_inject_now(&state, &sid),
                "terminal-ready must remain usable independently of task lifecycle"
            );
        }
    }

    #[test]
    fn persistent_helpers_are_not_background_work() {
        let processes = vec![
            process(10, 1, "codex", "codex"),
            process(11, 10, "tuic-bridge", "tuic-bridge"),
            process(12, 10, "mdkb", "mdkb serve"),
            process(13, 10, "node", "node /opt/codex/node_repl.js"),
            // Descendants owned by helper plumbing are ignored with the helper.
            process(14, 12, "sqlite-worker", "sqlite-worker"),
        ];
        assert!(!has_meaningful_descendant(10, &processes));

        let mut with_real_child = processes;
        with_real_child.push(process(20, 10, "cargo", "cargo test --locked"));
        assert!(has_meaningful_descendant(10, &with_real_child));
    }

    #[cfg(not(windows))]
    #[test]
    fn timed_caffeinate_is_not_background_work_with_authoritative_argv() {
        let processes = vec![
            process(10, 1, "claude", "claude"),
            process(11, 10, "caffeinate", "caffeinate -i -t 300"),
        ];
        assert!(!has_meaningful_descendant(10, &processes));
    }

    #[test]
    fn timed_caffeinate_helper_does_not_hide_wrapped_work() {
        for command in ["caffeinate -i -t 300", "/usr/bin/caffeinate -t 300 -i"] {
            assert!(is_standalone_timed_caffeinate(command));
            assert!(is_persistent_agent_helper_with_command_line(
                &process(11, 10, "caffeinate", command),
                true
            ));
        }
        for command in [
            "caffeinate -i -t 0",
            "caffeinate -i",
            "caffeinate -i cargo test",
            "caffeinate -i -t 300 cargo test",
        ] {
            assert!(!is_standalone_timed_caffeinate(command));
        }

        let wrapped_work = vec![
            process(10, 1, "claude", "claude"),
            process(11, 10, "caffeinate", "caffeinate -i cargo test"),
            process(12, 11, "cargo", "cargo test"),
        ];
        assert!(has_meaningful_descendant(10, &wrapped_work));
    }

    #[cfg(not(windows))]
    #[test]
    fn background_snapshot_macos_truncated_comm_fixture_excludes_helpers() {
        // Sanitized from macOS `ps -ww -axo pid=,ppid=,comm=,args=` output.
        // Darwin may truncate `comm` while unlimited-width `args` retains the
        // executable path needed to identify persistent integration helpers.
        const MACOS_PS: &str = r#"
  700     1 /bin/zsh         /bin/zsh
  701   700 /Applications/C  /Applications/Codex.app/Contents/MacOS/codex
  702   701 /Users/boss/.lo  /Users/boss/.local/bin/mdkb serve
  703   701 /Users/boss/.ca  /Users/boss/.cache/tuic/tuic-bridge --stdio
  704   701 /opt/homebrew/b  /opt/homebrew/bin/node /Users/boss/.cache/tuic/node_repl.js
  705   702 sqlite-worker    sqlite-worker
"#;
        let processes = parse_process_tree_snapshot(true, MACOS_PS).unwrap();
        assert_eq!(agent_process_root(700, "codex", &processes), Some(701));
        assert!(!has_meaningful_descendant(701, &processes));
    }

    #[test]
    fn version_named_claude_path_is_the_agent_root() {
        let processes = vec![
            process(10, 1, "zsh", "zsh"),
            process(
                11,
                10,
                "/Users/test/.local/share/claude/versions/2.1.87",
                "2.1.87",
            ),
            process(12, 11, "cargo", "cargo test"),
        ];
        assert_eq!(agent_process_root(10, "claude", &processes), Some(11));
        assert_eq!(
            background_work_from_snapshot(10, "claude", &processes),
            Some(true)
        );
    }

    #[test]
    fn wrapper_is_not_counted_as_permanent_agent_work() {
        let idle = vec![
            process(20, 1, "claude-wrapper", "claude-wrapper"),
            process(21, 20, "/opt/claude/versions/2.1.87", "2.1.87"),
        ];
        assert_eq!(agent_process_root(20, "claude", &idle), Some(21));
        assert_eq!(
            background_work_from_snapshot(20, "claude", &idle),
            Some(false)
        );

        let custom_alias = vec![
            process(30, 1, "C2", "C2"),
            process(31, 30, "mdkb", "mdkb serve"),
        ];
        assert_eq!(agent_process_root(30, "claude", &custom_alias), Some(30));
        assert_eq!(
            background_work_from_snapshot(30, "claude", &custom_alias),
            Some(false)
        );
        let mut active_alias = custom_alias;
        active_alias.push(process(32, 30, "cargo", "cargo test"));
        assert_eq!(
            background_work_from_snapshot(30, "claude", &active_alias),
            Some(true)
        );
    }

    #[test]
    fn windows_helper_classification_does_not_guess_node_arguments() {
        let node = process(40, 10, "node.exe", "node.exe node_repl.js");
        assert!(is_persistent_agent_helper_with_command_line(&node, true));
        assert!(
            !is_persistent_agent_helper_with_command_line(&node, false),
            "Toolhelp exposes only the executable name, so node.exe remains meaningful"
        );
        let dedicated = process(41, 10, "node_repl.exe", "");
        assert!(is_persistent_agent_helper_with_command_line(
            &dedicated, false
        ));
    }

    #[cfg(not(windows))]
    #[test]
    fn process_snapshot_rejects_nonzero_and_malformed_output() {
        assert!(parse_process_tree_snapshot(false, "10 1 zsh zsh").is_none());
        assert!(parse_process_tree_snapshot(true, "10 invalid zsh zsh").is_none());
        assert!(parse_process_tree_snapshot(true, "10 1").is_none());
    }

    #[test]
    fn failed_first_process_entry_is_not_a_valid_snapshot() {
        assert!(valid_process_snapshot(false, vec![process(10, 1, "zsh", "zsh")]).is_none());
        assert!(valid_process_snapshot(true, Vec::new()).is_none());
    }

    #[test]
    fn process_snapshot_cache_is_shared_across_sessions() {
        let cache = ProcessSnapshotCache::default();
        cache.store(Some(vec![
            process(10, 1, "codex", "codex"),
            process(11, 10, "cargo", "cargo test"),
            process(20, 1, "claude", "claude"),
        ]));
        let (first_generation, first) = cache.load().unwrap();
        let (second_generation, second) = cache.load().unwrap();
        assert_eq!(first_generation, second_generation);
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(
            background_work_from_snapshot(10, "codex", &first),
            Some(true)
        );
        assert_eq!(
            background_work_from_snapshot(20, "claude", &second),
            Some(false)
        );
    }

    #[test]
    fn background_snapshot_ready_waits_for_newer_generation_and_repairs_working() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "background-ready-generation";
        let parent_id = "background-ready-parent";
        agent_session(&state, child_id, SHELL_BUSY);
        state.session_states.get_mut(child_id).unwrap().agent_type = Some("codex".into());
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        state
            .process_snapshot_cache
            .store(Some(vec![process(10, 1, "codex", "codex")]));
        state
            .silence_states
            .get(child_id)
            .unwrap()
            .lock()
            .ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);

        let first_ready = try_timer_idle_transition(
            &state,
            &state.silence_states.get(child_id).unwrap().clone(),
            child_id,
            AgentScreenActivity::Ready,
            Some("codex"),
            Some(0),
        );
        assert!(!first_ready.transitioned);
        assert!(state.agent_inbox.get(parent_id).unwrap().is_empty());

        state.process_snapshot_cache.store(Some(vec![
            process(10, 1, "codex", "codex"),
            process(11, 10, "cargo", "cargo test --locked"),
        ]));
        assert!(refresh_background_work_from_cached_snapshot(
            &state,
            child_id,
            10,
            "codex",
            0,
            state.process_snapshot_cache.load(),
        ));
        let snapshot = state.session_state_with_shell(child_id).unwrap();
        assert_eq!(snapshot.agent_state.as_deref(), Some("working"));
        assert!(snapshot.background_work);
        assert!(state.agent_inbox.get(parent_id).unwrap().is_empty());

        let reconciled_ready = try_timer_idle_transition(
            &state,
            &state.silence_states.get(child_id).unwrap().clone(),
            child_id,
            AgentScreenActivity::Ready,
            Some("codex"),
            Some(0),
        );
        assert!(reconciled_ready.transitioned);
        assert!(state.agent_inbox.get(parent_id).unwrap().is_empty());

        state
            .process_snapshot_cache
            .store(Some(vec![process(10, 1, "codex", "codex")]));
        assert!(refresh_background_work_from_cached_snapshot(
            &state,
            child_id,
            10,
            "codex",
            0,
            state.process_snapshot_cache.load(),
        ));
        let inbox = state.agent_inbox.get(parent_id).unwrap();
        let content: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(content["state"], "idle");
    }

    #[test]
    fn same_epoch_working_evidence_requires_a_new_ready_probe_boundary() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "background-same-epoch-ready";
        let parent_id = "background-same-epoch-parent";
        agent_session(&state, child_id, SHELL_BUSY);
        state.session_states.get_mut(child_id).unwrap().agent_type = Some("codex".into());
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        let silence = state.silence_states.get(child_id).unwrap().clone();

        state
            .process_snapshot_cache
            .store(Some(vec![process(10, 1, "codex", "codex")]));
        silence.lock().ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        assert!(
            !try_timer_idle_transition(
                &state,
                &silence,
                child_id,
                AgentScreenActivity::Ready,
                Some("codex"),
                Some(0),
            )
            .transitioned
        );

        state
            .process_snapshot_cache
            .store(Some(vec![process(10, 1, "codex", "codex")]));
        assert!(refresh_background_work_from_cached_snapshot(
            &state,
            child_id,
            10,
            "codex",
            0,
            state.process_snapshot_cache.load(),
        ));
        assert!(
            try_timer_idle_transition(
                &state,
                &silence,
                child_id,
                AgentScreenActivity::Ready,
                Some("codex"),
                Some(0),
            )
            .transitioned
        );
        assert_eq!(state.agent_inbox.get(parent_id).unwrap().len(), 1);
        assert_eq!(
            state
                .session_states
                .get(child_id)
                .unwrap()
                .background_probe_satisfied_turn_epoch,
            Some(0)
        );

        apply_working_evidence(&state, &silence, child_id, now_epoch_ms(), "working-screen");
        {
            let session = state.session_states.get(child_id).unwrap();
            assert_eq!(session.background_probe_satisfied_turn_epoch, None);
            assert_eq!(session.background_probe_turn_epoch, None);
            assert_eq!(session.background_probe_after_generation, None);
            assert_eq!(session.background_snapshot_generation, 2);
            assert!(!session.background_work);
        }

        silence.lock().ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);
        assert!(
            !try_timer_idle_transition(
                &state,
                &silence,
                child_id,
                AgentScreenActivity::Ready,
                Some("codex"),
                Some(0),
            )
            .transitioned
        );
        {
            let session = state.session_states.get(child_id).unwrap();
            assert_eq!(session.background_probe_turn_epoch, Some(0));
            assert_eq!(session.background_probe_after_generation, Some(2));
            assert_eq!(session.background_probe_satisfied_turn_epoch, None);
        }

        state.process_snapshot_cache.store(Some(vec![
            process(10, 1, "codex", "codex"),
            process(11, 10, "rtk", "rtk cargo test"),
            process(12, 11, "cargo", "cargo test"),
            process(13, 12, "rustc", "rustc --crate-name tuicommander"),
        ]));
        assert!(refresh_background_work_from_cached_snapshot(
            &state,
            child_id,
            10,
            "codex",
            0,
            state.process_snapshot_cache.load(),
        ));
        let working = state.session_state_with_shell(child_id).unwrap();
        assert_eq!(working.agent_state.as_deref(), Some("working"));
        assert!(working.background_work);

        assert!(
            try_timer_idle_transition(
                &state,
                &silence,
                child_id,
                AgentScreenActivity::Ready,
                Some("codex"),
                Some(0),
            )
            .transitioned
        );
        assert_eq!(state.agent_inbox.get(parent_id).unwrap().len(), 1);

        state
            .process_snapshot_cache
            .store(Some(vec![process(10, 1, "codex", "codex")]));
        assert!(refresh_background_work_from_cached_snapshot(
            &state,
            child_id,
            10,
            "codex",
            0,
            state.process_snapshot_cache.load(),
        ));
        assert_eq!(state.agent_inbox.get(parent_id).unwrap().len(), 2);
        let content: serde_json::Value = serde_json::from_str(
            &state
                .agent_inbox
                .get(parent_id)
                .unwrap()
                .back()
                .unwrap()
                .content,
        )
        .unwrap();
        assert_eq!(content["state"], "idle");

        state
            .process_snapshot_cache
            .store(Some(vec![process(10, 1, "codex", "codex")]));
        assert!(!refresh_background_work_from_cached_snapshot(
            &state,
            child_id,
            10,
            "codex",
            0,
            state.process_snapshot_cache.load(),
        ));
        assert_eq!(state.agent_inbox.get(parent_id).unwrap().len(), 2);
    }

    #[test]
    fn already_busy_working_evidence_invalidates_only_probe_boundaries() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "background-already-busy";
        agent_session(&state, child_id, SHELL_BUSY);
        {
            let mut session = state.session_states.get_mut(child_id).unwrap();
            session.agent_type = Some("codex".into());
            session.background_work = true;
            session.background_snapshot_generation = 9;
            session.background_probe_turn_epoch = Some(0);
            session.background_probe_after_generation = Some(8);
            session.background_probe_satisfied_turn_epoch = Some(0);
        }
        let silence = state.silence_states.get(child_id).unwrap().clone();

        apply_working_evidence(&state, &silence, child_id, now_epoch_ms(), "working-screen");
        {
            let session = state.session_states.get(child_id).unwrap();
            assert_eq!(session.background_probe_turn_epoch, None);
            assert_eq!(session.background_probe_after_generation, None);
            assert_eq!(session.background_probe_satisfied_turn_epoch, None);
            assert!(session.background_work);
            assert_eq!(session.background_snapshot_generation, 9);
        }

        {
            let mut session = state.session_states.get_mut(child_id).unwrap();
            session.background_probe_turn_epoch = Some(0);
            session.background_probe_after_generation = Some(9);
            session.background_probe_satisfied_turn_epoch = Some(0);
        }
        transition_explicit_shell_state_with_hook(
            &state,
            child_id,
            SHELL_BUSY,
            "busy",
            true,
            || {},
        );
        let session = state.session_states.get(child_id).unwrap();
        assert_eq!(session.background_probe_turn_epoch, None);
        assert_eq!(session.background_probe_after_generation, None);
        assert_eq!(session.background_probe_satisfied_turn_epoch, None);
        assert!(session.background_work);
        assert_eq!(session.background_snapshot_generation, 9);
        assert_eq!(
            state
                .shell_states
                .get(child_id)
                .unwrap()
                .load(Ordering::Acquire),
            SHELL_BUSY
        );
    }

    #[test]
    fn background_snapshot_child_absent_releases_declared_completion() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "background-ready-completed";
        let parent_id = "background-ready-completed-parent";
        agent_session(&state, child_id, SHELL_BUSY);
        state.session_states.get_mut(child_id).unwrap().agent_type = Some("codex".into());
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        state
            .silence_states
            .get(child_id)
            .unwrap()
            .lock()
            .mark_suggest_candidate(vec!["Review result".to_string()], 0);
        state
            .process_snapshot_cache
            .store(Some(vec![process(10, 1, "codex", "codex")]));
        state
            .silence_states
            .get(child_id)
            .unwrap()
            .lock()
            .ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);

        assert!(
            !try_timer_idle_transition(
                &state,
                &state.silence_states.get(child_id).unwrap().clone(),
                child_id,
                AgentScreenActivity::Ready,
                Some("codex"),
                Some(0),
            )
            .transitioned
        );
        assert!(state.agent_inbox.get(parent_id).unwrap().is_empty());

        state
            .process_snapshot_cache
            .store(Some(vec![process(10, 1, "codex", "codex")]));
        assert!(refresh_background_work_from_cached_snapshot(
            &state,
            child_id,
            10,
            "codex",
            0,
            state.process_snapshot_cache.load(),
        ));
        assert!(
            try_timer_idle_transition(
                &state,
                &state.silence_states.get(child_id).unwrap().clone(),
                child_id,
                AgentScreenActivity::Ready,
                Some("codex"),
                Some(0),
            )
            .transitioned
        );
        assert!(state.agent_inbox.get(parent_id).unwrap().is_empty());
        let silence = state.silence_states.get(child_id).unwrap().clone();
        assert!(emit_pending_suggest_if_idle(&state, &silence, child_id));
        let inbox = state.agent_inbox.get(parent_id).unwrap();
        let content: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(content["state"], "completed");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn claude_timed_caffeinate_does_not_delay_declared_completion() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "background-claude-caffeinate-completed";
        let parent_id = "background-claude-caffeinate-completed-parent";
        agent_session(&state, child_id, SHELL_BUSY);
        state.session_states.get_mut(child_id).unwrap().agent_type = Some("claude".into());
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        state
            .silence_states
            .get(child_id)
            .unwrap()
            .lock()
            .mark_suggest_candidate(vec!["Review result".to_string()], 0);
        state
            .process_snapshot_cache
            .store(Some(vec![process(10, 1, "claude", "claude")]));

        transition_explicit_shell_state_with_hook(
            &state,
            child_id,
            SHELL_IDLE,
            "idle",
            true,
            || {},
        );
        assert!(state.agent_inbox.get(parent_id).unwrap().is_empty());

        state.process_snapshot_cache.store(Some(vec![
            process(10, 1, "claude", "claude"),
            process(11, 10, "mdkb", "mdkb mcp"),
            process(12, 10, "tuic-bridge", "tuic-bridge"),
            process(13, 10, "caffeinate", "caffeinate -i -t 300"),
        ]));
        assert!(refresh_background_work_from_cached_snapshot(
            &state,
            child_id,
            10,
            "claude",
            0,
            state.process_snapshot_cache.load(),
        ));

        let resolved = state.session_state_with_shell(child_id).unwrap();
        assert_eq!(resolved.shell_state.as_deref(), Some("idle"));
        assert_eq!(resolved.agent_state.as_deref(), Some("completed"));
        assert!(!resolved.background_work);
        let inbox = state.agent_inbox.get(parent_id).unwrap();
        assert_eq!(inbox.len(), 1);
        let content: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(content["state"], "completed");
    }

    #[test]
    fn explicit_agent_idle_waits_for_newer_snapshot_and_repairs_working() {
        for (session_id, hook_state) in [
            ("background-hook-idle", true),
            ("background-osc133-idle", false),
        ] {
            let state = crate::state::tests_support::make_test_app_state();
            let parent_id = format!("{session_id}-parent");
            agent_session(&state, session_id, SHELL_BUSY);
            state.session_states.get_mut(session_id).unwrap().agent_type = Some("codex".into());
            state
                .session_parent
                .insert(session_id.to_string(), parent_id.clone());
            state.agent_inbox.entry(parent_id.clone()).or_default();
            state
                .process_snapshot_cache
                .store(Some(vec![process(10, 1, "codex", "codex")]));

            transition_explicit_shell_state_with_hook(
                &state,
                session_id,
                SHELL_IDLE,
                "idle",
                hook_state,
                || {},
            );

            assert_eq!(
                state
                    .shell_states
                    .get(session_id)
                    .unwrap()
                    .load(Ordering::Acquire),
                SHELL_IDLE
            );
            assert!(state.agent_inbox.get(&parent_id).unwrap().is_empty());
            assert!(!refresh_background_work_from_cached_snapshot(
                &state,
                session_id,
                10,
                "codex",
                0,
                state.process_snapshot_cache.load(),
            ));
            assert!(state.agent_inbox.get(&parent_id).unwrap().is_empty());

            state.process_snapshot_cache.store(Some(vec![
                process(10, 1, "codex", "codex"),
                process(11, 10, "cargo", "cargo test --locked"),
            ]));
            assert!(refresh_background_work_from_cached_snapshot(
                &state,
                session_id,
                10,
                "codex",
                0,
                state.process_snapshot_cache.load(),
            ));
            let snapshot = state.session_state_with_shell(session_id).unwrap();
            assert_eq!(snapshot.shell_state.as_deref(), Some("idle"));
            assert_eq!(snapshot.agent_state.as_deref(), Some("working"));
            assert!(snapshot.background_work);
            assert!(state.agent_inbox.get(&parent_id).unwrap().is_empty());
        }
    }

    #[test]
    fn explicit_agent_idle_child_absent_restores_api_state_and_notifies_once() {
        for (session_id, declare_completion, expected_state) in [
            ("background-explicit-idle", false, "idle"),
            ("background-explicit-completed", true, "completed"),
        ] {
            let state = crate::state::tests_support::make_test_app_state();
            let parent_id = format!("{session_id}-parent");
            agent_session(&state, session_id, SHELL_BUSY);
            state.session_states.get_mut(session_id).unwrap().agent_type = Some("codex".into());
            state
                .session_parent
                .insert(session_id.to_string(), parent_id.clone());
            state.agent_inbox.entry(parent_id.clone()).or_default();
            if declare_completion {
                state
                    .silence_states
                    .get(session_id)
                    .unwrap()
                    .lock()
                    .mark_suggest_candidate(vec!["Review result".to_string()], 0);
            }
            state
                .process_snapshot_cache
                .store(Some(vec![process(10, 1, "codex", "codex")]));

            transition_explicit_shell_state_with_hook(
                &state,
                session_id,
                SHELL_IDLE,
                "idle",
                true,
                || {},
            );
            assert!(state.agent_inbox.get(&parent_id).unwrap().is_empty());
            let pending = state.session_state_with_shell(session_id).unwrap();
            assert_eq!(pending.shell_state.as_deref(), Some("idle"));
            assert_eq!(pending.agent_state.as_deref(), Some("working"));
            assert!(pending.has_pending_background_probe());

            state
                .process_snapshot_cache
                .store(Some(vec![process(10, 1, "codex", "codex")]));
            assert!(refresh_background_work_from_cached_snapshot(
                &state,
                session_id,
                10,
                "codex",
                0,
                state.process_snapshot_cache.load(),
            ));
            let resolved = state.session_state_with_shell(session_id).unwrap();
            assert_eq!(resolved.agent_state.as_deref(), Some(expected_state));
            assert!(!resolved.has_pending_background_probe());
            let inbox = state.agent_inbox.get(&parent_id).unwrap();
            assert_eq!(inbox.len(), 1);
            let content: serde_json::Value =
                serde_json::from_str(&inbox.front().unwrap().content).unwrap();
            assert_eq!(content["state"], expected_state);
            drop(inbox);

            state
                .process_snapshot_cache
                .store(Some(vec![process(10, 1, "codex", "codex")]));
            assert!(!refresh_background_work_from_cached_snapshot(
                &state,
                session_id,
                10,
                "codex",
                0,
                state.process_snapshot_cache.load(),
            ));
            assert_eq!(state.agent_inbox.get(&parent_id).unwrap().len(), 1);
        }
    }

    #[test]
    fn explicit_non_agent_idle_keeps_immediate_shell_semantics() {
        for (session_id, hook_state) in [("plain-hook-idle", true), ("plain-osc133-idle", false)] {
            let state = crate::state::tests_support::make_test_app_state();
            state.session_states.insert(
                session_id.to_string(),
                crate::state::SessionState::default(),
            );
            state.shell_states.insert(
                session_id.to_string(),
                std::sync::atomic::AtomicU8::new(SHELL_BUSY),
            );
            state.silence_states.insert(
                session_id.to_string(),
                Arc::new(Mutex::new(SilenceState::new())),
            );

            transition_explicit_shell_state_with_hook(
                &state,
                session_id,
                SHELL_IDLE,
                "idle",
                hook_state,
                || {},
            );

            assert_eq!(
                state
                    .shell_states
                    .get(session_id)
                    .unwrap()
                    .load(Ordering::Acquire),
                SHELL_IDLE
            );
            let session = state.session_states.get(session_id).unwrap();
            assert_eq!(session.background_probe_turn_epoch, None);
            assert_eq!(session.background_probe_after_generation, None);
        }
    }

    #[test]
    fn background_snapshot_refresher_is_demand_gated_without_sleeping() {
        let state = crate::state::tests_support::make_test_app_state();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        assert!(!refresh_process_snapshot_if_demanded(&state, || {
            calls.fetch_add(1, Ordering::Relaxed);
            None
        }));
        assert_eq!(calls.load(Ordering::Relaxed), 0);

        let session_id = "background-demand";
        agent_session(&state, session_id, SHELL_BUSY);
        state.session_states.get_mut(session_id).unwrap().agent_type = Some("codex".into());
        state
            .session_states
            .get_mut(session_id)
            .unwrap()
            .background_probe_turn_epoch = Some(0);
        state
            .session_states
            .get_mut(session_id)
            .unwrap()
            .background_probe_after_generation = Some(0);

        assert!(refresh_process_snapshot_if_demanded(&state, || {
            calls.fetch_add(1, Ordering::Relaxed);
            Some(vec![process(10, 1, "codex", "codex")])
        }));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert!(refresh_background_work_from_cached_snapshot(
            &state,
            session_id,
            10,
            "codex",
            0,
            state.process_snapshot_cache.load(),
        ));
        assert!(!process_snapshot_is_demanded(&state));
        assert!(!refresh_process_snapshot_if_demanded(&state, || {
            calls.fetch_add(1, Ordering::Relaxed);
            None
        }));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    // --- Staleness counter tests ---

    #[test]
    fn test_silence_state_stale_after_many_output_chunks() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        // Simulate 15 non-`?` chunks (well beyond STALE_QUESTION_CHUNKS)
        for _ in 0..15 {
            s.on_chunk(false, None, false, false, false);
        }
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_silence(),
            None,
            "stale question after many chunks should not fire"
        );
    }

    #[test]
    fn test_silence_state_few_decoration_chunks_still_fires() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        // 3 decoration chunks (mode line, separator, prompt) — within threshold
        s.on_chunk(false, None, false, false, false);
        s.on_chunk(false, None, false, false, false);
        s.on_chunk(false, None, false, false, false);
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_silence(),
            Some("Continue?".to_string()),
            "few decoration chunks should still fire"
        );
    }

    #[test]
    fn test_silence_state_counter_resets_on_new_question() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("First?".to_string()), false, false, false);
        // Many non-`?` chunks → stale
        for _ in 0..15 {
            s.on_chunk(false, None, false, false, false);
        }
        // New `?` line resets the counter
        s.on_chunk(false, Some("Second?".to_string()), false, false, false);
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_silence(),
            Some("Second?".to_string()),
            "new question should reset staleness"
        );
    }

    // --- Screen verification tests ---

    #[test]
    fn test_verify_question_on_screen_found() {
        let screen = vec![
            "".to_string(),
            "Some output".to_string(),
            "Do you want to proceed?".to_string(),
            "⏵⏵ task_name".to_string(),
            "".to_string(),
        ];
        assert!(verify_question_on_screen(
            &screen,
            "Do you want to proceed?",
            5
        ));
    }

    #[test]
    fn test_verify_question_on_screen_ink_indented() {
        // Ink agents indent text with leading whitespace. extract_question_line
        // captures "  Want me to do that?" (with spaces), screen_rows also has
        // the same. Verification must match despite leading whitespace.
        let screen = vec![
            "⏺ Boss, this is a plan file".to_string(),
            "  Is that right?".to_string(),
            "".to_string(),
            "  Want me to do that?".to_string(),
            "".to_string(),
        ];
        // Question stored with leading whitespace from extract_question_line
        assert!(verify_question_on_screen(
            &screen,
            "  Want me to do that?",
            5
        ));
        // Also works if question was stored without whitespace
        assert!(verify_question_on_screen(&screen, "Want me to do that?", 5));
    }

    #[test]
    fn test_verify_question_on_screen_scrolled_away() {
        // Question is NOT among the last 5 rows
        let screen: Vec<String> = (0..24).map(|i| format!("line {i}")).collect();
        assert!(!verify_question_on_screen(
            &screen,
            "Do you want to proceed?",
            5
        ));
    }

    #[test]
    fn test_verify_question_on_screen_empty() {
        let screen: Vec<String> = vec![];
        assert!(!verify_question_on_screen(&screen, "Continue?", 5));
    }

    #[test]
    fn test_verify_question_on_screen_partial_match() {
        let screen = vec![
            "This is not a question? but has more text".to_string(),
            "".to_string(),
        ];
        // The stored question is just "question?" — substring should not match
        assert!(!verify_question_on_screen(&screen, "question?", 5));
    }

    // --- Clear stale question tests ---

    #[test]
    fn test_silence_state_clear_stale_resets_pending() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        s.clear_stale_question();
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(s.check_silence(), None, "cleared stale should not fire");
    }

    #[test]
    fn test_silence_state_clear_stale_allows_new_question() {
        let mut s = SilenceState::new();
        s.on_chunk(false, Some("Old?".to_string()), false, false, false);
        s.clear_stale_question();
        // New question after clear
        s.on_chunk(false, Some("New?".to_string()), false, false, false);
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(
            s.check_silence(),
            Some("New?".to_string()),
            "new question after clear should fire"
        );
    }

    #[test]
    fn test_silence_state_repaint_same_question_does_not_refire() {
        let mut s = SilenceState::new();
        // Question arrives, silence fires, mark emitted
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(s.check_silence().is_some());
        assert!(s.question_already_emitted);

        // Terminal repaint: same `?` line re-appears as a changed row.
        // This must NOT reset question_already_emitted.
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        assert!(
            s.question_already_emitted,
            "repaint of same question must not reset emitted flag"
        );
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(
            s.check_silence().is_none(),
            "same question repaint must not re-fire"
        );
    }

    #[test]
    fn test_silence_state_stale_same_question_scroll_does_not_refire() {
        let mut s = SilenceState::new();
        let past = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        // Question fires via chunk-based detection (Strategy 2)
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        s.last_output_at = past;
        assert!(s.check_silence().is_some());

        // Agent resumes: 15 non-`?` chunks (above STALE_QUESTION_CHUNKS)
        for _ in 0..15 {
            s.on_chunk(false, None, false, false, false);
        }
        assert!(
            s.pending_question_line.is_none(),
            "pending should be cleared by staleness"
        );

        // Same "Continue?" reappears in changed_rows because new output scrolled it
        // to a different row. This is NOT a new question — must not re-fire.
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        assert!(
            s.question_already_emitted,
            "scroll of previously emitted question must not reset emitted flag"
        );
        s.last_output_at = past;
        assert!(
            s.check_silence().is_none(),
            "same question text from scroll must not re-fire"
        );
    }

    #[test]
    fn test_silence_state_stale_same_question_refires_after_user_input() {
        let mut s = SilenceState::new();
        let past = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        // Question fires
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        s.last_output_at = past;
        assert!(s.check_silence().is_some());

        // Agent resumes: 15 non-`?` chunks
        for _ in 0..15 {
            s.on_chunk(false, None, false, false, false);
        }

        // User provides input → new conversation cycle
        s.suppress_user_input();
        // Expire the echo suppression window so the next `?` line is not ignored
        s.suppress_echo_until =
            Some(std::time::Instant::now() - std::time::Duration::from_millis(1));

        // Same question arrives again — now it IS a new question (user answered)
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        s.last_output_at = past;
        assert_eq!(
            s.check_silence(),
            Some("Continue?".to_string()),
            "same question text after user input must fire as new question"
        );
    }

    #[test]
    fn test_silence_state_screen_emitted_question_scroll_does_not_refire() {
        let mut s = SilenceState::new();
        let past = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);

        // Question arrives in a chunk
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);

        // 15 non-? chunks → pending cleared by staleness
        for _ in 0..15 {
            s.on_chunk(false, None, false, false, false);
        }
        assert!(s.pending_question_line.is_none());

        // Silence timer (Strategy 1) finds "Continue?" on screen and emits.
        s.last_output_at = past;
        s.mark_emitted("Continue?");

        // New output causes scroll → same "Continue?" appears in changed_rows
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);

        // Must NOT reset question_already_emitted — it's a scroll artifact
        assert!(
            s.question_already_emitted,
            "scroll of screen-emitted question must not reset emitted flag"
        );
        s.last_output_at = past;
        assert!(
            !s.is_silent(),
            "same question after screen emission must not allow re-detection"
        );
    }

    #[test]
    fn test_silence_state_different_question_after_emitted_does_fire() {
        let mut s = SilenceState::new();
        // First question fires
        s.on_chunk(false, Some("Continue?".to_string()), false, false, false);
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert!(s.check_silence().is_some());

        // Different question arrives — this IS a new question, must fire
        s.on_chunk(
            false,
            Some("Are you sure?".to_string()),
            false,
            false,
            false,
        );
        s.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(s.check_silence(), Some("Are you sure?".to_string()));
    }

    // --- find_last_chat_question tests ---

    fn screen(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn test_find_last_chat_question_basic() {
        let rows = screen(&[
            "Do you want to proceed?",
            "",
            "────────────────────────────────",
            "> ",
            "────────────────────────────────",
            "⏵⏵ bypass permissions on",
        ]);
        assert_eq!(
            find_last_chat_question(&rows),
            Some("Do you want to proceed?".to_string()),
        );
    }

    #[test]
    fn test_find_last_chat_question_trailing_disclaimer_blocks_detection() {
        // When the agent emits trailing text AFTER the suggest block (e.g.
        // Claude Code's "(stopping here — waiting for your answer)" footer),
        // the last chat line is the disclaimer, not the question. We
        // deliberately do NOT scavenge past it — accepting this edge case
        // false negative in exchange for not crossing the agent-turn boundary
        // and matching the user's own previous `?`-ending input.
        let rows = screen(&[
            "⏺ FastAF v1.0.2 is connected.",
            "  intent: await handshake then relay fixed response (Await ACK)",
            "  Do you want me to proceed with this fix?",
            "  suggest: 1) Screenshot overview panel | 2) Fix suggest scroll flicker | 3)",
            "   Fix Cmd+Shift+M keybinding collision | 4) Manual test OSC 133",
            "  (stopping here — waiting for your answer)",
            "────────",
            "❯ ",
            "────────",
            "  [Opus 4.6 | Max]",
            "  ⏵⏵ bypass permissions on",
        ]);
        assert_eq!(find_last_chat_question(&rows), None);
    }

    #[test]
    fn test_find_last_chat_question_does_not_cross_previous_input() {
        // The user previously typed `tutto ok?` (ending with a `?`), the agent
        // replied with a plain statement, then arrives at an empty prompt.
        // The walker MUST NOT scavenge past the agent statement to pick up
        // the user's own prior input — doing so fires a phantom question
        // notification 10s after the reply.
        let rows = screen(&[
            "❯ tutto ok?",
            "────────",
            "⏺ Sì, tutto funziona correttamente.",
            "  Il fix è stato verificato.",
            "────────",
            "❯ ",
            "────────",
            "  ⏵⏵ bypass permissions on",
        ]);
        assert_eq!(find_last_chat_question(&rows), None);
    }

    #[test]
    fn test_find_last_chat_question_skips_wrapped_suggest_block() {
        // Wrapped suggest between question and prompt must not block detection.
        let rows = screen(&[
            "Should I implement this approach?",
            "suggest: 1) Opzione A | 2) Opzione B | 3) Opzione molto lunga che continua",
            "su una seconda riga | 4) Quarta opzione",
            "────────────────────────────────",
            "> ",
            "────────────────────────────────",
            "⏵⏵ bypass permissions on",
        ]);
        assert_eq!(
            find_last_chat_question(&rows),
            Some("Should I implement this approach?".to_string()),
        );
    }

    #[test]
    fn test_find_last_chat_question_no_question() {
        // Agent statement (not a question) above prompt → None.
        let rows = screen(&[
            "I have completed the refactor.",
            "",
            "────────────────────────────────",
            "> ",
            "────────────────────────────────",
            "⏵⏵ bypass permissions on",
        ]);
        assert_eq!(find_last_chat_question(&rows), None);
    }

    #[test]
    fn test_find_last_chat_question_only_checks_first_chat_line() {
        // With multiple chat lines above the prompt, only the immediately
        // preceding one is considered — even if an older line ends with `?`.
        let rows = screen(&[
            "Old question from earlier?",
            "Here is some context.",
            "Do you agree with this plan?",
            "",
            "────────────────────────────────",
            "> ",
            "────────────────────────────────",
            "⏵⏵ bypass permissions on",
        ]);
        // Last chat line is the empty line (skipped), then "Do you agree…?" → detected
        assert_eq!(
            find_last_chat_question(&rows),
            Some("Do you agree with this plan?".to_string()),
        );
    }

    #[test]
    fn test_find_last_chat_question_non_question_last_line_blocks() {
        // If the last chat line above the prompt is not a question, we do NOT
        // keep walking upward to find an older question.
        let rows = screen(&[
            "Shall I proceed?",
            "Here is some unrelated follow-up text.",
            "────────────────────────────────",
            "> ",
            "────────────────────────────────",
            "⏵⏵ bypass permissions on",
        ]);
        assert_eq!(find_last_chat_question(&rows), None);
    }

    #[test]
    fn test_find_last_chat_question_rejects_code_syntax() {
        // `?` in code syntax must not be treated as a question.
        let rows = screen(&[
            "let x = map.get(&key)?",
            "",
            "────────────────────────────────",
            "> ",
            "────────────────────────────────",
            "⏵⏵ bypass permissions on",
        ]);
        assert_eq!(find_last_chat_question(&rows), None);
    }

    #[test]
    fn test_find_last_chat_question_codex_layout() {
        // Codex has no separator lines — the walk must still find the question.
        let rows = screen(&[
            "Do you want me to proceed?",
            "",
            "› ",
            "",
            "  gpt-5.3-codex high · 100% left · ~/project",
        ]);
        assert_eq!(
            find_last_chat_question(&rows),
            Some("Do you want me to proceed?".to_string()),
        );
    }

    // --- extract_question_line content filter tests ---

    fn make_rows(texts: &[&str]) -> Vec<ChangedRow> {
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| ChangedRow {
                row_index: i,
                text: t.to_string(),
            })
            .collect()
    }

    #[test]
    fn test_extract_question_line_rejects_code_comment() {
        let rows = make_rows(&["// What is this?"]);
        assert_eq!(extract_question_line(&rows), None);
    }

    #[test]
    fn test_extract_question_line_rejects_markdown_header() {
        let rows = make_rows(&["## FAQ?"]);
        assert_eq!(extract_question_line(&rows), None);
    }

    #[test]
    fn test_extract_question_line_rejects_diff_context() {
        assert_eq!(extract_question_line(&make_rows(&["+  if x?"])), None);
        assert_eq!(extract_question_line(&make_rows(&["-  if x?"])), None);
        assert_eq!(extract_question_line(&make_rows(&[">  quoted?"])), None);
    }

    #[test]
    fn test_extract_question_line_rejects_code_syntax() {
        assert_eq!(
            extract_question_line(&make_rows(&["fn foo() -> Option<bool>?"])),
            None
        );
        assert_eq!(
            extract_question_line(&make_rows(&["map.entry(key)?"])),
            None
        );
        assert_eq!(extract_question_line(&make_rows(&["let x = a::b?"])), None);
    }

    #[test]
    fn test_extract_question_line_accepts_real_question() {
        let rows = make_rows(&["Do you want to proceed?"]);
        assert_eq!(
            extract_question_line(&rows),
            Some("Do you want to proceed?".to_string())
        );
    }

    #[test]
    fn test_extract_question_line_accepts_yn_prompt() {
        // Y/n prompt ends with `]`, not `?` — extract_question_line only matches `?`-ending.
        // The actual question before the Y/n suffix ends with `?`:
        let rows = make_rows(&["Continue?"]);
        assert_eq!(extract_question_line(&rows), Some("Continue?".to_string()));
    }

    #[test]
    fn test_extract_question_line_accepts_short_natural_question() {
        // Boss confirmed: "continuo?" is a valid question
        let rows = make_rows(&["continuo?"]);
        assert_eq!(extract_question_line(&rows), Some("continuo?".to_string()));
    }

    #[test]
    fn test_extract_question_line_rejects_asterisk_comment() {
        let rows = make_rows(&["* What is this?"]);
        assert_eq!(extract_question_line(&rows), None);
    }

    #[test]
    fn test_extract_question_line_accepts_parenthetical_options() {
        let rows = make_rows(&["Continue (yes/no)?"]);
        assert_eq!(
            extract_question_line(&rows),
            Some("Continue (yes/no)?".to_string())
        );
    }

    #[test]
    fn test_extract_question_line_accepts_yn_parens() {
        let rows = make_rows(&["Procedo (s/n)?"]);
        assert_eq!(
            extract_question_line(&rows),
            Some("Procedo (s/n)?".to_string())
        );
    }

    #[test]
    fn test_extract_question_line_accepts_option_prompt() {
        let rows = make_rows(&["Apply changes (y)?"]);
        assert_eq!(
            extract_question_line(&rows),
            Some("Apply changes (y)?".to_string())
        );
    }

    #[test]
    fn test_extract_question_line_rejects_rust_try() {
        assert_eq!(extract_question_line(&make_rows(&["foo.bar()?"])), None);
    }

    #[test]
    fn test_extract_question_line_rejects_generic_try() {
        // Also caught by `::` filter
        assert_eq!(extract_question_line(&make_rows(&["Vec::new()?"])), None);
    }

    #[test]
    fn test_extract_question_line_rejects_method_chain_try() {
        assert_eq!(
            extract_question_line(&make_rows(&["iter().map(|x| x)?"])),
            None
        );
    }

    // --- Prompt-prefixed user input rejection ---

    #[test]
    fn test_extract_question_line_rejects_claude_prompt() {
        assert_eq!(extract_question_line(&make_rows(&["❯ tutto ok?"])), None);
    }

    #[test]
    fn test_extract_question_line_rejects_codex_prompt() {
        assert_eq!(
            extract_question_line(&make_rows(&["› is this done?"])),
            None
        );
    }

    #[test]
    fn test_extract_question_line_rejects_gemini_prompt() {
        assert_eq!(
            extract_question_line(&make_rows(&["> are you sure?"])),
            None
        );
    }

    #[test]
    fn test_find_last_chat_question_rejects_user_prompt_line() {
        let rows: Vec<String> = vec![
            "❯ hai cambiato qualcosa?".into(),
            "────────────────────────────────────────────────".into(),
            "❯".into(),
            "────────────────────────────────────────────────".into(),
        ];
        assert_eq!(find_last_chat_question(&rows), None);
    }

    #[test]
    fn test_find_last_chat_question_agent_question_after_user_input() {
        let rows: Vec<String> = vec![
            "❯ tell me about this".into(),
            "Would you like me to continue?".into(),
            "────────────────────────────────────────────────".into(),
            "❯".into(),
            "────────────────────────────────────────────────".into(),
        ];
        assert_eq!(
            find_last_chat_question(&rows),
            Some("Would you like me to continue?".to_string())
        );
    }

    // --- Resize grace period tests ---

    #[test]
    fn test_resize_grace_active_immediately_after_resize() {
        let mut s = SilenceState::new();
        s.on_resize();
        assert!(
            s.is_resize_grace(),
            "grace period should be active right after resize"
        );
    }

    #[test]
    fn test_resize_grace_inactive_before_resize() {
        let s = SilenceState::new();
        assert!(
            !s.is_resize_grace(),
            "grace period should be inactive with no resize"
        );
    }

    #[test]
    fn test_resize_grace_expires_after_threshold() {
        let mut s = SilenceState::new();
        s.on_resize();
        // Backdating the resize timestamp past the grace period
        s.last_resize_at =
            Some(std::time::Instant::now() - RESIZE_GRACE - std::time::Duration::from_millis(100));
        assert!(!s.is_resize_grace(), "grace period should have expired");
    }

    #[test]
    fn test_resize_grace_refreshed_on_second_resize() {
        let mut s = SilenceState::new();
        s.on_resize();
        // Expire the first grace period
        s.last_resize_at =
            Some(std::time::Instant::now() - RESIZE_GRACE - std::time::Duration::from_millis(100));
        assert!(!s.is_resize_grace());
        // Second resize refreshes the timer
        s.on_resize();
        assert!(
            s.is_resize_grace(),
            "second resize should restart grace period"
        );
    }

    // --- Startup grace period tests ---

    #[test]
    fn test_startup_grace_active_on_new_session() {
        let s = SilenceState::new();
        assert!(
            s.is_startup_grace(),
            "startup grace should be active on new session"
        );
    }

    #[test]
    fn test_startup_grace_settles_after_silence() {
        let mut s = SilenceState::new();
        // Simulate output stopping long enough ago
        s.last_output_at = std::time::Instant::now()
            - STARTUP_SETTLE_SILENCE
            - std::time::Duration::from_millis(100);
        s.check_startup_settle();
        assert!(
            !s.is_startup_grace(),
            "startup grace should end after output silence"
        );
    }

    #[test]
    fn test_startup_grace_persists_during_output() {
        let mut s = SilenceState::new();
        // Output is recent — grace should persist
        s.last_output_at = std::time::Instant::now();
        s.check_startup_settle();
        assert!(
            s.is_startup_grace(),
            "startup grace should persist while output is flowing"
        );
    }

    #[test]
    fn test_startup_grace_safety_cap() {
        let mut s = SilenceState::new();
        // Created long ago, but output is recent — safety cap should force settle
        s.created_at =
            std::time::Instant::now() - STARTUP_GRACE_MAX - std::time::Duration::from_secs(1);
        s.last_output_at = std::time::Instant::now(); // output still flowing
        s.check_startup_settle();
        assert!(
            !s.is_startup_grace(),
            "startup grace should end at safety cap"
        );
    }

    #[test]
    fn test_startup_grace_idempotent_after_settle() {
        let mut s = SilenceState::new();
        s.last_output_at = std::time::Instant::now()
            - STARTUP_SETTLE_SILENCE
            - std::time::Duration::from_millis(100);
        s.check_startup_settle();
        assert!(s.startup_settled);
        // Calling again doesn't change anything
        s.check_startup_settle();
        assert!(s.startup_settled);
    }

    // --- VtLogBuffer + parse_clean_lines pipeline tests ---

    /// VtLogBuffer changed rows feed parse_clean_lines and produce a StatusLine event
    /// for normal screen output.
    #[test]
    fn test_vt_log_pipeline_status_line_normal_screen() {
        use crate::output_parser::{OutputParser, ParsedEvent};
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let mut parser = OutputParser::new();

        let changed = vt_log.process(b"* Reading files...");
        let events = parser.parse_clean_lines(&changed, true);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ParsedEvent::StatusLine { .. })),
            "expected StatusLine from normal screen, got: {:?}",
            events
        );
    }

    /// VtLogBuffer changed rows feed parse_clean_lines and produce an Intent event
    /// during alternate screen (e.g. Claude Code / Ink).
    #[test]
    fn test_vt_log_pipeline_intent_alternate_screen() {
        use crate::output_parser::{OutputParser, ParsedEvent};
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let mut parser = OutputParser::new();

        // Enter alternate screen (smcup: ESC[?1049h)
        let _ = vt_log.process(b"\x1b[?1049h");
        let changed = vt_log.process(b"intent: Doing work (Test)");
        let events = parser.parse_clean_lines(&changed, true);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ParsedEvent::Intent { .. })),
            "expected Intent from alternate screen, got: {:?}",
            events
        );
    }

    /// parse_osc94 is called on raw data (OSC 9;4 is invisible in clean rows).
    #[test]
    fn test_osc94_from_raw_stream() {
        use crate::output_parser::{ParsedEvent, parse_osc94};

        let raw = "\x1b]9;4;1;50\x07"; // OSC 9;4 progress 50%
        let event = parse_osc94(raw);
        assert!(
            matches!(event, Some(ParsedEvent::Progress { .. })),
            "expected Progress from raw OSC 9;4, got: {:?}",
            event
        );
    }

    /// extract_question_line finds `?`-ending rows from VtLogBuffer output.
    #[test]
    fn test_extract_question_line_basic() {
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let changed = vt_log.process(b"Would you like to proceed?");
        assert_eq!(
            extract_question_line(&changed).as_deref(),
            Some("Would you like to proceed?")
        );
    }

    /// Question row must be found even when a mode line with a higher row index
    /// arrives in the same chunk (e.g. Claude Code question + ⏵⏵ status line).
    #[test]
    fn test_extract_question_line_with_mode_line_same_chunk() {
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let data = b"Le committo?\r\n\r\n\xe2\x8f\xb5\xe2\x8f\xb5 Reading files";
        let changed = vt_log.process(data);
        assert_eq!(
            extract_question_line(&changed).as_deref(),
            Some("Le committo?"),
            "question must be found even when mode line is on a later row; changed_rows: {:?}",
            changed
                .iter()
                .map(|r| format!("[{}] {:?}", r.row_index, &r.text))
                .collect::<Vec<_>>()
        );
    }

    /// Question must be found in alternate screen with cursor-positioned rows.
    #[test]
    fn test_extract_question_line_alternate_screen() {
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let _ = vt_log.process(b"\x1b[?1049h");
        let data = b"\x1b[5;1HDo you want to proceed?\x1b[23;1H* Thinking...";
        let changed = vt_log.process(data);
        assert_eq!(
            extract_question_line(&changed).as_deref(),
            Some("Do you want to proceed?"),
            "question must be found in alternate screen; changed_rows: {:?}",
            changed
                .iter()
                .map(|r| format!("[{}] {:?}", r.row_index, &r.text))
                .collect::<Vec<_>>()
        );
    }

    /// End-to-end: VtLogBuffer → extract_question_line → SilenceState → check_silence.
    /// Question + mode line arrive together → fires at 10s.
    #[test]
    fn test_e2e_question_detection_with_mode_line() {
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let mut silence = SilenceState::new();

        let changed = vt_log.process(b"Le committo?\r\n\r\n\xe2\x8f\xb5\xe2\x8f\xb5 Reading files");
        silence.on_chunk(false, extract_question_line(&changed), false, false, false);

        assert_eq!(
            silence.pending_question_line.as_deref(),
            Some("Le committo?")
        );

        silence.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(silence.check_silence(), Some("Le committo?".to_string()));
    }

    /// End-to-end: question in chunk 1, mode line in chunk 2, then silence.
    /// Non-`?` output must NOT prevent the question from firing at 10s.
    #[test]
    fn test_e2e_question_then_decoration_then_silence() {
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let mut silence = SilenceState::new();

        let changed = vt_log.process(b"Le committo?");
        silence.on_chunk(false, extract_question_line(&changed), false, false, false);

        // Mode line / prompt decoration arrives in a separate chunk
        let changed = vt_log.process(b"\r\n\xe2\x8f\xb5\xe2\x8f\xb5 Idle");
        silence.on_chunk(false, extract_question_line(&changed), false, false, false);

        // 10s silence → fires
        silence.last_output_at = std::time::Instant::now()
            - SILENCE_QUESTION_THRESHOLD
            - std::time::Duration::from_millis(100);
        assert_eq!(silence.check_silence(), Some("Le committo?".to_string()));
    }

    // --- Headless reader structured event tests ---

    /// The headless reader logic: after process(), parse_clean_lines produces events.
    /// This verifies the core data flow without spawning a full AppState.
    #[test]
    fn test_headless_reader_intent_event_logic() {
        use crate::output_parser::{OutputParser, ParsedEvent};
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let mut parser = OutputParser::new();

        let changed = vt_log.process(b"intent: Testing headless reader");
        let events = parser.parse_clean_lines(&changed, true);

        assert!(
            events
                .iter()
                .any(|e| matches!(e, ParsedEvent::Intent { .. })),
            "expected Intent from headless reader logic, got: {:?}",
            events
        );
    }

    /// The headless reader emits events for alternate screen content (e.g. Claude Code).
    #[test]
    fn test_headless_reader_alternate_screen_events() {
        use crate::output_parser::{OutputParser, ParsedEvent};
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let mut parser = OutputParser::new();

        let _ = vt_log.process(b"\x1b[?1049h"); // enter alternate screen
        let changed = vt_log.process(b"* Reading files...");
        let events = parser.parse_clean_lines(&changed, true);

        assert!(
            events
                .iter()
                .any(|e| matches!(e, ParsedEvent::StatusLine { .. })),
            "headless reader must detect StatusLine during alternate screen, got: {:?}",
            events
        );
    }

    // --- Escape sequence handling diagnostics (using TerminalGrid) ---

    /// Verify that `\x1b[<n>F` (CPL — Cursor Previous Line) is handled
    /// and does NOT leak parameter digits into screen cell text.
    #[test]
    fn test_cpl_sequence_does_not_leak() {
        let mut grid = crate::terminal_grid::TerminalGrid::new(24, 80, 0);
        grid.process(b"\n");
        grid.process(b"old content here\n");
        grid.process(b"\x1b[1F");
        grid.process(b"new content");
        let row1 = grid.get_row_text(1);
        assert_eq!(
            row1.trim_end(),
            "new content here",
            "CPL should move cursor up; row1 = {:?}",
            row1
        );
        assert!(
            !row1.contains("1F"),
            "escape param '1F' leaked into screen text: {:?}",
            row1
        );
    }

    /// Verify that `\x1b[<n>E` (CNL — Cursor Next Line) is handled.
    #[test]
    fn test_cnl_sequence_does_not_leak() {
        let mut grid = crate::terminal_grid::TerminalGrid::new(24, 80, 0);
        grid.process(b"line0");
        grid.process(b"\x1b[1E");
        grid.process(b"line1");
        let row0 = grid.get_row_text(0);
        let row1 = grid.get_row_text(1);
        assert_eq!(
            row0.trim_end(),
            "line0",
            "row0 should be unchanged; got {:?}",
            row0
        );
        assert_eq!(
            row1.trim_end(),
            "line1",
            "CNL should move cursor down; got {:?}",
            row1
        );
    }

    /// Simulate Ink-style rendering: write intent, then use CPL to update it.
    /// This is what Claude Code does when updating its status line.
    #[test]
    fn test_vt100_ink_style_intent_with_cpl() {
        use crate::output_parser::{OutputParser, ParsedEvent};
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let mut parser = OutputParser::new();

        // Simulate Ink render: write placeholder, then CPL + overwrite with intent
        let _ = vt_log.process(b"\x1b[?1049h"); // alternate screen
        let _ = vt_log.process(b"placeholder text\r\n");
        // Ink update: go up, clear line, write intent
        let changed =
            vt_log.process(b"\x1b[1F\x1b[2Kintent: Fix all 34 documentation gaps (Fixing gaps)");
        let events = parser.parse_clean_lines(&changed, true);
        let intent = events.iter().find_map(|e| match e {
            ParsedEvent::Intent { text, title, .. } => Some((text.clone(), title.clone())),
            _ => None,
        });
        assert!(
            intent.is_some(),
            "intent must be detected after CPL overwrite; changed={:?}, events={:?}",
            changed,
            events
        );
        let (text, title) = intent.unwrap();
        assert_eq!(
            text, "Fix all 34 documentation gaps",
            "intent text must be clean (no '1F' leak); got: {:?}",
            text
        );
        assert_eq!(title.as_deref(), Some("Fixing gaps"));
    }

    /// Chunked delivery: CSI split across two process() calls.
    /// Verifies the vt100 parser buffers incomplete escapes correctly.
    #[test]
    fn test_vt100_chunked_csi_does_not_leak() {
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let _ = vt_log.process(b"\x1b[?1049h"); // alternate screen
        let _ = vt_log.process(b"old line\r\n");

        // Chunk 1: partial CSI (just the introducer)
        let changed1 = vt_log.process(b"\x1b[");
        // Chunk 2: parameter + final byte completing CPL, then text
        let changed2 = vt_log.process(b"1Fintent: Fix all gaps");

        // Check that no row contains literal "1F" as text
        for row in changed1.iter().chain(changed2.iter()) {
            assert!(
                !row.text.contains("1F"),
                "chunked CSI leaked '1F' into row text: {:?}",
                row.text
            );
        }
    }

    /// Test what happens when CSI is aborted by an unexpected byte.
    #[test]
    fn test_aborted_csi_does_not_leak_digits() {
        let mut grid = crate::terminal_grid::TerminalGrid::new(24, 80, 0);
        // \x1b[1\x1b[2K — the first CSI is aborted by the second ESC
        grid.process(b"\x1b[1\x1b[2KHello");
        let row = grid.get_row_text(0);
        eprintln!("aborted CSI row: {:?}", row);
        assert!(
            !row.starts_with('1'),
            "aborted CSI parameter '1' should not appear in cell text: {:?}",
            row
        );
    }

    /// Test that unknown private CSI sequences don't leak.
    #[test]
    fn test_unknown_private_csi_does_not_leak() {
        let mut grid = crate::terminal_grid::TerminalGrid::new(24, 80, 0);
        // \x1b[?1234z — fictional private sequence with unknown final byte 'z'
        grid.process(b"\x1b[?1234zVisible text");
        let row = grid.get_row_text(0);
        eprintln!("unknown private CSI row: {:?}", row);
        assert_eq!(
            row.trim_end(),
            "Visible text",
            "unknown private CSI should not leak; got: {:?}",
            row
        );
    }

    /// Simulate realistic Ink output with SGR + cursor movement + text.
    /// This mimics what Claude Code actually sends through the PTY.
    #[test]
    fn test_vt100_realistic_ink_render_cycle() {
        use crate::output_parser::{OutputParser, ParsedEvent};
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let mut parser = OutputParser::new();

        let _ = vt_log.process(b"\x1b[?1049h"); // alternate screen

        // Frame 1: Ink renders initial content with colors
        let _ = vt_log.process(
            b"\x1b[1;1H\x1b[38;2;128;128;128m\xe2\x97\x8f\x1b[0m \x1b[1mintent: Reading codebase structure (Reading code)\x1b[0m"
        );

        // Frame 2: Ink updates — cursor up, erase line, rewrite
        // This is how Ink typically does incremental updates
        let changed = vt_log.process(
            b"\x1b[1F\x1b[2K\x1b[38;2;128;128;128m\xe2\x97\x8f\x1b[0m \x1b[1mintent: Fix all 34 documentation gaps (Fixing gaps)\x1b[0m"
        );

        let events = parser.parse_clean_lines(&changed, true);
        let intent = events.iter().find_map(|e| match e {
            ParsedEvent::Intent { text, title, .. } => Some((text.clone(), title.clone())),
            _ => None,
        });

        // Print all changed rows for debugging
        eprintln!("changed rows:");
        for r in &changed {
            eprintln!("  row[{}]: {:?}", r.row_index, r.text);
        }
        eprintln!("events: {:?}", events);

        assert!(
            intent.is_some(),
            "intent must be detected in realistic Ink render; events={:?}",
            events
        );
        let (text, title) = intent.unwrap();
        assert!(
            !text.contains("1F"),
            "intent text must not contain escape leak '1F'; got: {:?}",
            text
        );
        assert_eq!(text, "Fix all 34 documentation gaps");
        assert_eq!(title.as_deref(), Some("Fixing gaps"));
    }

    /// Multi-chunk Ink render: data arrives in small fragments.
    #[test]
    fn test_vt100_fragmented_ink_output() {
        use crate::state::VtLogBuffer;

        let mut vt_log = VtLogBuffer::new(24, 80, 1000);
        let _ = vt_log.process(b"\x1b[?1049h");

        // Simulate fragmented delivery of: \x1b[1F\x1b[2Kintent: Fix all gaps
        let fragments: Vec<&[u8]> = vec![
            b"\x1b[", // CSI introducer
            b"1",     // parameter
            b"F",     // final byte (CPL)
            b"\x1b[", // CSI introducer
            b"2K",    // erase line
            b"intent: Fix all gaps",
        ];

        let mut all_changed = Vec::new();
        for frag in fragments {
            let changed = vt_log.process(frag);
            all_changed.extend(changed);
        }

        // Check no row contains '1F' leak
        for row in &all_changed {
            eprintln!("fragmented row[{}]: {:?}", row.row_index, row.text);
            assert!(
                !row.text.contains("1F"),
                "fragmented delivery leaked '1F': {:?}",
                row.text
            );
        }
    }

    // --- Shell state transition tests ---

    #[test]
    fn test_shell_state_busy_on_real_output() {
        use std::sync::atomic::{AtomicU8, Ordering};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_NULL));
        state.last_output_ms.insert(
            sid.to_string(),
            std::sync::atomic::AtomicU64::new(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            ),
        );

        // Transition null → busy
        assert!(
            try_shell_transition(&state, sid, SHELL_NULL, SHELL_BUSY, true),
            "should transition null → busy"
        );
        assert_eq!(
            state.shell_states.get(sid).unwrap().load(Ordering::Relaxed),
            SHELL_BUSY
        );

        // Transition busy → busy should fail (already busy, no re-emit)
        assert!(
            !try_shell_transition(&state, sid, SHELL_NULL, SHELL_BUSY, true),
            "should NOT re-transition to busy"
        );
    }

    #[test]
    fn test_shell_state_idle_after_500ms() {
        use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));
        state
            .session_states
            .insert(sid.to_string(), crate::state::SessionState::default());

        // Set last output to 600ms ago (> SHELL_IDLE_MS)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(now - 600));

        assert!(
            should_transition_idle(&state, sid).should_transition,
            "should be ready to transition idle (600ms elapsed, no sub-tasks)"
        );
        assert!(
            try_shell_transition(&state, sid, SHELL_BUSY, SHELL_IDLE, true),
            "should transition busy → idle"
        );
        assert_eq!(
            state.shell_states.get(sid).unwrap().load(Ordering::Relaxed),
            SHELL_IDLE
        );
    }

    #[test]
    fn test_shell_state_no_idle_with_subtasks() {
        use std::sync::atomic::{AtomicU8, AtomicU64};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));

        state.session_states.insert(
            sid.to_string(),
            crate::state::SessionState {
                active_sub_tasks: 2,
                ..Default::default()
            },
        );

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(now - 600));

        assert!(
            !should_transition_idle(&state, sid).should_transition,
            "should NOT transition idle when active_sub_tasks > 0 and elapsed < SUBTASK_STALE_MS"
        );
    }

    #[test]
    fn test_shell_state_idle_stale_subtasks_force_cleared() {
        use std::sync::atomic::{AtomicU8, AtomicU64};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));

        state.session_states.insert(
            sid.to_string(),
            crate::state::SessionState {
                active_sub_tasks: 2,
                ..Default::default()
            },
        );

        // Set last output to 31s ago (> SUBTASK_STALE_MS)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(now - 31_000));

        assert!(
            should_transition_idle(&state, sid).should_transition,
            "should transition idle when active_sub_tasks > 0 but elapsed >= SUBTASK_STALE_MS"
        );
        // Verify the stale counter was force-cleared
        let sub = state
            .session_states
            .get(sid)
            .map(|s| s.active_sub_tasks)
            .unwrap_or(999);
        assert_eq!(sub, 0, "active_sub_tasks should be force-cleared to 0");
    }

    /// Story 1366-2b3e/H1: when the stale-subtasks recovery path force-clears
    /// the in-memory counter, the caller must emit ActiveSubtasks{count:0}
    /// so the frontend store and notification gate also reset.
    #[test]
    fn test_force_cleared_subtasks_signal_propagates() {
        use std::sync::atomic::{AtomicU8, AtomicU64};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));
        state.session_states.insert(
            sid.to_string(),
            crate::state::SessionState {
                active_sub_tasks: 3,
                ..Default::default()
            },
        );
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(now - 31_000));

        let decision = should_transition_idle(&state, sid);
        assert!(
            decision.should_transition,
            "stale path must transition idle"
        );
        assert!(
            decision.force_cleared_subtasks,
            "stale path must signal force-clear so caller emits count=0"
        );

        // Subscribe BEFORE emitting so the broadcast is captured.
        let mut rx = state.event_bus.subscribe();
        emit_active_subtasks(&state, sid, 0, "");

        let event = rx.try_recv().expect("event bus must receive PtyParsed");
        match event {
            crate::state::AppEvent::PtyParsed { session_id, parsed } => {
                assert_eq!(session_id, sid);
                let kind = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
                assert_eq!(kind, "active-subtasks", "wrong event variant: {parsed}");
                let count = parsed.get("count").and_then(|v| v.as_u64()).unwrap_or(999);
                assert_eq!(count, 0, "count must be 0 to clear the badge");
            }
            other => panic!("unexpected event variant: {other:?}"),
        }
    }

    /// Inverse: the normal idle path (no sub-tasks at all) must NOT signal
    /// force_cleared_subtasks — otherwise we would emit redundant count=0
    /// events on every healthy busy→idle.
    #[test]
    fn test_normal_idle_does_not_signal_force_clear() {
        use std::sync::atomic::{AtomicU8, AtomicU64};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));
        state
            .session_states
            .insert(sid.to_string(), crate::state::SessionState::default());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(now - 600));

        let decision = should_transition_idle(&state, sid);
        assert!(decision.should_transition);
        assert!(
            !decision.force_cleared_subtasks,
            "no-sub-tasks idle must not request a redundant count=0 emission"
        );
    }

    #[test]
    fn test_shell_state_no_idle_agent_session_under_agent_threshold() {
        use std::sync::atomic::{AtomicU8, AtomicU64};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));

        // Agent session: agent_type is set
        state.session_states.insert(
            sid.to_string(),
            crate::state::SessionState {
                agent_type: Some("claude".to_string()),
                ..Default::default()
            },
        );

        // 600ms elapsed — would trigger idle for a shell, but NOT for an agent session
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(now - 600));

        assert!(
            !should_transition_idle(&state, sid).should_transition,
            "agent session should NOT transition idle at 600ms (under AGENT_IDLE_MS)"
        );
    }

    #[test]
    fn test_shell_state_idle_agent_session_over_agent_threshold() {
        use std::sync::atomic::{AtomicU8, AtomicU64};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));

        // Agent session: agent_type is set
        state.session_states.insert(
            sid.to_string(),
            crate::state::SessionState {
                agent_type: Some("claude".to_string()),
                ..Default::default()
            },
        );

        // 3000ms elapsed — over the 2500ms agent threshold
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(now - 3000));

        assert!(
            should_transition_idle(&state, sid).should_transition,
            "agent session SHOULD transition idle after agent threshold"
        );
    }

    #[test]
    fn test_shell_state_no_idle_before_500ms() {
        use std::sync::atomic::{AtomicU8, AtomicU64};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));
        state
            .session_states
            .insert(sid.to_string(), crate::state::SessionState::default());

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(now - 200));

        assert!(
            !should_transition_idle(&state, sid).should_transition,
            "should NOT transition idle when only 200ms elapsed"
        );
    }

    #[test]
    fn test_shell_state_cas_prevents_duplicate_idle() {
        use std::sync::atomic::{AtomicU8, Ordering};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));

        // First CAS succeeds
        assert!(try_shell_transition(
            &state, sid, SHELL_BUSY, SHELL_IDLE, true
        ));
        // Second CAS fails (already idle)
        assert!(
            !try_shell_transition(&state, sid, SHELL_BUSY, SHELL_IDLE, true),
            "second idle transition must fail — already idle"
        );
        assert_eq!(
            state.shell_states.get(sid).unwrap().load(Ordering::Relaxed),
            SHELL_IDLE
        );
    }

    #[test]
    fn test_shell_state_idle_to_busy_on_real_output() {
        use std::sync::atomic::{AtomicU8, Ordering};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_IDLE));

        assert!(
            try_shell_transition(&state, sid, SHELL_IDLE, SHELL_BUSY, true),
            "should transition idle → busy on real output"
        );
        assert_eq!(
            state.shell_states.get(sid).unwrap().load(Ordering::Relaxed),
            SHELL_BUSY
        );
    }

    // --- Backup idle guard: has_recent_chunks ---

    #[test]
    fn test_has_recent_chunks_true_after_any_chunk() {
        let mut s = SilenceState::new();
        // Any chunk (including chrome-only) updates last_chunk_at
        s.on_chunk(false, None, true, true, false);
        assert!(
            s.has_recent_chunks(),
            "has_recent_chunks should be true right after any chunk"
        );
    }

    #[test]
    fn test_has_recent_chunks_true_after_real_chunk() {
        let mut s = SilenceState::new();
        s.on_chunk(false, None, false, false, false);
        assert!(
            s.has_recent_chunks(),
            "has_recent_chunks should be true right after a real output chunk"
        );
    }

    #[test]
    fn test_has_recent_chunks_false_when_no_chunks_for_2s() {
        let mut s = SilenceState::new();
        s.on_chunk(false, None, true, true, false);
        // Backdate last_chunk_at to 3 seconds ago
        s.last_chunk_at = std::time::Instant::now() - std::time::Duration::from_secs(3);
        assert!(
            !s.has_recent_chunks(),
            "has_recent_chunks should be false when last chunk was 3s ago"
        );
    }

    #[test]
    fn test_backup_idle_blocked_when_chunks_arriving() {
        use std::sync::atomic::{AtomicU8, AtomicU64};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-session";
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_BUSY));
        state
            .session_states
            .insert(sid.to_string(), crate::state::SessionState::default());

        // last_output_ms is 600ms ago (stale — would normally trigger idle)
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(now - 600));

        // Any chunk just arrived (real or chrome-only)
        let mut silence = SilenceState::new();
        silence.on_chunk(false, None, false, false, false); // chunk just arrived

        // should_transition_idle says yes (based on last_output_ms alone)
        assert!(
            should_transition_idle(&state, sid).should_transition,
            "should_transition_idle sees stale last_output_ms"
        );
        // But has_recent_chunks blocks the backup timer (recent chunk activity)
        assert!(
            silence.has_recent_chunks(),
            "backup idle must be blocked because chunks are arriving"
        );
    }

    #[test]
    fn test_backup_idle_blocked_by_chrome_only_ticks() {
        // Chrome-only ticks (status-line) MUST block the backup idle timer
        // because they prove the reader thread is active and the agent is alive.
        // Regression: f5c07388 changed has_recent_chunks() to use last_output_at,
        // which let the backup timer fire during tool calls (>3s of no real output
        // while status-line ticks every ~1s), causing false busy→idle oscillation.
        let mut silence = SilenceState::new();
        // Backdate real output to 5s ago (simulates a tool call in progress)
        silence.last_output_at = std::time::Instant::now() - std::time::Duration::from_secs(5);
        // Chrome-only tick just arrived (status-line timer tick)
        silence.on_chunk(false, None, true, true, false);
        assert!(
            silence.has_recent_chunks(),
            "backup idle MUST be blocked when chrome-only ticks are arriving — agent is alive"
        );
    }

    // Status-line idle transition: covered by test_backup_idle_blocked_by_chrome_only_ticks.
    // Status-line ticking proves the agent is alive — the reader thread's !has_status_line
    // guard blocks idle, and has_recent_chunks() (using last_chunk_at) blocks the backup timer.

    #[test]
    fn test_is_spinner_row_distinguishes_spinner_from_static_chrome() {
        // Spinner rows prove agent is alive
        assert!(crate::chrome::is_spinner_row("✻ Cogitated for 3m 47s"));
        assert!(crate::chrome::is_spinner_row("⠋ Generating..."));
        // Tool progress spinners prove agent is alive
        assert!(crate::chrome::is_spinner_row("◐ Bash: .../b..."));
        assert!(crate::chrome::is_spinner_row("◑ Read: src/main.rs"));
        // Static chrome does NOT prove agent is alive
        assert!(!crate::chrome::is_spinner_row("⏵ auto mode"));
        assert!(!crate::chrome::is_spinner_row("▀▀▀▀▀▀▀▀"));
    }

    // --- ChunkProcessor tests ---

    #[test]
    fn test_chunk_processor_new_has_correct_defaults() {
        let cp = ChunkProcessor::new(Some("/home/user/repo".to_string()), None);
        assert_eq!(cp.session_cwd, Some("/home/user/repo".to_string()));
        assert!(cp.last_status_task.is_none());
        assert!(cp.last_question_text.is_none());
        assert!(cp.last_choice_prompt_sig.is_none());
    }

    #[test]
    fn test_chunk_processor_dedup_status_task() {
        use crate::state::VtLogBuffer;
        use std::sync::atomic::AtomicU64;

        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let sid = "test-cp-dedup";
        let silence = Arc::new(Mutex::new(SilenceState::new()));
        state
            .silence_states
            .insert(sid.to_string(), silence.clone());
        state.shell_states.insert(
            sid.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_NULL),
        );
        state
            .vt_log_buffers
            .insert(sid.to_string(), Mutex::new(VtLogBuffer::new(24, 80, 1000)));
        state
            .output_buffers
            .insert(sid.to_string(), Mutex::new(OutputRingBuffer::new(4096)));
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(0));

        let mut cp = ChunkProcessor::new(None, None);
        let mut utf8_buf = Utf8ReadBuffer::new();
        let mut esc_buf = EscapeAwareBuffer::new();

        // First chunk with status line "* Reading files..."
        let raw = b"* Reading files...";
        let utf8_data = utf8_buf.push(raw);
        let esc_data = esc_buf.push(&utf8_data);
        let result1 = cp.process_chunk(&esc_data, &silence, sid, &state);

        // Count how many PtyParsed events were sent with StatusLine
        let mut rx = state.event_bus.subscribe();
        // Second chunk with same status — should be deduped
        let raw2 = b"\r\n* Reading files...";
        let utf8_data2 = utf8_buf.push(raw2);
        let esc_data2 = esc_buf.push(&utf8_data2);
        let _result2 = cp.process_chunk(&esc_data2, &silence, sid, &state);

        // Collect events from the second call
        let mut status_count = 0;
        while let Ok(evt) = rx.try_recv() {
            if let crate::state::AppEvent::PtyParsed { parsed, .. } = evt
                && parsed.get("type").and_then(|t| t.as_str()) == Some("StatusLine")
            {
                status_count += 1;
            }
        }
        assert_eq!(
            status_count, 0,
            "duplicate StatusLine with same task_name should be deduped"
        );

        // Verify the result contains data
        assert!(result1.is_some(), "first chunk should return data");
    }

    #[test]
    fn test_chunk_processor_dedup_choice_prompt() {
        use crate::state::VtLogBuffer;
        use std::sync::atomic::AtomicU64;

        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let sid = "test-cp-choice-dedup";
        let silence = Arc::new(Mutex::new(SilenceState::new()));
        state
            .silence_states
            .insert(sid.to_string(), silence.clone());
        state.shell_states.insert(
            sid.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_NULL),
        );
        state
            .vt_log_buffers
            .insert(sid.to_string(), Mutex::new(VtLogBuffer::new(24, 80, 1000)));
        state
            .output_buffers
            .insert(sid.to_string(), Mutex::new(OutputRingBuffer::new(4096)));
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(0));

        let mut cp = ChunkProcessor::new(None, None);
        let mut utf8_buf = Utf8ReadBuffer::new();
        let mut esc_buf = EscapeAwareBuffer::new();

        // Paint a Claude Code edit-confirm screen into the terminal.
        let screen_bytes = b"Do you want to make this edit to CLAUDE.md?\r\n\
              \xe2\x9d\xaf 1. Yes\r\n\
              \x20\x20 2. Yes, allow all edits (shift+tab)\r\n\
              \x20\x20 3. No\r\n\
              \r\n\
              Esc to cancel \xc2\xb7 Tab to amend\r\n";
        let utf8_data = utf8_buf.push(screen_bytes);
        let esc_data = esc_buf.push(&utf8_data);
        let _ = cp.process_chunk(&esc_data, &silence, sid, &state);

        // Drain events from the first chunk and count ChoicePrompt emits.
        let mut rx = state.event_bus.subscribe();

        // Second chunk: add an innocuous repaint (cursor home + re-emit same dialog).
        // Same (title, option keys) signature → must be deduped.
        let utf8_data2 = utf8_buf.push(screen_bytes);
        let esc_data2 = esc_buf.push(&utf8_data2);
        let _ = cp.process_chunk(&esc_data2, &silence, sid, &state);

        let mut choice_count = 0;
        while let Ok(evt) = rx.try_recv() {
            if let crate::state::AppEvent::PtyParsed { parsed, .. } = evt
                && parsed.get("type").and_then(|t| t.as_str()) == Some("choice-prompt")
            {
                choice_count += 1;
            }
        }
        assert_eq!(
            choice_count, 0,
            "second chunk with identical ChoicePrompt (same title + option keys) must be deduped",
        );
        assert!(
            cp.last_choice_prompt_sig.is_some(),
            "signature must be stored after first emission"
        );
    }

    #[test]
    fn test_chunk_processor_planfile_resolution() {
        let cp = ChunkProcessor::new(Some("/home/user/repo".to_string()), None);
        // Test that resolve_planfile_path resolves relative paths
        let resolved = cp.resolve_planfile_path("plans/foo.md");
        assert_eq!(resolved, Some("/home/user/repo/plans/foo.md".to_string()));
    }

    #[test]
    fn test_chunk_processor_planfile_resolution_absolute_passthrough() {
        let cp = ChunkProcessor::new(Some("/home/user/repo".to_string()), None);
        let resolved = cp.resolve_planfile_path("/absolute/path/plan.md");
        assert_eq!(resolved, Some("/absolute/path/plan.md".to_string()));
    }

    #[test]
    fn test_chunk_processor_planfile_resolution_no_cwd() {
        let cp = ChunkProcessor::new(None, None);
        // Relative path with no CWD should return None
        let resolved = cp.resolve_planfile_path("plans/foo.md");
        assert_eq!(resolved, None);
    }

    #[test]
    fn test_chunk_processor_planfile_normalizes_dotdot() {
        let cp = ChunkProcessor::new(Some("/home/user/repo__wt/feat".to_string()), None);
        let resolved = cp.resolve_planfile_path("../../repo/plans/foo.md");
        assert_eq!(resolved, Some("/home/user/repo/plans/foo.md".to_string()));
    }

    // --- transform_xterm tests ---

    #[test]
    fn test_transform_xterm_no_token_passes_through() {
        let mut cp = ChunkProcessor::new(None, None);
        let result = cp.transform_xterm("just regular output".to_string());
        assert_eq!(result, Some("just regular output".to_string()));
    }

    #[test]
    fn test_transform_xterm_intent_passes_through() {
        // Intent coloring is now handled by the frontend MutationObserver.
        let mut cp = ChunkProcessor::new(None, None);
        let result = cp.transform_xterm("intent: Fix the bug\n".to_string());
        assert!(result.is_some());
        let data = result.unwrap();
        assert!(
            data.contains("intent: Fix the bug"),
            "intent must pass through to frontend"
        );
    }

    #[test]
    fn test_transform_xterm_suggest_passes_through() {
        // Suggest lines are no longer concealed in Rust — the frontend handles it.
        let mut cp = ChunkProcessor::new(None, None);
        let result = cp.transform_xterm("suggest: A | B | C\n".to_string());
        assert!(result.is_some());
        let data = result.unwrap();
        assert!(
            data.contains("suggest:"),
            "suggest must pass through to frontend"
        );
    }

    #[test]
    fn test_transform_xterm_incomplete_intent_passes_through() {
        let mut cp = ChunkProcessor::new(None, None);
        let r1 = cp.transform_xterm("intent: doing so".to_string());
        assert!(r1.is_some(), "incomplete intent must pass through");
    }

    // --- alt buffer clear injection tests ---

    #[test]
    fn test_transform_xterm_alt_buffer_injects_clear() {
        let mut cp = ChunkProcessor::new(None, None);
        // Enter alt buffer
        cp.transform_xterm("\x1b[?1049h".to_string());
        assert!(cp.in_alt_buffer);
        // Cursor home should get ESC[2J injected
        let result = cp.transform_xterm("\x1b[Hcontent".to_string()).unwrap();
        assert!(
            result.contains("\x1b[2J\x1b[H"),
            "clear should be injected before cursor home"
        );
    }

    #[test]
    fn test_transform_xterm_normal_buffer_no_inject() {
        let mut cp = ChunkProcessor::new(None, None);
        // NOT in alt buffer — no injection
        let result = cp.transform_xterm("\x1b[Hcontent".to_string()).unwrap();
        assert!(
            !result.contains("\x1b[2J"),
            "should not inject clear in normal buffer"
        );
    }

    #[test]
    fn test_transform_xterm_alt_buffer_exit_stops_inject() {
        let mut cp = ChunkProcessor::new(None, None);
        // Enter then exit alt buffer
        cp.transform_xterm("\x1b[?1049h".to_string());
        cp.transform_xterm("\x1b[?1049l".to_string());
        assert!(!cp.in_alt_buffer);
        let result = cp.transform_xterm("\x1b[Hcontent".to_string()).unwrap();
        assert!(
            !result.contains("\x1b[2J"),
            "should not inject after leaving alt buffer"
        );
    }

    #[test]
    fn test_transform_xterm_alt_buffer_no_clear_on_subsequent_redraws() {
        let mut cp = ChunkProcessor::new(None, None);
        // Enter alt buffer — first cursor-home gets clear
        cp.transform_xterm("\x1b[?1049h".to_string());
        let r1 = cp
            .transform_xterm("\x1b[Hfirst redraw".to_string())
            .unwrap();
        assert!(r1.contains("\x1b[2J"), "first redraw must inject clear");

        // Subsequent redraws must NOT inject clear (prevents per-keystroke flicker)
        let r2 = cp
            .transform_xterm("\x1b[Hsecond redraw".to_string())
            .unwrap();
        assert!(
            !r2.contains("\x1b[2J"),
            "subsequent redraws must not inject clear"
        );
    }

    #[test]
    fn test_transform_xterm_alt_buffer_clear_on_shrink() {
        let mut cp = ChunkProcessor::new(None, None);
        // Enter alt buffer, consume initial clear
        cp.transform_xterm("\x1b[?1049h".to_string());
        cp.transform_xterm("\x1b[Hinit".to_string()); // consumes one-shot

        // Simulate growing content: cursor-up 50 lines
        cp.transform_xterm("\x1b[50A redraw tall".to_string());
        assert_eq!(cp.last_cursor_up_n, 50);

        // Simulate shrink: cursor-up only 20 lines (content got shorter)
        let r = cp
            .transform_xterm("\x1b[20A\x1b[Hredraw short".to_string())
            .unwrap();
        assert!(
            r.contains("\x1b[2J"),
            "clear must be injected when content shrinks"
        );
        assert_eq!(cp.last_cursor_up_n, 20);

        // Next redraw at same height — no clear
        let r2 = cp
            .transform_xterm("\x1b[20A\x1b[Hsame height".to_string())
            .unwrap();
        assert!(!r2.contains("\x1b[2J"), "no clear when height stays same");
    }

    #[test]
    fn test_transform_xterm_alt_buffer_clear_on_growth() {
        let mut cp = ChunkProcessor::new(None, None);
        // Enter alt buffer, consume initial clear via cursor-home
        cp.transform_xterm("\x1b[?1049h".to_string());
        cp.transform_xterm("\x1b[Hinit".to_string());

        // Establish baseline height
        cp.transform_xterm("\x1b[20Aredraw".to_string());
        assert_eq!(cp.last_cursor_up_n, 20);

        // Height grows — clear must fire (chrome shifted down, old top row is ghost)
        let r = cp
            .transform_xterm("\x1b[25A\x1b[Hredraw taller".to_string())
            .unwrap();
        assert!(
            r.contains("\x1b[2J"),
            "clear must be injected when content grows"
        );
    }

    #[test]
    fn test_transform_xterm_cursor_up_fallback_on_entry() {
        let mut cp = ChunkProcessor::new(None, None);
        // Enter alt buffer (sets alt_buffer_needs_clear)
        cp.transform_xterm("\x1b[?1049h".to_string());

        // Ink re-renders with cursor-up only, no cursor-home.
        // The fallback must inject ESC[2J before the cursor-up.
        let r = cp.transform_xterm("\x1b[30Acontent".to_string()).unwrap();
        assert!(
            r.contains("\x1b[2J\x1b[30A"),
            "clear must inject before cursor-up fallback"
        );
        assert!(!cp.alt_buffer_needs_clear, "flag must be consumed");
    }

    #[test]
    fn test_transform_xterm_cursor_up_fallback_on_shrink() {
        let mut cp = ChunkProcessor::new(None, None);
        cp.transform_xterm("\x1b[?1049h".to_string());
        cp.transform_xterm("\x1b[Hinit".to_string()); // consume entry flag

        // Establish height
        cp.transform_xterm("\x1b[40Aredraw".to_string());

        // Shrink with cursor-up only (no cursor-home) — fallback path
        let r = cp
            .transform_xterm("\x1b[25Aredraw short".to_string())
            .unwrap();
        assert!(
            r.contains("\x1b[2J\x1b[25A"),
            "cursor-up fallback must fire on shrink"
        );
    }

    #[test]
    fn test_transform_xterm_no_clear_on_normal_buffer_cursor_up() {
        let mut cp = ChunkProcessor::new(None, None);
        // NOT in alt buffer — cursor-up must NOT trigger clear injection
        let r = cp.transform_xterm("\x1b[10Acontent".to_string()).unwrap();
        assert!(!r.contains("\x1b[2J"), "must not inject in normal buffer");
    }

    #[test]
    fn test_extract_largest_cursor_up() {
        assert_eq!(extract_largest_cursor_up("\x1b[5A"), Some(5));
        assert_eq!(extract_largest_cursor_up("\x1b[10Afoo\x1b[3A"), Some(10));
        assert_eq!(extract_largest_cursor_up("no cursor up here"), None);
        assert_eq!(extract_largest_cursor_up("\x1b[H"), None); // cursor home, not up
    }

    // --- inject_clear_before_cursor_up tests ---

    #[test]
    fn test_inject_clear_before_cursor_up_basic() {
        let result = inject_clear_before_cursor_up("\x1b[20Acontent");
        assert_eq!(result, "\x1b[2J\x1b[20Acontent");
    }

    #[test]
    fn test_inject_clear_before_cursor_up_preserves_prefix() {
        let result = inject_clear_before_cursor_up("prefix\x1b[10Acontent");
        assert_eq!(result, "prefix\x1b[2J\x1b[10Acontent");
    }

    #[test]
    fn test_inject_clear_before_cursor_up_no_match() {
        let input = "no cursor up \x1b[H here";
        let result = inject_clear_before_cursor_up(input);
        assert_eq!(
            result, input,
            "cursor-home must NOT match cursor-up injection"
        );
    }

    #[test]
    fn test_inject_clear_before_cursor_up_bare_esc_a_ignored() {
        // ESC[A (no number) means cursor-up 1, but has no digit before A
        let input = "\x1b[Acontent";
        let result = inject_clear_before_cursor_up(input);
        assert_eq!(
            result, input,
            "bare ESC[A (no n) should not trigger injection"
        );
    }

    // --- log_anomalous_sequences tests ---

    #[test]
    fn log_anomalous_detects_clear_screen() {
        let found = detect_anomalous_sequences("\x1b[2J");
        assert_eq!(found, vec!["ESC[2J (Clear Screen)"]);
    }

    #[test]
    fn log_anomalous_detects_cursor_home() {
        let found = detect_anomalous_sequences("\x1b[H");
        assert_eq!(found, vec!["ESC[H (Cursor Home)"]);
    }

    #[test]
    fn log_anomalous_detects_cursor_home_explicit() {
        let found = detect_anomalous_sequences("\x1b[1;1H");
        assert_eq!(found, vec!["ESC[1;1H (Cursor Home)"]);
    }

    #[test]
    fn log_anomalous_detects_clear_scrollback() {
        let found = detect_anomalous_sequences("\x1b[3J");
        assert_eq!(found, vec!["ESC[3J (Clear Scrollback)"]);
    }

    #[test]
    fn log_anomalous_detects_alt_screen_enter() {
        let found = detect_anomalous_sequences("\x1b[?1049h");
        assert_eq!(found, vec!["ESC[?1049h (Alt Screen Enter)"]);
    }

    #[test]
    fn log_anomalous_detects_alt_screen_exit() {
        let found = detect_anomalous_sequences("\x1b[?1049l");
        assert_eq!(found, vec!["ESC[?1049l (Alt Screen Exit)"]);
    }

    #[test]
    fn log_anomalous_multiple_in_one_chunk() {
        let found = detect_anomalous_sequences("hello\x1b[2J\x1b[Hworld\x1b[3J");
        assert_eq!(
            found,
            vec![
                "ESC[2J (Clear Screen)",
                "ESC[H (Cursor Home)",
                "ESC[3J (Clear Scrollback)",
            ]
        );
    }

    #[test]
    fn log_anomalous_ignores_normal_sequences() {
        let found = detect_anomalous_sequences("\x1b[5A\x1b[10B\x1b[32mhello\x1b[0m");
        assert!(found.is_empty());
    }

    #[test]
    fn log_anomalous_ignores_cursor_position_not_home() {
        // ESC[5;10H is a regular cursor position, not anomalous
        let found = detect_anomalous_sequences("\x1b[5;10H");
        assert!(found.is_empty());
    }

    // --- inject_clear_before_cursor_home tests ---

    #[test]
    fn inject_clear_no_cursor_home() {
        let data = "hello world\x1b[5A\x1b[32mgreen\x1b[0m";
        assert_eq!(inject_clear_before_cursor_home(data), data);
    }

    #[test]
    fn inject_clear_before_bare_home() {
        let data = "\x1b[Hcontent after home";
        assert_eq!(
            inject_clear_before_cursor_home(data),
            "\x1b[2J\x1b[Hcontent after home"
        );
    }

    #[test]
    fn inject_clear_before_explicit_home() {
        let data = "\x1b[1;1Hcontent";
        assert_eq!(
            inject_clear_before_cursor_home(data),
            "\x1b[2J\x1b[1;1Hcontent"
        );
    }

    #[test]
    fn inject_clear_preserves_prefix() {
        let data = "prefix output\x1b[Hredraw content";
        assert_eq!(
            inject_clear_before_cursor_home(data),
            "prefix output\x1b[2J\x1b[Hredraw content"
        );
    }

    #[test]
    fn inject_clear_only_first_home() {
        // Only one ESC[2J should be injected, before the first ESC[H
        let data = "\x1b[Hline1\x1b[Hline2";
        let result = inject_clear_before_cursor_home(data);
        assert_eq!(result, "\x1b[2J\x1b[Hline1\x1b[Hline2");
        // Count occurrences of ESC[2J
        assert_eq!(result.matches("\x1b[2J").count(), 1);
    }

    #[test]
    fn inject_clear_ignores_non_home_cursor_position() {
        // ESC[5;10H is a regular cursor position, not home — should NOT inject
        let data = "\x1b[5;10Hcontent";
        assert_eq!(inject_clear_before_cursor_home(data), data);
    }

    #[test]
    fn inject_clear_preserves_utf8() {
        let data = "héllo → \x1b[Hworld 🌍";
        assert_eq!(
            inject_clear_before_cursor_home(data),
            "héllo → \x1b[2J\x1b[Hworld 🌍"
        );
    }

    // --- is_wsl_shell tests ---

    #[test]
    fn is_wsl_shell_bare() {
        assert!(super::is_wsl_shell("wsl.exe"));
        assert!(super::is_wsl_shell("WSL.EXE"));
        assert!(super::is_wsl_shell("wsl"));
    }

    #[test]
    fn is_wsl_shell_with_args() {
        assert!(super::is_wsl_shell("wsl.exe -d Ubuntu"));
        assert!(super::is_wsl_shell(
            "wsl.exe --distribution Debian -- /bin/zsh"
        ));
    }

    #[test]
    fn is_wsl_shell_full_path() {
        assert!(super::is_wsl_shell("C:\\Windows\\System32\\wsl.exe"));
        assert!(super::is_wsl_shell(
            "C:\\Windows\\System32\\wsl.exe -d Ubuntu"
        ));
    }

    #[test]
    fn is_wsl_shell_non_wsl() {
        assert!(!super::is_wsl_shell("powershell.exe"));
        assert!(!super::is_wsl_shell("/bin/zsh"));
        assert!(!super::is_wsl_shell("cmd.exe"));
        assert!(!super::is_wsl_shell("wslconfig.exe"));
    }

    // --- build_shell_command arg splitting tests ---

    #[test]
    fn build_shell_command_splits_args() {
        let cmd = super::build_shell_command("wsl.exe -d Ubuntu");
        let argv = cmd.as_unix_command_line().unwrap();
        // The command line should contain the args as separate tokens
        assert!(argv.contains("-d"), "Expected -d in: {}", argv);
        assert!(argv.contains("Ubuntu"), "Expected Ubuntu in: {}", argv);
    }

    #[test]
    fn build_shell_command_single_exe() {
        // Single executable should still work (no extra empty args)
        let cmd = super::build_shell_command("/bin/zsh");
        let argv = cmd.as_unix_command_line().unwrap();
        assert!(argv.contains("/bin/zsh"), "Expected /bin/zsh in: {}", argv);
    }

    #[test]
    fn pty_parent_env_sanitizer_removes_no_color_and_allows_override() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        // Simulate CommandBuilder's inherited parent snapshot without mutating
        // the process-global environment used by other tests.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("NO_COLOR", "1");

        sanitize_pty_parent_env(&mut cmd);

        assert_eq!(
            cmd.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            cmd.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
        assert_eq!(cmd.get_env("NO_COLOR"), None);

        cmd.env("NO_COLOR", "intentional");
        assert_eq!(
            cmd.get_env("NO_COLOR"),
            Some(std::ffi::OsStr::new("intentional"))
        );
    }

    // --- windows_to_wsl_path tests ---

    #[test]
    fn wsl_path_drive_letter_backslash() {
        assert_eq!(
            super::windows_to_wsl_path("C:\\Users\\foo\\repos"),
            "/mnt/c/Users/foo/repos"
        );
    }

    #[test]
    fn wsl_path_drive_letter_forward_slash() {
        assert_eq!(
            super::windows_to_wsl_path("C:/Users/foo/repos"),
            "/mnt/c/Users/foo/repos"
        );
    }

    #[test]
    fn wsl_path_lowercase_drive() {
        assert_eq!(super::windows_to_wsl_path("d:\\work"), "/mnt/d/work");
    }

    #[test]
    fn wsl_path_already_linux() {
        assert_eq!(
            super::windows_to_wsl_path("/home/user/repos"),
            "/home/user/repos"
        );
    }

    #[test]
    fn wsl_path_unc_unchanged() {
        // UNC paths are not drive-letter paths — returned as-is
        assert_eq!(
            super::windows_to_wsl_path("\\\\server\\share"),
            "\\\\server\\share"
        );
    }

    #[test]
    fn wsl_path_root_drive() {
        assert_eq!(super::windows_to_wsl_path("C:\\"), "/mnt/c/");
    }

    // ---- Layer 3: state_change auto-notifications (#1164-2571) ----

    #[test]
    fn mark_session_exited_pushes_state_change_to_parent_inbox() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-sess";
        let parent_id = "parent-sess";

        // Register parent-child relationship
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        // Pre-init parent inbox
        state.agent_inbox.entry(parent_id.to_string()).or_default();

        mark_session_exited(child_id, &state);

        let inbox = state
            .agent_inbox
            .get(parent_id)
            .expect("parent inbox must exist");
        assert!(
            !inbox.is_empty(),
            "parent inbox must have received state_change message"
        );
        let msg = inbox.front().unwrap();
        let content: serde_json::Value =
            serde_json::from_str(&msg.content).expect("content must be valid JSON");
        assert_eq!(content["type"], "state_change");
        assert_eq!(content["state"], "exited");
    }

    #[test]
    fn try_shell_transition_busy_to_idle_pushes_state_change_to_parent_inbox() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-idle-sess";
        let parent_id = "parent-idle-sess";

        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        // Must have a session_state with agent_type to qualify for idle notification
        let mut ss = crate::state::SessionState::default();
        ss.agent_type = Some("claude".to_string());
        state.session_states.insert(child_id.to_string(), ss);
        state.shell_states.insert(
            child_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_BUSY),
        );
        state.silence_states.insert(
            child_id.to_string(),
            Arc::new(Mutex::new(SilenceState::new())),
        );

        let transitioned = try_shell_transition(&state, child_id, SHELL_BUSY, SHELL_IDLE, true);
        assert!(transitioned, "transition must succeed");

        let inbox = state
            .agent_inbox
            .get(parent_id)
            .expect("parent inbox must exist");
        assert!(
            !inbox.is_empty(),
            "parent inbox must have received state_change message"
        );
        let msg = inbox.front().unwrap();
        let content: serde_json::Value =
            serde_json::from_str(&msg.content).expect("content must be valid JSON");
        assert_eq!(content["type"], "state_change");
        assert_eq!(content["state"], "idle");
    }

    #[test]
    fn background_work_defers_parent_idle_until_descendants_finish() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-background-sess";
        let parent_id = "parent-background-sess";
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        state.session_states.insert(
            child_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                background_work: true,
                ..Default::default()
            },
        );
        state.shell_states.insert(
            child_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_BUSY),
        );
        state.silence_states.insert(
            child_id.to_string(),
            Arc::new(Mutex::new(SilenceState::new())),
        );

        assert!(try_shell_transition(
            &state, child_id, SHELL_BUSY, SHELL_IDLE, true
        ));
        assert!(
            state.agent_inbox.get(parent_id).unwrap().is_empty(),
            "a ready composer must not announce autonomous completion"
        );

        assert!(set_background_work_for_epoch(&state, child_id, 0, 1, false));
        let inbox = state.agent_inbox.get(parent_id).unwrap();
        assert_eq!(inbox.len(), 1);
        let content: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(content["state"], "idle");
    }

    #[test]
    fn background_work_defers_declared_completion_without_generic_idle() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-background-completed";
        let parent_id = "parent-background-completed";
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        state.session_states.insert(
            child_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                background_work: true,
                ..Default::default()
            },
        );
        state.shell_states.insert(
            child_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_IDLE),
        );
        let mut silence = SilenceState::new();
        silence.mark_suggest_candidate(vec!["Review result".to_string()], 0);
        let silence = Arc::new(Mutex::new(silence));
        state
            .silence_states
            .insert(child_id.to_string(), silence.clone());

        assert!(!emit_pending_suggest_if_idle(&state, &silence, child_id));
        assert!(set_background_work_for_epoch(&state, child_id, 0, 1, false));
        let inbox = state.agent_inbox.get(parent_id).unwrap();
        assert_eq!(inbox.len(), 1);
        let content: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(content["state"], "completed");
        assert!(!emit_pending_suggest_if_idle(&state, &silence, child_id));
    }

    #[test]
    fn cursor_prefix_completion_preserves_background_epoch_release() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-background-cursor-completed";
        agent_session(&state, child_id, SHELL_IDLE);
        state
            .session_states
            .get_mut(child_id)
            .unwrap()
            .background_work = true;
        state.vt_log_buffers.insert(
            child_id.to_string(),
            Mutex::new(crate::state::VtLogBuffer::new(24, 80, 1000)),
        );
        let silence = state.silence_states.get(child_id).unwrap().clone();
        let mut processor = ChunkProcessor::new(None, None);

        processor.process_chunk("........................| C ]", &silence, child_id, &state);
        processor.process_chunk("\rsuggest: [ A | B", &silence, child_id, &state);
        assert!(!silence.lock().completion_declared_for_epoch(0));
        processor.process_chunk("\r\x1b[", &silence, child_id, &state);
        assert!(!silence.lock().completion_declared_for_epoch(0));
        processor.process_chunk("Ksuggest: [ A | B | C ]", &silence, child_id, &state);

        {
            let guard = silence.lock();
            assert!(guard.completion_declared_for_epoch(0));
            assert_eq!(
                guard.pending_suggest_items.as_deref(),
                Some(&["A".to_string(), "B".to_string(), "C".to_string()][..])
            );
            assert_eq!(guard.pending_suggest_turn_epoch, 0);
        }
        assert!(try_shell_transition(
            &state, child_id, SHELL_BUSY, SHELL_IDLE, false
        ));
        let deferred = state.session_state_with_shell(child_id).unwrap();
        assert_eq!(deferred.agent_state.as_deref(), Some("working"));
        assert!(deferred.background_work);
        assert!(set_background_work_for_epoch(&state, child_id, 0, 1, false));
        let snapshot = state.session_state_with_shell(child_id).unwrap();
        assert_eq!(snapshot.agent_state.as_deref(), Some("completed"));
        assert!(!snapshot.background_work);
    }

    #[test]
    fn physical_cursor_suggest_completes_after_wrapped_background_probe_clears() {
        for wrap_count in 1..=5 {
            let state = crate::state::tests_support::make_test_app_state();
            let child_id = format!("wrapped-background-physical-suggest-{wrap_count}");
            agent_session(&state, &child_id, SHELL_IDLE);
            state.vt_log_buffers.insert(
                child_id.clone(),
                Mutex::new(crate::state::VtLogBuffer::new(10, 80, 1000)),
            );
            let silence = state.silence_states.get(&child_id).unwrap().clone();
            let mut processor = ChunkProcessor::new(None, None);

            note_submitted_input(&state, &child_id);
            processor.process_chunk(
                &"x".repeat(wrap_count * 80 + 1),
                &silence,
                &child_id,
                &state,
            );
            {
                let mut session = state.session_states.get_mut(&child_id).unwrap();
                session.background_probe_turn_epoch = Some(1);
                session.background_probe_after_generation = Some(0);
            }
            assert!(set_background_work_for_epoch(&state, &child_id, 1, 1, true));
            assert!(state.session_states.get(&child_id).unwrap().background_work);

            assert!(try_shell_transition(
                &state, &child_id, SHELL_BUSY, SHELL_IDLE, false,
            ));
            assert!(set_background_work_for_epoch(
                &state, &child_id, 1, 2, false
            ));
            assert_eq!(
                state
                    .session_state_with_shell(&child_id)
                    .unwrap()
                    .agent_state
                    .as_deref(),
                Some("idle"),
                "wrap_count={wrap_count}"
            );

            processor.process_chunk(
                "\r\x1b[2Ksuggest: [ background cleared | lifecycle complete | close smoke ]",
                &silence,
                &child_id,
                &state,
            );

            let snapshot = state.session_state_with_shell(&child_id).unwrap();
            assert_eq!(
                snapshot.agent_state.as_deref(),
                Some("completed"),
                "wrap_count={wrap_count}"
            );
            assert!(!snapshot.background_work, "wrap_count={wrap_count}");
            assert!(
                silence.lock().completion_declared_for_epoch(1),
                "wrap_count={wrap_count}"
            );
        }
    }

    #[test]
    fn identical_suggest_reopens_only_after_fresh_work_in_a_new_turn() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "suggest-multiple-turns";
        agent_session(&state, child_id, SHELL_IDLE);
        state.vt_log_buffers.insert(
            child_id.to_string(),
            Mutex::new(crate::state::VtLogBuffer::new(24, 80, 1000)),
        );
        let silence = state.silence_states.get(child_id).unwrap().clone();
        let mut processor = ChunkProcessor::new(None, None);
        let marker = "suggest: [ lifecycle fixed | close smoke | continue parity ]";

        processor.process_chunk("first response\r\n", &silence, child_id, &state);
        processor.process_chunk(marker, &silence, child_id, &state);
        assert_eq!(
            silence.lock().drain_pending_suggest(),
            Some(vec![
                "lifecycle fixed".to_string(),
                "close smoke".to_string(),
                "continue parity".to_string(),
            ])
        );

        note_submitted_input(&state, child_id);
        assert_eq!(state.session_states.get(child_id).unwrap().turn_epoch, 1);

        // A previous-turn row can repaint as the input scrolls. Submission by
        // itself must not reopen the content deduplication boundary.
        processor.process_chunk(&format!("\r\n{marker}"), &silence, child_id, &state);
        assert_eq!(silence.lock().drain_pending_suggest(), None);
        processor.process_chunk(&format!("\r\n{marker}"), &silence, child_id, &state);
        assert_eq!(silence.lock().drain_pending_suggest(), None);

        // Real output proves the next response started. The identical marker
        // is now a valid completion, but a second repaint in the same turn is
        // still suppressed.
        processor.process_chunk("\r\nsecond response\r\n", &silence, child_id, &state);
        processor.process_chunk(marker, &silence, child_id, &state);
        assert_eq!(
            silence.lock().drain_pending_suggest(),
            Some(vec![
                "lifecycle fixed".to_string(),
                "close smoke".to_string(),
                "continue parity".to_string(),
            ])
        );
        processor.process_chunk(&format!("\r\n{marker}"), &silence, child_id, &state);
        assert_eq!(silence.lock().drain_pending_suggest(), None);
        assert!(silence.lock().completion_declared_for_epoch(1));
    }

    #[test]
    fn cursor_prefix_rejects_stale_suffix_then_emits_real_completion_once() {
        for (index, bullet) in ["●", "⏺", "•", "◦"].into_iter().enumerate() {
            let state = crate::state::tests_support::make_test_app_state();
            let child_id = format!("cursor-stale-suffix-{index}");
            agent_session(&state, &child_id, SHELL_IDLE);
            state.vt_log_buffers.insert(
                child_id.clone(),
                Mutex::new(crate::state::VtLogBuffer::new(24, 80, 1000)),
            );
            let silence = state.silence_states.get(&child_id).unwrap().clone();
            let mut processor = ChunkProcessor::new(None, None);

            processor.process_chunk(
                "............................| C ]",
                &silence,
                &child_id,
                &state,
            );
            processor.process_chunk(
                &format!("\r{bullet} suggest: [ A | B"),
                &silence,
                &child_id,
                &state,
            );
            assert_eq!(silence.lock().drain_pending_suggest(), None, "{bullet}");

            processor.process_chunk("\r\x1b[", &silence, &child_id, &state);
            assert_eq!(silence.lock().drain_pending_suggest(), None, "{bullet}");
            processor.process_chunk(
                &format!("K{bullet} suggest: [ A | B | C ]"),
                &silence,
                &child_id,
                &state,
            );
            assert_eq!(
                silence.lock().drain_pending_suggest(),
                Some(vec!["A".to_string(), "B".to_string(), "C".to_string()]),
                "{bullet}"
            );

            processor.process_chunk(
                &format!("\r\x1b[K{bullet} suggest: [ A | B | C ]"),
                &silence,
                &child_id,
                &state,
            );
            assert_eq!(silence.lock().drain_pending_suggest(), None, "{bullet}");
        }
    }

    #[test]
    fn wrapped_suggest_reconstructs_unchanged_anchor_across_chunks() {
        for (index, bullet) in ["●", "⏺", "•", "◦"].into_iter().enumerate() {
            let state = crate::state::tests_support::make_test_app_state();
            let child_id = format!("wrapped-suggest-across-chunks-{index}");
            agent_session(&state, &child_id, SHELL_IDLE);
            state.vt_log_buffers.insert(
                child_id.clone(),
                Mutex::new(crate::state::VtLogBuffer::new(24, 14, 1000)),
            );
            let silence = state.silence_states.get(&child_id).unwrap().clone();
            let mut processor = ChunkProcessor::new(None, None);

            processor.process_chunk(
                &format!("{bullet} suggest: [ A"),
                &silence,
                &child_id,
                &state,
            );
            assert_eq!(silence.lock().drain_pending_suggest(), None, "{bullet}");
            processor.process_chunk("界 | B | C ]", &silence, &child_id, &state);

            assert_eq!(
                silence.lock().drain_pending_suggest(),
                Some(vec!["A界".to_string(), "B".to_string(), "C".to_string()]),
                "{bullet}"
            );
        }
    }

    #[test]
    fn bounded_cursor_prefix_refusal_suppresses_structured_completion() {
        for (child_id, columns, token) in [
            (
                "cursor-prefix-over-512-bytes",
                700,
                format!("suggest: [ A | B | C ]{}", "x".repeat(520)),
            ),
            (
                "cursor-prefix-over-four-wraps",
                20,
                format!(
                    "suggest: [ {} | {} | {} | {} ]",
                    "a".repeat(30),
                    "b".repeat(30),
                    "c".repeat(30),
                    "d".repeat(30)
                ),
            ),
        ] {
            let state = crate::state::tests_support::make_test_app_state();
            agent_session(&state, child_id, SHELL_IDLE);
            state.vt_log_buffers.insert(
                child_id.to_string(),
                Mutex::new(crate::state::VtLogBuffer::new(24, columns, 1000)),
            );
            let silence = state.silence_states.get(child_id).unwrap().clone();
            let mut processor = ChunkProcessor::new(None, None);

            processor.process_chunk(&token, &silence, child_id, &state);

            assert_eq!(silence.lock().drain_pending_suggest(), None, "{child_id}");
        }
    }

    #[test]
    fn wrapped_suggest_requires_complete_non_nested_prefix() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "wrapped-suggest-incomplete";
        agent_session(&state, child_id, SHELL_IDLE);
        state.vt_log_buffers.insert(
            child_id.to_string(),
            Mutex::new(crate::state::VtLogBuffer::new(24, 10, 1000)),
        );
        let silence = state.silence_states.get(child_id).unwrap().clone();
        let mut processor = ChunkProcessor::new(None, None);

        processor.process_chunk("suggest: [", &silence, child_id, &state);
        processor.process_chunk(" A | B", &silence, child_id, &state);
        assert_eq!(silence.lock().drain_pending_suggest(), None);

        processor.process_chunk("\r\x1b[2K\x1b[1A\r\x1b[2K", &silence, child_id, &state);
        processor.process_chunk("suggest: [", &silence, child_id, &state);
        processor.process_chunk(" A | EP[\"node\"] | C ]", &silence, child_id, &state);
        assert_eq!(silence.lock().drain_pending_suggest(), None);
    }

    #[test]
    fn stale_background_clear_cannot_emit_after_new_turn() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-background-race";
        let parent_id = "parent-background-race";
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        state.session_states.insert(
            child_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                background_work: true,
                turn_epoch: 7,
                ..Default::default()
            },
        );
        state.shell_states.insert(
            child_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_IDLE),
        );
        state.silence_states.insert(
            child_id.to_string(),
            Arc::new(Mutex::new(SilenceState::new())),
        );

        note_submitted_input(&state, child_id);
        assert!(!set_background_work_for_epoch(
            &state, child_id, 7, 1, false
        ));
        assert!(state.session_states.get(child_id).unwrap().background_work);
        assert!(state.agent_inbox.get(parent_id).unwrap().is_empty());
    }

    #[test]
    fn background_snapshot_teardown_does_not_recreate_lifecycle_or_notify() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "background-teardown";
        let parent_id = "background-teardown-parent";
        agent_session(&state, child_id, SHELL_IDLE);
        state
            .session_states
            .get_mut(child_id)
            .unwrap()
            .background_work = true;
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();

        assert!(!set_background_work_for_epoch_with_hook(
            &state,
            child_id,
            0,
            1,
            false,
            || {
                state.silence_states.remove(child_id);
                state.shell_states.remove(child_id);
                state.session_states.remove(child_id);
            },
        ));
        assert!(!state.silence_states.contains_key(child_id));
        assert!(state.agent_inbox.get(parent_id).unwrap().is_empty());
    }

    #[test]
    fn failed_or_invalid_cached_snapshot_preserves_background_work() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "background-snapshot-failure";
        state.session_states.insert(
            session_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                background_work: true,
                turn_epoch: 3,
                ..Default::default()
            },
        );

        assert!(!refresh_background_work_from_cached_snapshot(
            &state, session_id, 10, "codex", 3, None,
        ));
        let invalid = Arc::new(vec![process(20, 1, "codex", "codex")]);
        assert!(!refresh_background_work_from_cached_snapshot(
            &state,
            session_id,
            10,
            "codex",
            3,
            Some((1, invalid)),
        ));
        assert!(
            state
                .session_states
                .get(session_id)
                .unwrap()
                .background_work
        );
    }

    #[test]
    fn cached_snapshot_detects_background_process_exit() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-background-exit";
        let parent_id = "parent-background-exit";
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        state.session_states.insert(
            child_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                background_work: true,
                turn_epoch: 4,
                ..Default::default()
            },
        );
        state.shell_states.insert(
            child_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_IDLE),
        );
        state.silence_states.insert(
            child_id.to_string(),
            Arc::new(Mutex::new(SilenceState::new())),
        );
        let exited = Arc::new(vec![process(10, 1, "codex", "codex")]);

        assert!(refresh_background_work_from_cached_snapshot(
            &state,
            child_id,
            10,
            "codex",
            4,
            Some((2, exited)),
        ));
        assert!(!state.session_states.get(child_id).unwrap().background_work);
        let inbox = state.agent_inbox.get(parent_id).unwrap();
        let content: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(content["state"], "idle");
    }

    #[cfg(unix)]
    #[test]
    fn standby_refuses_session_with_background_work() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "background-standby";
        state.session_states.insert(
            session_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                background_work: true,
                ..Default::default()
            },
        );
        assert_eq!(standby_session(&state, session_id), Ok(false));
        assert!(!state.standby_sessions.contains_key(session_id));
    }

    #[cfg(unix)]
    #[test]
    fn standby_refuses_session_with_pending_background_probe() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "background-probe-standby";
        state.session_states.insert(
            session_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                background_probe_turn_epoch: Some(3),
                turn_epoch: 3,
                ..Default::default()
            },
        );

        assert!(background_activity_blocks_standby(&state, session_id));
        assert_eq!(standby_session(&state, session_id), Ok(false));
        assert!(!state.standby_sessions.contains_key(session_id));
    }

    #[test]
    fn declared_completion_does_not_emit_ambiguous_idle_lifecycle() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-completed-sess";
        let parent_id = "parent-completed-sess";

        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        state.session_states.insert(
            child_id.to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                ..Default::default()
            },
        );
        state.shell_states.insert(
            child_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_BUSY),
        );
        let mut silence = SilenceState::new();
        silence.mark_suggest_candidate(vec!["Review result".to_string()], 0);
        state
            .silence_states
            .insert(child_id.to_string(), Arc::new(Mutex::new(silence)));

        assert!(try_shell_transition(
            &state, child_id, SHELL_BUSY, SHELL_IDLE, true
        ));

        assert!(
            state.agent_inbox.get(parent_id).unwrap().is_empty(),
            "the suggest drain must publish completed instead of an earlier idle"
        );
        let silence = state.silence_states.get(child_id).unwrap().clone();
        assert!(emit_pending_suggest_if_idle(&state, &silence, child_id));
        let inbox = state.agent_inbox.get(parent_id).unwrap();
        assert_eq!(inbox.len(), 1);
        let content: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(content["state"], "completed");
    }

    #[test]
    fn pending_initial_prompt_timeout_notifies_parent_once() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-prompt-timeout";
        let parent_id = "parent-prompt-timeout";
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        state
            .pending_initial_prompts
            .insert(child_id.to_string(), "do the task".to_string());

        assert!(notify_initial_prompt_timeout_if_pending(&state, child_id));
        assert!(!notify_initial_prompt_timeout_if_pending(&state, child_id));

        let inbox = state.agent_inbox.get(parent_id).unwrap();
        assert_eq!(inbox.len(), 1, "timeout notification must be emitted once");
        let content: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(content["type"], "prompt_delivery_failed");
        assert_eq!(content["reason"], "timeout");
        assert_eq!(content["session_id"], child_id);
        assert!(!state.pending_initial_prompts.contains_key(child_id));
    }

    #[test]
    fn try_shell_transition_non_agent_session_does_not_push_idle_notification() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "non-agent-sess";
        let parent_id = "parent-non-agent-sess";

        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        // No agent_type set — plain shell session
        state
            .session_states
            .insert(child_id.to_string(), crate::state::SessionState::default());
        state.shell_states.insert(
            child_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_BUSY),
        );

        try_shell_transition(&state, child_id, SHELL_BUSY, SHELL_IDLE, true);

        let inbox = state.agent_inbox.get(parent_id).unwrap();
        assert!(
            inbox.is_empty(),
            "non-agent sessions must not send idle notifications to parent"
        );
    }

    #[test]
    fn try_shell_transition_exit_path_does_not_push_idle_to_parent() {
        // notify_parent=false (exit path): orchestrator must NOT receive spurious "idle"
        // before the "exited" message from mark_session_exited.
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-exit-path";
        let parent_id = "parent-exit-path";

        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        let mut ss = crate::state::SessionState::default();
        ss.agent_type = Some("claude".to_string());
        state.session_states.insert(child_id.to_string(), ss);
        state.shell_states.insert(
            child_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_BUSY),
        );

        let transitioned = try_shell_transition(&state, child_id, SHELL_BUSY, SHELL_IDLE, false);
        assert!(transitioned, "transition must succeed");

        let inbox = state.agent_inbox.get(parent_id).unwrap();
        assert!(
            inbox.is_empty(),
            "exit path must not push idle notification — mark_session_exited sends exited"
        );
    }

    #[test]
    fn tombstone_transient_cleanup_removes_swarm_maps() {
        // F3: all per-child swarm state must be cleaned on exit.
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "sess-cleanup";
        let mcp_sid = "mcp-sess-cleanup";

        state
            .session_parent
            .insert(sid.to_string(), "parent-sess".to_string());
        state
            .shell_state_since_ms
            .insert(sid.to_string(), std::sync::atomic::AtomicU64::new(42));
        state
            .mcp_to_session
            .insert(mcp_sid.to_string(), sid.to_string());
        state
            .session_to_mcp
            .insert(sid.to_string(), vec![mcp_sid.to_string()]);
        state.peer_agents.insert(
            sid.to_string(),
            crate::state::PeerAgent {
                tuic_session: sid.to_string(),
                mcp_session_id: mcp_sid.to_string(),
                name: "worker".to_string(),
                project: None,
                registered_at: 1,
            },
        );
        state.agent_inbox.entry(sid.to_string()).or_default();
        state.agent_inbox_evictions.insert(sid.to_string(), 2);

        tombstone_transient_cleanup(sid, &state);

        assert!(
            !state.session_parent.contains_key(sid),
            "session_parent must be removed"
        );
        assert!(
            !state.shell_state_since_ms.contains_key(sid),
            "shell_state_since_ms must be removed"
        );
        assert!(
            !state.mcp_to_session.contains_key(mcp_sid),
            "mcp_to_session entry must be removed"
        );
        assert!(
            !state.session_to_mcp.contains_key(sid),
            "session_to_mcp entry must be removed"
        );
        assert!(!state.peer_agents.contains_key(sid));
        assert!(!state.agent_inbox.contains_key(sid));
        assert!(!state.agent_inbox_evictions.contains_key(sid));
    }

    // ── PTY-injection message delivery (Step 2) ─────────────────────

    fn agent_session(state: &crate::state::AppState, sid: &str, shell: u8) {
        use std::sync::atomic::AtomicU8;
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(shell));
        state.session_states.insert(
            sid.to_string(),
            crate::state::SessionState {
                agent_type: Some("claude".to_string()),
                ..Default::default()
            },
        );
        let mut silence = SilenceState::new();
        silence.idle_confirmed = shell == SHELL_IDLE;
        state
            .silence_states
            .insert(sid.to_string(), Arc::new(Mutex::new(silence)));
    }

    fn flush_one_pending_as_submitted(state: &crate::state::AppState, sid: &str) {
        let claim = claim_idle_for_injection(state, sid).expect("idle claim");
        let text = state
            .pending_injections
            .get_mut(sid)
            .and_then(|mut queue| queue.pop_front())
            .expect("pending message");
        apply_claimed_injection_outcome(state, sid, &text, claim, InjectionOutcome::Submitted);
    }

    fn completed_agent_session(state: &crate::state::AppState, sid: &str) {
        agent_session(state, sid, SHELL_IDLE);
        state.session_states.get_mut(sid).unwrap().suggested_actions =
            Some(vec!["Review result".to_string()]);
        state
            .silence_states
            .get(sid)
            .unwrap()
            .lock()
            .mark_suggest_candidate(vec!["Review result".to_string()], 0);
    }

    fn assert_new_turn_silence_evidence(silence: &SilenceState) {
        assert!(silence.explicit_busy);
        assert!(!silence.hook_busy);
        assert!(!silence.explicit_idle);
        assert!(!silence.idle_confirmed);
        assert!(silence.last_status_line_at.is_some());
        assert!(silence.ready_since.is_none());
        assert!(silence.interrupt_requested_at.is_none());
        assert!(silence.turn_started_by_input);
        assert!(!silence.turn_activity_seen);
        assert!(!silence.completion_declared);
        assert!(silence.pending_suggest_items.is_none());
    }

    #[test]
    fn submitted_input_lifecycle_peer_injection_starts_new_turn_and_clears_completion() {
        let state = crate::state::tests_support::make_test_app_state();
        completed_agent_session(&state, "completed");
        state.pending_injections.insert(
            "completed".to_string(),
            std::collections::VecDeque::from(["follow up".to_string()]),
        );

        flush_one_pending_as_submitted(&state, "completed");

        let snapshot = state.session_state_with_shell("completed").unwrap();
        assert_eq!(snapshot.shell_state.as_deref(), Some("busy"));
        assert_eq!(snapshot.agent_state.as_deref(), Some("working"));
        assert!(snapshot.suggested_actions.is_none());
        assert!(
            !state
                .silence_states
                .get("completed")
                .unwrap()
                .lock()
                .completion_declared()
        );
    }

    #[test]
    fn submitted_epoch_and_busy_transition_are_one_critical_section() {
        use std::sync::atomic::Ordering;

        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let session_id = "submitted-atomic";
        completed_agent_session(&state, session_id);
        let (start_tx, start_rx) = std::sync::mpsc::channel();
        let (lock_held_tx, lock_held_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let observer_state = Arc::clone(&state);
        let observer = std::thread::spawn(move || {
            start_rx.recv().unwrap();
            let silence = observer_state
                .silence_states
                .get(session_id)
                .unwrap()
                .clone();
            lock_held_tx.send(silence.try_lock().is_none()).unwrap();
            let transitioned =
                try_shell_transition(&observer_state, session_id, SHELL_IDLE, SHELL_IDLE, false);
            finished_tx.send(transitioned).unwrap();
        });

        note_submitted_input_with_hook(&state, session_id, || {
            assert_eq!(state.session_states.get(session_id).unwrap().turn_epoch, 1);
            start_tx.send(()).unwrap();
            assert!(
                lock_held_rx.recv().unwrap(),
                "epoch mutation must retain the lifecycle lock until BUSY"
            );
        });

        assert!(
            !finished_rx.recv().unwrap(),
            "observer must see BUSY after the submitted-turn reservation"
        );
        observer.join().unwrap();
        assert_eq!(
            state
                .shell_states
                .get(session_id)
                .unwrap()
                .load(Ordering::Acquire),
            SHELL_BUSY
        );
    }

    #[test]
    fn idle_parent_notification_finishes_before_new_turn_reservation() {
        use std::sync::atomic::Ordering;

        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let child_id = "idle-race-child";
        let parent_id = "idle-race-parent";
        agent_session(&state, child_id, SHELL_BUSY);
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();

        let (start_tx, start_rx) = std::sync::mpsc::channel();
        let (lock_held_tx, lock_held_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let submitter_state = Arc::clone(&state);
        let submitter = std::thread::spawn(move || {
            start_rx.recv().unwrap();
            let silence = submitter_state
                .silence_states
                .get(child_id)
                .unwrap()
                .clone();
            lock_held_tx.send(silence.try_lock().is_none()).unwrap();
            note_submitted_input(&submitter_state, child_id);
            finished_tx.send(()).unwrap();
        });

        assert!(try_shell_transition_with_hook(
            &state,
            child_id,
            SHELL_BUSY,
            SHELL_IDLE,
            true,
            || {
                start_tx.send(()).unwrap();
                assert!(
                    lock_held_rx.recv().unwrap(),
                    "BUSY→IDLE must retain the lifecycle lock through parent enqueue"
                );
            },
        ));
        finished_rx.recv().unwrap();
        submitter.join().unwrap();

        assert_eq!(
            state
                .shell_states
                .get(child_id)
                .unwrap()
                .load(Ordering::Acquire),
            SHELL_BUSY
        );
        assert_eq!(state.session_states.get(child_id).unwrap().turn_epoch, 1);
        let inbox = state.agent_inbox.get(parent_id).unwrap();
        assert_eq!(inbox.len(), 1);
        let payload: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(payload["state"], "idle");
    }

    #[test]
    fn new_turn_wins_before_queued_old_idle_transition() {
        use std::sync::atomic::Ordering;

        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let child_id = "inverse-idle-child";
        let parent_id = "inverse-idle-parent";
        agent_session(&state, child_id, SHELL_BUSY);
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();

        let (snapshotted_tx, snapshotted_rx) = std::sync::mpsc::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();
        let old_transition_state = Arc::clone(&state);
        let old_transition = std::thread::spawn(move || {
            let observed_turn_epoch = old_transition_state
                .session_states
                .get(child_id)
                .map(|session| session.turn_epoch);
            try_shell_transition_with_hooks(
                ShellTransitionRequest {
                    state: &old_transition_state,
                    session_id: child_id,
                    expected: SHELL_BUSY,
                    new: SHELL_IDLE,
                    notify_parent: true,
                    observed_turn_epoch,
                },
                ShellTransitionHooks {
                    after_epoch_snapshot: || {
                        snapshotted_tx.send(()).unwrap();
                        continue_rx.recv().unwrap();
                    },
                    after_cas: || {},
                    before_parent_dispatch: || {},
                },
            )
        });

        snapshotted_rx.recv().unwrap();
        note_submitted_input(&state, child_id);
        continue_tx.send(()).unwrap();

        assert!(
            !old_transition.join().unwrap(),
            "an idle transition from the prior epoch must not publish"
        );
        assert_eq!(state.session_states.get(child_id).unwrap().turn_epoch, 1);
        assert_eq!(
            state
                .shell_states
                .get(child_id)
                .unwrap()
                .load(Ordering::Acquire),
            SHELL_BUSY
        );
        assert!(state.agent_inbox.get(parent_id).unwrap().is_empty());
    }

    #[test]
    fn explicit_idle_evidence_from_prior_turn_cannot_idle_new_submission() {
        use std::sync::atomic::Ordering;

        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "explicit-idle-epoch";
        agent_session(&state, session_id, SHELL_BUSY);

        transition_explicit_shell_state_with_hook(
            &state,
            session_id,
            SHELL_IDLE,
            "idle",
            true,
            || note_submitted_input(&state, session_id),
        );

        assert_eq!(state.session_states.get(session_id).unwrap().turn_epoch, 1);
        assert_new_turn_silence_evidence(&state.silence_states.get(session_id).unwrap().lock());
        assert_eq!(
            state
                .shell_states
                .get(session_id)
                .unwrap()
                .load(Ordering::Acquire),
            SHELL_BUSY,
            "an explicit idle marker observed before the new input must be discarded"
        );
    }

    #[test]
    fn timer_idle_evidence_from_prior_turn_cannot_mutate_new_submission() {
        use std::sync::atomic::Ordering;

        for (session_id, activity) in [
            ("ready-idle-epoch", AgentScreenActivity::Ready),
            ("interrupted-idle-epoch", AgentScreenActivity::Interrupted),
            ("unknown-idle-epoch", AgentScreenActivity::Unknown),
        ] {
            let state = crate::state::tests_support::make_test_app_state();
            agent_session(&state, session_id, SHELL_BUSY);
            let evidence_turn_epoch = Some(0);
            note_submitted_input(&state, session_id);

            let transition = try_timer_idle_transition(
                &state,
                &state.silence_states.get(session_id).unwrap().clone(),
                session_id,
                activity,
                Some("claude"),
                evidence_turn_epoch,
            );

            assert!(!transition.transitioned);
            assert_new_turn_silence_evidence(&state.silence_states.get(session_id).unwrap().lock());
            assert_eq!(
                state
                    .shell_states
                    .get(session_id)
                    .unwrap()
                    .load(Ordering::Acquire),
                SHELL_BUSY
            );
        }
    }

    #[test]
    fn silence_idle_decision_from_prior_turn_cannot_idle_new_submission() {
        use std::sync::atomic::{AtomicU64, Ordering};

        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "silence-idle-epoch";
        agent_session(&state, session_id, SHELL_BUSY);
        state.last_output_ms.insert(
            session_id.to_string(),
            AtomicU64::new(now_epoch_ms().saturating_sub(AGENT_IDLE_MS + 1)),
        );

        let decision = should_transition_idle_with_hook(&state, session_id, || {
            note_submitted_input(&state, session_id);
        });
        assert!(decision.should_transition);
        assert_eq!(decision.turn_epoch, Some(0));

        assert!(!try_shell_transition_for_epoch(
            &state,
            session_id,
            SHELL_BUSY,
            SHELL_IDLE,
            true,
            decision.turn_epoch,
        ));
        assert_eq!(state.session_states.get(session_id).unwrap().turn_epoch, 1);
        assert_new_turn_silence_evidence(&state.silence_states.get(session_id).unwrap().lock());
        assert_eq!(
            state
                .shell_states
                .get(session_id)
                .unwrap()
                .load(Ordering::Acquire),
            SHELL_BUSY
        );
    }

    #[test]
    fn parent_dispatch_runs_after_child_lifecycle_lock_release() {
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "dispatch-child";
        let parent_id = "dispatch-parent";
        agent_session(&state, child_id, SHELL_BUSY);
        agent_session(&state, parent_id, SHELL_IDLE);
        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        let observed_turn_epoch = state
            .session_states
            .get(child_id)
            .map(|session| session.turn_epoch);

        assert!(try_shell_transition_with_hooks(
            ShellTransitionRequest {
                state: &state,
                session_id: child_id,
                expected: SHELL_BUSY,
                new: SHELL_IDLE,
                notify_parent: true,
                observed_turn_epoch,
            },
            ShellTransitionHooks {
                after_epoch_snapshot: || {},
                after_cas: || {},
                before_parent_dispatch: || {
                    let silence = state.silence_states.get(child_id).unwrap().clone();
                    assert!(
                        silence.try_lock().is_some(),
                        "child lifecycle lock must be released before parent PTY dispatch"
                    );
                },
            },
        ));
        assert_eq!(state.agent_inbox.get(parent_id).unwrap().len(), 1);
    }

    #[test]
    fn submitted_input_lifecycle_ready_before_status_line_is_not_stale_completed() {
        let state = crate::state::tests_support::make_test_app_state();
        completed_agent_session(&state, "quick-turn");
        state.pending_injections.insert(
            "quick-turn".to_string(),
            std::collections::VecDeque::from(["quick follow up".to_string()]),
        );
        flush_one_pending_as_submitted(&state, "quick-turn");

        state
            .silence_states
            .get("quick-turn")
            .unwrap()
            .lock()
            .confirm_idle();
        assert!(try_shell_transition(
            &state,
            "quick-turn",
            SHELL_BUSY,
            SHELL_IDLE,
            false,
        ));

        let snapshot = state.session_state_with_shell("quick-turn").unwrap();
        assert_eq!(snapshot.shell_state.as_deref(), Some("idle"));
        assert_eq!(snapshot.agent_state.as_deref(), Some("idle"));
        assert!(snapshot.suggested_actions.is_none());
    }

    #[test]
    fn submitted_input_lifecycle_no_new_input_retains_completion() {
        let state = crate::state::tests_support::make_test_app_state();
        completed_agent_session(&state, "unchanged");

        let snapshot = state.session_state_with_shell("unchanged").unwrap();
        assert_eq!(snapshot.shell_state.as_deref(), Some("idle"));
        assert_eq!(snapshot.agent_state.as_deref(), Some("completed"));
        assert_eq!(
            snapshot.suggested_actions,
            Some(vec!["Review result".to_string()])
        );
        assert!(
            state
                .silence_states
                .get("unchanged")
                .unwrap()
                .lock()
                .completion_declared()
        );
    }

    #[test]
    fn should_inject_now_only_for_idle_agent() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "idle-agent", SHELL_IDLE);
        agent_session(&state, "busy-agent", SHELL_BUSY);
        assert!(
            should_inject_now(&state, "idle-agent"),
            "idle agent → inject"
        );
        assert!(
            !should_inject_now(&state, "busy-agent"),
            "busy agent → queue"
        );
        assert!(
            !should_inject_now(&state, "unknown"),
            "unknown session → never inject"
        );
    }

    #[test]
    fn injection_claim_rechecks_idle_atomically_after_delivery_decision() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "race-agent", SHELL_IDLE);
        assert!(should_inject_now(&state, "race-agent"));

        assert!(try_shell_transition(
            &state,
            "race-agent",
            SHELL_IDLE,
            SHELL_BUSY,
            false,
        ));

        assert!(
            claim_idle_for_injection(&state, "race-agent").is_none(),
            "a sender that observed idle before the agent became busy must queue instead of writing into the active composer"
        );
    }

    #[test]
    fn codex_heuristic_idle_is_not_safe_for_injection_or_standby() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "codex-heuristic", SHELL_IDLE);
        state
            .session_states
            .get_mut("codex-heuristic")
            .unwrap()
            .agent_type = Some("codex".to_string());
        state
            .silence_states
            .get("codex-heuristic")
            .unwrap()
            .lock()
            .idle_confirmed = false;

        assert!(!idle_is_confirmed(&state, "codex-heuristic"));
        assert!(!should_inject_now(&state, "codex-heuristic"));

        state
            .silence_states
            .get("codex-heuristic")
            .unwrap()
            .lock()
            .confirm_idle();
        assert!(idle_is_confirmed(&state, "codex-heuristic"));
        assert!(should_inject_now(&state, "codex-heuristic"));
    }

    #[test]
    fn should_inject_now_false_for_shell_and_confident_question() {
        use std::sync::atomic::AtomicU8;
        let state = crate::state::tests_support::make_test_app_state();
        // Plain shell (no agent_type) — must never be injected into.
        state
            .shell_states
            .insert("shell".to_string(), AtomicU8::new(SHELL_IDLE));
        state
            .session_states
            .insert("shell".to_string(), crate::state::SessionState::default());
        assert!(!should_inject_now(&state, "shell"), "shell → never inject");

        // Agent idle but blocked on a CONFIDENT user-facing question (Ink menu,
        // cliclack prompt, "Action Required" title) — never answer it.
        state
            .shell_states
            .insert("q".to_string(), AtomicU8::new(SHELL_IDLE));
        state.session_states.insert(
            "q".to_string(),
            crate::state::SessionState {
                agent_type: Some("claude".to_string()),
                awaiting_input: true,
                question_confident: true,
                ..Default::default()
            },
        );
        let mut ready_silence = SilenceState::new();
        ready_silence.idle_confirmed = true;
        state
            .silence_states
            .insert("ready".to_string(), Arc::new(Mutex::new(ready_silence)));
        assert!(
            !should_inject_now(&state, "q"),
            "confident question agent → do not answer its prompt"
        );

        // Agent idle at a mere ready prompt: the low-confidence silence heuristic
        // sets awaiting_input WITHOUT question_confident (codex parks here
        // permanently — story 091). Injection must proceed or delivery starves.
        state
            .shell_states
            .insert("ready".to_string(), AtomicU8::new(SHELL_IDLE));
        state.session_states.insert(
            "ready".to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                awaiting_input: true,
                question_confident: false,
                ..Default::default()
            },
        );
        assert!(
            should_inject_now(&state, "ready"),
            "awaiting_input-only (ready prompt) agent → inject, do not starve"
        );
    }

    #[test]
    fn deliver_queues_pending_for_busy_agent() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "busy", SHELL_BUSY);
        deliver_message_to_pty(&state, "busy", "[TUIC message from lead] go");
        let q = state.pending_injections.get("busy").expect("queued");
        assert_eq!(q.len(), 1);
        assert_eq!(q.front().unwrap(), "[TUIC message from lead] go");
    }

    #[test]
    fn idle_flush_submits_only_one_queued_message_per_turn() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "idle", SHELL_IDLE);
        state.pending_injections.insert(
            "idle".to_string(),
            std::collections::VecDeque::from(["first".to_string(), "second".to_string()]),
        );

        flush_one_pending_as_submitted(&state, "idle");

        assert_eq!(
            state
                .pending_injections
                .get("idle")
                .map(|queue| queue.iter().cloned().collect::<Vec<_>>()),
            Some(vec!["second".to_string()]),
            "submitting the first message makes the agent busy; later messages must wait for its next idle transition"
        );
    }

    #[test]
    fn deliver_queues_for_idle_agent_with_partial_user_input() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "typing", SHELL_IDLE);
        let mut input = crate::input_line_buffer::InputLineBuffer::new();
        input.feed("draft in progress");
        state
            .input_buffers
            .insert("typing".to_string(), Mutex::new(input));

        assert!(
            !should_inject_now(&state, "typing"),
            "partial composer input must block terminal injection"
        );
        deliver_message_to_pty(&state, "typing", "[TUIC message from child] done");
        let pending = state.pending_injections.get("typing").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.front().unwrap(), "[TUIC message from child] done");
    }

    #[test]
    fn delivery_gate_assigns_waiter_without_touching_terminal_queue() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "waiting", SHELL_IDLE);
        let lease = state.begin_agent_wait("waiting");
        state.push_agent_inbox(
            "waiting",
            crate::state::AgentMessage {
                id: "wait-owned".to_string(),
                from_tuic_session: "sender".to_string(),
                from_name: "sender".to_string(),
                content: "done".to_string(),
                timestamp: 1,
                delivered_via_channel: false,
            },
        );

        assert_eq!(
            state.assign_agent_delivery("waiting", "wait-owned", true),
            crate::state::AgentDeliveryAssignment::Waiter
        );

        assert!(
            !state.pending_injections.contains_key("waiting"),
            "active wait owns delivery; terminal injection must not be queued"
        );
        state.finish_agent_wait("waiting", lease, 0, true);
    }

    #[test]
    fn deliver_noop_for_non_agent() {
        let state = crate::state::tests_support::make_test_app_state();
        // No session_states entry → not an agent.
        deliver_message_to_pty(&state, "ghost", "hi");
        assert!(
            !state.pending_injections.contains_key("ghost"),
            "non-agent must never queue"
        );
    }

    #[test]
    fn managed_delivery_rejects_stale_agent_state_without_pty() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "vanished", SHELL_BUSY);

        assert!(!deliver_message_to_managed_pty(
            &state, "vanished", "message"
        ));
        assert!(!state.pending_injections.contains_key("vanished"));
    }

    #[test]
    fn failed_not_started_injection_rolls_back_claim_and_requeues() {
        // The test state has no live PTY session, so composer lookup fails before
        // any byte can be written. The delivery claim must be rolled back and the
        // message kept pending instead of leaving a false BUSY state.
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "idle", SHELL_IDLE);
        deliver_message_to_pty(&state, "idle", "now");
        assert!(
            state
                .shell_states
                .get("idle")
                .is_some_and(|state| state.load(Ordering::Acquire) == SHELL_IDLE),
            "a claim that never reached PTY I/O must restore IDLE"
        );
        assert_eq!(
            state
                .pending_injections
                .get("idle")
                .and_then(|queue| queue.front().cloned()),
            Some("now".to_string()),
            "a not-started delivery must remain retryable"
        );
    }

    #[test]
    fn real_activity_invalidates_injection_rollback_ownership() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "active", SHELL_IDLE);
        let claim = claim_idle_for_injection(&state, "active").expect("claim");
        state
            .silence_states
            .get("active")
            .unwrap()
            .lock()
            .note_real_activity();

        assert!(!rollback_injection_claim(&state, "active", claim));
        assert!(
            state
                .shell_states
                .get("active")
                .is_some_and(|value| value.load(Ordering::Acquire) == SHELL_BUSY),
            "rollback must not erase genuine post-claim activity"
        );
    }

    #[test]
    fn partial_write_is_uncertain_not_not_started() {
        struct PartialThenError {
            wrote_once: bool,
        }
        impl std::io::Write for PartialThenError {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if self.wrote_once {
                    Err(std::io::Error::other("injected failure"))
                } else {
                    self.wrote_once = true;
                    Ok(bytes.len().min(2))
                }
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let mut writer = PartialThenError { wrote_once: false };
        let failure = write_all_with_progress(&mut writer, b"payload", 0).unwrap_err();
        assert_eq!(failure.0, 2, "partial progress must be retained");
        assert!(failure.1.contains("injected failure"));
    }

    #[test]
    fn uncertain_injection_preserves_busy_and_surfaces_status_flag() {
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "uncertain", SHELL_IDLE);
        let claim = claim_idle_for_injection(&state, "uncertain").expect("claim");
        mark_injection_uncertain(&state, "uncertain", claim);

        assert!(
            state
                .shell_states
                .get("uncertain")
                .is_some_and(|value| value.load(Ordering::Acquire) == SHELL_BUSY)
        );
        assert!(
            state
                .silence_states
                .get("uncertain")
                .unwrap()
                .lock()
                .injection_delivery_uncertain
        );
        assert!(!state.pending_injections.contains_key("uncertain"));
    }

    #[test]
    fn uncertain_injection_cannot_be_cleared_by_a_stale_ready_screen() {
        let mut silence = SilenceState::new();
        let token = silence.begin_injection_claim(true);
        silence.mark_injection_uncertain(token);
        silence.ready_since = Some(std::time::Instant::now() - AGENT_READY_CONFIRM);

        assert!(!silence.note_ready_screen());
        assert!(silence.injection_delivery_uncertain);
        assert!(!silence.idle_confirmed);
    }

    #[test]
    fn deliver_reenqueue_recovers_message_when_idle_races_enqueue() {
        // CONC-A (story 101-20e3): the sender's should_inject_now read and its
        // pending_injections push are not atomic vs a concurrent BUSY→IDLE flush. If the
        // silence timer transitions to idle and drains the (still-empty) queue between
        // them, the message would be stranded until the NEXT idle cycle. The post-enqueue
        // re-check must recover it. Stress the race with a barrier: after both the sender
        // and the transition+flush complete with the session ending idle, the queue MUST
        // be empty (message delivered) regardless of interleaving. Pre-fix this fails in
        // the bug window (sender reads busy, timer flushes empty, sender enqueues with no
        // recovery). With no live PTY in this unit test, the recovered delivery
        // must remain queued exactly once rather than being lost or duplicated.
        use std::sync::{Arc, Barrier};
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        for i in 0..500 {
            agent_session(&state, "race", SHELL_BUSY);
            state.pending_injections.remove("race");

            let barrier = Arc::new(Barrier::new(2));
            let (s1, b1) = (Arc::clone(&state), Arc::clone(&barrier));
            let sender = std::thread::spawn(move || {
                b1.wait();
                deliver_message_to_pty(&s1, "race", "[TUIC message from lead] go");
            });
            let (s2, b2) = (Arc::clone(&state), Arc::clone(&barrier));
            let timer = std::thread::spawn(move || {
                b2.wait();
                // Silence timer: BUSY→IDLE also runs flush_pending_injections on idle.
                s2.silence_states.get("race").unwrap().lock().idle_confirmed = true;
                try_shell_transition(&s2, "race", SHELL_BUSY, SHELL_IDLE, false);
                emit_shell_state(&s2, "race", "idle");
                flush_pending_injections(&s2, "race");
            });
            sender.join().unwrap();
            timer.join().unwrap();

            let queued = state
                .pending_injections
                .get("race")
                .map(|q| q.len())
                .unwrap_or(0);
            assert_eq!(queued, 1, "iteration {i}: message lost or duplicated");
        }
    }

    // ---- CONC-B (story 100-e303 / commit 5410cc3d): resize_session_core ----
    // resize_session_core serializes the whole grid+PTY resize for a session
    // under one per-session lock so two concurrent differing resizes can never
    // interleave and leave grid and PTY at mismatched dimensions. These cover
    // the invalid-dims edge, the no-op guard, the (0,0) startup-dims seed, and
    // the concurrent-race invariant (mirrors the CONC-A barrier test above).

    /// Insert a live VtLogBuffer at the given dims so the grid path in
    /// resize_session_core runs against a real grid.
    fn seed_vt_grid(state: &crate::state::AppState, sid: &str, rows: u16, cols: u16) {
        state.vt_log_buffers.insert(
            sid.to_string(),
            Mutex::new(VtLogBuffer::new(rows, cols, 1000)),
        );
    }

    #[test]
    fn resize_rejects_zero_dims() {
        let state = crate::state::tests_support::make_test_app_state();
        // rows==0 / cols==0 are rejected before any lock, grid, or PTY work — the
        // (0,0) pair is reserved as the "never applied" sentinel inside the lock.
        assert!(resize_session_core(&state, "s", 0, 80).is_err());
        assert!(resize_session_core(&state, "s", 24, 0).is_err());
        // A rejected resize must not even create a resize_locks entry.
        assert!(!state.resize_locks.contains_key("s"));
    }

    #[test]
    fn resize_noop_guard_returns_none_on_matching_dims() {
        let state = crate::state::tests_support::make_test_app_state();
        // Pre-seed the last-applied dims, as if a prior resize reached the PTY.
        state
            .resize_locks
            .insert("s".to_string(), Arc::new(Mutex::new((24, 80))));
        // Same dims → no-op returning None WITHOUT touching the (absent) session.
        // Without the guard this would fall through to sessions.get and fail with
        // "Session not found", so Ok(None) proves the guard short-circuited first.
        assert_eq!(resize_session_core(&state, "s", 24, 80), Ok(None));
    }

    #[test]
    fn resize_seeds_applied_from_grid_and_noops_at_startup_dims() {
        let state = crate::state::tests_support::make_test_app_state();
        // Grid exists at the startup dims but resize_locks is empty → the lock
        // opens at the (0,0) never-applied sentinel.
        seed_vt_grid(&state, "s", 24, 80);
        // A first resize matching only the startup dims must seed *applied from
        // the live grid and then no-op — no gratuitous SIGWINCH, no session touch.
        assert_eq!(resize_session_core(&state, "s", 24, 80), Ok(None));
        // The seed must have populated resize_locks with the live grid dims.
        assert_eq!(
            *state.resize_locks.get("s").unwrap().lock(),
            (24, 80),
            "first resize must seed the last-applied dims from the live grid"
        );
    }

    /// Build a real PTY session (openpty + a long-lived child) at the given dims,
    /// plus a matching VtLogBuffer, so resize_session_core reaches the real
    /// master.resize() ioctl and get_size() reflects it.
    #[cfg(unix)]
    fn spawn_real_pty_session(state: &crate::state::AppState, sid: &str, rows: u16, cols: u16) {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]);
        let child = pair.slave.spawn_command(cmd).expect("spawn shell");
        let master = pair.master;
        let writer = master.take_writer().expect("writer");
        state.sessions.insert(
            sid.to_string(),
            Mutex::new(PtySession {
                writer,
                master,
                _child: child,
                paused: Arc::new(AtomicBool::new(false)),
                worktree: None,
                cwd: None,
                display_name: None,
                shell: "/bin/sh".to_string(),
            }),
        );
        seed_vt_grid(state, sid, rows, cols);
    }

    /// CONC-B invariant: two concurrent resizes with different dims must leave the
    /// grid AND the PTY at the same dimensions — both equal to whichever call
    /// acquired the per-session lock last — never a grid/PTY mismatch. Stress the
    /// race with a barrier over many iterations, like the CONC-A test above.
    #[cfg(unix)]
    #[test]
    fn concurrent_differing_resizes_leave_grid_and_pty_consistent() {
        use std::sync::Barrier;
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let sid = "resize-race";
        spawn_real_pty_session(&state, sid, 24, 80);

        const A: (u16, u16) = (30, 100);
        const B: (u16, u16) = (40, 120);

        for i in 0..100 {
            let barrier = Arc::new(Barrier::new(2));
            let (s1, b1) = (Arc::clone(&state), Arc::clone(&barrier));
            let t1 = std::thread::spawn(move || {
                b1.wait();
                let _ = resize_session_core(&s1, sid, A.0, A.1);
            });
            let (s2, b2) = (Arc::clone(&state), Arc::clone(&barrier));
            let t2 = std::thread::spawn(move || {
                b2.wait();
                let _ = resize_session_core(&s2, sid, B.0, B.1);
            });
            t1.join().unwrap();
            t2.join().unwrap();

            // The recorded applied dims, the live grid dims, and the real PTY size
            // must all agree, and agree on one of the two racing targets.
            let applied = *state.resize_locks.get(sid).unwrap().lock();
            let (grid_rows, grid_cols) = {
                let vt = state.vt_log_buffers.get(sid).unwrap();
                let vt = vt.lock();
                (vt.grid_screen_lines() as u16, vt.grid_columns() as u16)
            };
            let pty_size = state
                .sessions
                .get(sid)
                .unwrap()
                .lock()
                .master
                .get_size()
                .expect("get_size");
            assert_eq!(
                (grid_rows, grid_cols),
                applied,
                "iter {i}: grid dims must match recorded applied dims"
            );
            assert_eq!(
                (pty_size.rows, pty_size.cols),
                applied,
                "iter {i}: PTY size must match recorded applied dims"
            );
            assert!(
                applied == A || applied == B,
                "iter {i}: applied {applied:?} must be one of the racing targets"
            );
        }
    }

    #[test]
    fn idle_transition_emits_before_submitting_one_pending_message() {
        use std::collections::VecDeque;
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "sess", SHELL_BUSY);
        let mut q = VecDeque::new();
        q.push_back("msg-1".to_string());
        q.push_back("msg-2".to_string());
        state.pending_injections.insert("sess".to_string(), q);

        // The transition is driven by verified ready-screen/Stop evidence in
        // production. Model that evidence before testing its delivery side effect.
        state
            .silence_states
            .get("sess")
            .unwrap()
            .lock()
            .confirm_idle();

        let mut events = state.event_bus.subscribe();
        assert!(try_shell_transition(
            &state, "sess", SHELL_BUSY, SHELL_IDLE, false
        ));
        emit_shell_state(&state, "sess", "idle");
        flush_one_pending_as_submitted(&state, "sess");

        assert_eq!(
            state.pending_injections.get("sess").map(|q| q.len()),
            Some(1),
            "only one queued message may be submitted per idle turn"
        );
        let states: Vec<String> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                crate::state::AppEvent::PtyParsed { parsed, .. }
                    if parsed.get("type").and_then(|v| v.as_str()) == Some("shell-state") =>
                {
                    parsed
                        .get("state")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                }
                _ => None,
            })
            .collect();
        assert_eq!(states, vec!["idle", "busy"]);
    }

    #[test]
    fn flush_keeps_pending_while_question_confident() {
        use std::collections::VecDeque;
        let state = crate::state::tests_support::make_test_app_state();
        use std::sync::atomic::AtomicU8;
        state
            .shell_states
            .insert("sess".to_string(), AtomicU8::new(SHELL_BUSY));
        state.session_states.insert(
            "sess".to_string(),
            crate::state::SessionState {
                agent_type: Some("claude".to_string()),
                awaiting_input: true,
                question_confident: true,
                ..Default::default()
            },
        );
        let mut q = VecDeque::new();
        q.push_back("later".to_string());
        state.pending_injections.insert("sess".to_string(), q);

        state.silence_states.insert(
            "sess".to_string(),
            Arc::new(Mutex::new(SilenceState::new())),
        );
        state
            .silence_states
            .get("sess")
            .unwrap()
            .lock()
            .confirm_idle();

        try_shell_transition(&state, "sess", SHELL_BUSY, SHELL_IDLE, false);
        emit_shell_state(&state, "sess", "idle");
        flush_pending_injections(&state, "sess");
        assert_eq!(
            state.pending_injections.get("sess").map(|q| q.len()),
            Some(1),
            "must not answer a confident user prompt — keep queued until it clears"
        );

        // The question clears (user answered) while the session is already idle:
        // the unblock flush must drain the queue with no further transition.
        state
            .session_states
            .get_mut("sess")
            .unwrap()
            .question_confident = false;
        flush_one_pending_as_submitted(&state, "sess");
        assert_eq!(
            state.pending_injections.get("sess").map(|q| q.len()),
            Some(0),
            "unblock flush must submit once the confident question clears"
        );
    }

    #[test]
    fn injection_payload_single_line_ctrl_u_only() {
        // Single-line: Ctrl-U prefix clears pending input; no paste wrapper.
        assert_eq!(injection_payload("hello"), "\x15hello");
    }

    #[test]
    fn injection_payload_multiline_bracketed_paste() {
        // Multiline MUST ride in a bracketed paste — raw newlines prefill an
        // Ink/codex TUI without submitting; the paste-end marker makes the
        // separately-written CR a genuine Enter (story 091, verified live).
        assert_eq!(
            injection_payload("line1\nline2"),
            "\x15\x1b[200~line1\nline2\x1b[201~"
        );
    }

    #[test]
    fn flush_noop_while_busy() {
        // flush_pending_injections is self-guarded: a direct call against a busy
        // agent (e.g. the user-input unblock path firing while the agent already
        // went back to work) must leave the queue untouched.
        use std::collections::VecDeque;
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "busy", SHELL_BUSY);
        let mut q = VecDeque::new();
        q.push_back("later".to_string());
        state.pending_injections.insert("busy".to_string(), q);

        flush_pending_injections(&state, "busy");
        assert_eq!(
            state.pending_injections.get("busy").map(|q| q.len()),
            Some(1),
            "busy agent → flush must be a no-op"
        );
    }

    #[test]
    fn ready_prompt_delivery_attempts_and_requeues_when_pty_is_missing() {
        // codex idles at its ready prompt with awaiting_input=true (low-confidence
        // silence heuristic) — delivery must inject, not queue forever (story 091).
        use std::sync::atomic::AtomicU8;
        let state = crate::state::tests_support::make_test_app_state();
        state
            .shell_states
            .insert("codex".to_string(), AtomicU8::new(SHELL_IDLE));
        state.session_states.insert(
            "codex".to_string(),
            crate::state::SessionState {
                agent_type: Some("codex".to_string()),
                awaiting_input: true,
                question_confident: false,
                ..Default::default()
            },
        );
        let mut silence = SilenceState::new();
        silence.confirm_idle();
        state
            .silence_states
            .insert("codex".to_string(), Arc::new(Mutex::new(silence)));
        deliver_message_to_pty(&state, "codex", "[TUIC message from lead] go");
        assert_eq!(
            state
                .pending_injections
                .get("codex")
                .and_then(|queue| queue.front().cloned()),
            Some("[TUIC message from lead] go".to_string()),
            "ready-prompt delivery must stay retryable when PTY lookup fails"
        );
    }

    #[test]
    fn state_change_to_parent_without_managed_pty_stays_inbox_only() {
        // Logical agent state alone is not proof of a managed PTY. A child state
        // change must remain available in the inbox without creating a phantom
        // terminal injection for an external peer.
        let state = crate::state::tests_support::make_test_app_state();
        agent_session(&state, "parent", SHELL_BUSY);
        state
            .session_parent
            .insert("child".to_string(), "parent".to_string());

        push_state_change_to_parent(
            &state,
            "child",
            serde_json::json!({"type":"state_change","state":"idle","session_id":"child"}),
        );

        // Inbox got the JSON payload…
        assert_eq!(
            state.agent_inbox.get("parent").map(|q| q.len()),
            Some(1),
            "parent inbox must receive the state_change"
        );
        assert!(
            !state.pending_injections.contains_key("parent"),
            "an external peer without a managed PTY must not receive terminal input"
        );
        let message_id = state
            .agent_inbox
            .get("parent")
            .unwrap()
            .front()
            .unwrap()
            .id
            .clone();
        assert_eq!(state.agent_delivery_owner("parent", &message_id), None);
    }

    #[test]
    fn mark_session_exited_sends_single_exited_notification() {
        // F1/DATA-1: only one state_change("exited") must reach parent inbox on exit.
        // The BUSY→IDLE transition in the exit path uses notify_parent=false, so the
        // orchestrator must never see a spurious "idle" before "exited".
        let state = crate::state::tests_support::make_test_app_state();
        let child_id = "child-exit-dedup";
        let parent_id = "parent-exit-dedup";

        state
            .session_parent
            .insert(child_id.to_string(), parent_id.to_string());
        state.agent_inbox.entry(parent_id.to_string()).or_default();
        let mut ss = crate::state::SessionState::default();
        ss.agent_type = Some("claude".to_string());
        state.session_states.insert(child_id.to_string(), ss);
        state.shell_states.insert(
            child_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_BUSY),
        );

        // Simulate exit path: transition (notify_parent=false) + mark_session_exited.
        try_shell_transition(&state, child_id, SHELL_BUSY, SHELL_IDLE, false);
        // mark_session_exited needs a sessions entry to attempt exit-code capture
        // (it's OK if there's none — it just skips the exit code).
        push_state_change_to_parent(
            &state,
            child_id,
            serde_json::json!({
                "type": "state_change",
                "state": "exited",
                "session_id": child_id,
                "exit_code": null,
            }),
        );

        let inbox = state
            .agent_inbox
            .get(parent_id)
            .expect("parent inbox must exist");
        assert_eq!(inbox.len(), 1, "inbox must have exactly one message");
        let content: serde_json::Value =
            serde_json::from_str(&inbox.front().unwrap().content).unwrap();
        assert_eq!(
            content["state"], "exited",
            "the single message must be 'exited'"
        );
    }

    #[test]
    fn tuic_osc_suggest_parsed_from_pty_stream() {
        use crate::terminal_grid::TerminalGrid;
        let mut grid = TerminalGrid::new(24, 80, 1000);
        grid.process(b"\x1b]7770;suggest=Fix bug|Run tests|Deploy\x07");
        let events = grid.drain_events();
        let tuic: Vec<_> = events
            .into_iter()
            .filter(|e| matches!(e, crate::terminal_grid::TermEvent::Tuic { .. }))
            .collect();
        assert_eq!(tuic.len(), 1);
        if let crate::terminal_grid::TermEvent::Tuic { verb, payload, .. } = &tuic[0] {
            assert_eq!(verb, "suggest");
            let items: Vec<String> = payload.split('|').map(|s| s.trim().to_string()).collect();
            assert_eq!(items, vec!["Fix bug", "Run tests", "Deploy"]);
        }
    }

    #[test]
    fn tuic_osc_intent_with_title_parsed() {
        use crate::terminal_grid::TerminalGrid;
        let mut grid = TerminalGrid::new(24, 80, 1000);
        grid.process(b"\x1b]7770;intent=Refactoring auth (Auth)\x07");
        let events = grid.drain_events();
        let tuic: Vec<_> = events
            .into_iter()
            .filter(|e| matches!(e, crate::terminal_grid::TermEvent::Tuic { .. }))
            .collect();
        assert_eq!(tuic.len(), 1);
        if let crate::terminal_grid::TermEvent::Tuic { verb, payload, .. } = &tuic[0] {
            assert_eq!(verb, "intent");
            assert_eq!(payload, "Refactoring auth (Auth)");
        }
    }

    #[test]
    fn tuic_osc_block_start_parsed() {
        use crate::terminal_grid::TerminalGrid;
        let mut grid = TerminalGrid::new(24, 80, 1000);
        grid.process(b"\x1b]7770;block=start\x07");
        let events = grid.drain_events();
        let tuic: Vec<_> = events
            .into_iter()
            .filter(|e| matches!(e, crate::terminal_grid::TermEvent::Tuic { .. }))
            .collect();
        assert_eq!(tuic.len(), 1);
        if let crate::terminal_grid::TermEvent::Tuic { verb, payload, .. } = &tuic[0] {
            assert_eq!(verb, "block");
            assert_eq!(payload, "start");
        }
    }

    #[test]
    fn tuic_osc_block_end_with_exit_code_parsed() {
        let payload = "end;1".to_string();
        let (action, exit_code) = if let Some(rest) = payload.strip_prefix("end;") {
            ("end".to_string(), rest.parse::<i32>().ok())
        } else {
            (payload.clone(), None)
        };
        assert_eq!(action, "end");
        assert_eq!(exit_code, Some(1));
    }

    #[test]
    fn tuic_osc_block_end_without_exit_code() {
        let payload = "end".to_string();
        let (action, exit_code) = if let Some(rest) = payload.strip_prefix("end;") {
            ("end".to_string(), rest.parse::<i32>().ok())
        } else {
            (payload.clone(), None)
        };
        assert_eq!(action, "end");
        assert_eq!(exit_code, None);
    }

    #[test]
    fn tuic_osc_block_invalid_action_ignored() {
        let payload = "invalid".to_string();
        let (action, _exit_code) = if let Some(rest) = payload.strip_prefix("end;") {
            ("end".to_string(), rest.parse::<i32>().ok())
        } else {
            (payload.clone(), None)
        };
        let is_valid = action == "start" || action == "end";
        assert!(!is_valid, "invalid action should not produce an event");
    }

    #[test]
    fn tuic_osc_state_transitions_shell_state() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "test-tuic-state";
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_IDLE),
        );
        state
            .shell_state_since_ms
            .insert(session_id.to_string(), std::sync::atomic::AtomicU64::new(0));

        let proc = ChunkProcessor::new(None, None);
        proc.handle_tuic_state("busy", session_id, &state);

        let current = state
            .shell_states
            .get(session_id)
            .unwrap()
            .load(std::sync::atomic::Ordering::Acquire);
        assert_eq!(current, SHELL_BUSY);

        proc.handle_tuic_state("idle", session_id, &state);
        let current = state
            .shell_states
            .get(session_id)
            .unwrap()
            .load(std::sync::atomic::Ordering::Acquire);
        assert_eq!(current, SHELL_IDLE);
    }

    #[test]
    fn tuic_osc_state_emits_shell_state_event() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "test-tuic-emit";
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_IDLE),
        );
        state
            .shell_state_since_ms
            .insert(session_id.to_string(), std::sync::atomic::AtomicU64::new(0));

        let mut rx = state.event_bus.subscribe();

        let proc = ChunkProcessor::new(None, None);
        proc.handle_tuic_state("busy", session_id, &state);

        let evt = rx.try_recv();
        assert!(
            evt.is_ok(),
            "event_bus should have received a shell state event"
        );
        if let Ok(crate::state::AppEvent::PtyParsed {
            session_id: sid,
            parsed,
        }) = evt
        {
            assert_eq!(sid, session_id);
            assert_eq!(parsed["type"], "shell-state");
            assert_eq!(parsed["state"], "busy");
        } else {
            panic!("expected PtyParsed event with shell-state");
        }
    }

    #[test]
    fn tuic_osc_state_unknown_verb_ignored() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "test-tuic-unknown";
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_IDLE),
        );

        let proc = ChunkProcessor::new(None, None);
        proc.handle_tuic_state("thinking", session_id, &state);

        let current = state
            .shell_states
            .get(session_id)
            .unwrap()
            .load(std::sync::atomic::Ordering::Acquire);
        assert_eq!(
            current, SHELL_IDLE,
            "unknown state should not change shell_states"
        );
    }

    #[test]
    fn tuic_state_awaiting_yields_confident_question() {
        match tuic_state_awaiting_event("awaiting", 0) {
            Some(ParsedEvent::Question {
                confident,
                prompt_text,
            }) => {
                assert!(confident, "hook awaiting must be a confident question");
                assert_eq!(prompt_text, "", "hook awaiting carries no prompt text");
            }
            other => panic!("expected confident Question, got {other:?}"),
        }
    }

    #[test]
    fn tuic_state_busy_yields_userinput_clear_with_prompt_line() {
        // The busy transition's absolute prompt row (history_size + cursor row,
        // here 42) must reach the UserInput event so the frontend can mark the
        // user-prompt line on the scrollbar.
        match tuic_state_awaiting_event("busy", 42) {
            Some(ParsedEvent::UserInput { content, line }) => {
                assert_eq!(content, "", "busy clear must not overwrite last_prompt");
                assert_eq!(line, 42, "busy UserInput must carry the prompt row");
            }
            other => panic!("expected UserInput clear, got {other:?}"),
        }
    }

    #[test]
    fn tuic_state_idle_yields_no_awaiting_event() {
        assert!(
            tuic_state_awaiting_event("idle", 0).is_none(),
            "idle only transitions shell_state; it pushes no awaiting event"
        );
    }

    #[test]
    fn tuic_state_unknown_yields_no_awaiting_event() {
        assert!(
            tuic_state_awaiting_event("thinking", 0).is_none(),
            "unknown verb must push no awaiting event"
        );
    }

    #[test]
    fn question_suppress_filters_only_questions_when_instrumented() {
        let q_low = ParsedEvent::Question {
            prompt_text: "?".into(),
            confident: false,
        };
        let q_high = ParsedEvent::Question {
            prompt_text: "Proceed?".into(),
            confident: true,
        };
        let other = ParsedEvent::UserInput {
            content: "hi".into(),
            line: -1,
        };
        // Instrumented: every Question (silence + regex) is suppressed.
        assert!(suppress_heuristic_question(true, &q_low));
        assert!(suppress_heuristic_question(true, &q_high));
        // Non-questions are never suppressed (idle/busy/etc. pass through).
        assert!(!suppress_heuristic_question(true, &other));
        // Not instrumented: nothing is suppressed.
        assert!(!suppress_heuristic_question(false, &q_low));
    }

    #[test]
    fn question_suppress_resolves_from_agent_config() {
        use crate::config::{AgentSettings, AgentsConfig};
        let mut agents = AgentsConfig::default();
        let mut enabled = AgentSettings::default();
        enabled.hook_instrumentation = Some(true);
        agents.agents.insert("claude".into(), enabled);
        let mut disabled = AgentSettings::default();
        disabled.hook_instrumentation = Some(false);
        agents.agents.insert("codex".into(), disabled);

        assert!(hook_instrumented_for(&agents, Some("claude")));
        assert!(
            !hook_instrumented_for(&agents, Some("codex")),
            "explicit false"
        );
        assert!(
            !hook_instrumented_for(&agents, Some("gemini")),
            "no override"
        );
        assert!(!hook_instrumented_for(&agents, None), "no agent type");
    }

    #[test]
    fn osc133_a_transitions_to_idle_immediately() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "test-osc133-idle";
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_BUSY),
        );
        state
            .shell_state_since_ms
            .insert(session_id.to_string(), std::sync::atomic::AtomicU64::new(0));
        state
            .has_osc133_integration
            .insert(session_id.to_string(), ());

        let mut proc = ChunkProcessor::new(None, None);
        proc.handle_osc133_event('A', "", session_id, &state);

        let current = state
            .shell_states
            .get(session_id)
            .unwrap()
            .load(std::sync::atomic::Ordering::Acquire);
        assert_eq!(
            current, SHELL_IDLE,
            "OSC 133 A should transition to idle immediately"
        );
    }

    #[test]
    fn osc133_c_transitions_to_busy_immediately() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "test-osc133-busy";
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_IDLE),
        );
        state
            .shell_state_since_ms
            .insert(session_id.to_string(), std::sync::atomic::AtomicU64::new(0));
        state
            .has_osc133_integration
            .insert(session_id.to_string(), ());

        let mut proc = ChunkProcessor::new(None, None);
        proc.handle_osc133_event('C', "", session_id, &state);

        let current = state
            .shell_states
            .get(session_id)
            .unwrap()
            .load(std::sync::atomic::Ordering::Acquire);
        assert_eq!(
            current, SHELL_BUSY,
            "OSC 133 C should transition to busy immediately"
        );
    }

    #[test]
    fn osc133_a_emits_shell_state_event() {
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "test-osc133-emit";
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_BUSY),
        );
        state
            .shell_state_since_ms
            .insert(session_id.to_string(), std::sync::atomic::AtomicU64::new(0));

        // Subscribe to event bus before transition
        let mut rx = state.event_bus.subscribe();

        let mut proc = ChunkProcessor::new(None, None);
        proc.handle_osc133_event('A', "", session_id, &state);

        // Check event_bus received a state change
        let evt = rx.try_recv();
        assert!(
            evt.is_ok(),
            "event_bus should have received a shell state event"
        );
        if let Ok(crate::state::AppEvent::PtyParsed {
            session_id: sid,
            parsed,
        }) = evt
        {
            assert_eq!(sid, session_id);
            assert_eq!(parsed["type"], "shell-state");
            assert_eq!(parsed["state"], "idle");
        } else {
            panic!("expected PtyParsed event with shell-state");
        }
    }

    #[test]
    fn osc133_d_does_not_transition_alone() {
        // D means "command finished" but idle only happens when A arrives (prompt shown)
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "test-osc133-d";
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_BUSY),
        );
        state
            .shell_state_since_ms
            .insert(session_id.to_string(), std::sync::atomic::AtomicU64::new(0));
        state
            .has_osc133_integration
            .insert(session_id.to_string(), ());

        let mut proc = ChunkProcessor::new(None, None);
        proc.handle_osc133_event('D', "0", session_id, &state);

        let current = state
            .shell_states
            .get(session_id)
            .unwrap()
            .load(std::sync::atomic::Ordering::Acquire);
        assert_eq!(
            current, SHELL_BUSY,
            "OSC 133 D alone should NOT transition — wait for A"
        );
    }

    #[test]
    fn osc133_d_without_c_records_no_outcome() {
        // A 'D' (command finished) without a preceding 'C' (command started) —
        // e.g. Enter on an empty prompt — must NOT record a phantom outcome
        // (empty command, "unknown" error) that would pollute the knowledge
        // panel and the agent's injected prompt.
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "test-osc133-d-no-c";
        state
            .has_osc133_integration
            .insert(session_id.to_string(), ());

        let mut proc = ChunkProcessor::new(None, None);
        proc.handle_osc133_event('D', "1", session_id, &state);

        let recorded = state
            .session_knowledge
            .get(session_id)
            .map(|k| k.lock().commands.len())
            .unwrap_or(0);
        assert_eq!(recorded, 0, "D without C must not record an outcome");
    }

    #[test]
    fn osc133_c_then_d_records_outcome() {
        // Regression guard: the normal path still records — C captures the
        // command start, D finalizes the outcome.
        let state = crate::state::tests_support::make_test_app_state();
        let session_id = "test-osc133-c-then-d";
        state.shell_states.insert(
            session_id.to_string(),
            std::sync::atomic::AtomicU8::new(SHELL_IDLE),
        );
        state
            .shell_state_since_ms
            .insert(session_id.to_string(), std::sync::atomic::AtomicU64::new(0));
        state
            .has_osc133_integration
            .insert(session_id.to_string(), ());

        let mut proc = ChunkProcessor::new(None, None);
        proc.handle_osc133_event('C', "", session_id, &state);
        proc.handle_osc133_event('D', "0", session_id, &state);

        let recorded = state
            .session_knowledge
            .get(session_id)
            .map(|k| k.lock().commands.len())
            .unwrap_or(0);
        assert_eq!(recorded, 1, "C→D should record exactly one outcome");
    }

    // --- is_cc_tool_call_header tests ---

    #[test]
    fn cc_tool_call_bash() {
        assert!(is_cc_tool_call_header(
            "⏺ Bash(curl -s 'http://localhost:9876/logs')"
        ));
    }

    #[test]
    fn cc_tool_call_read() {
        assert!(is_cc_tool_call_header("⏺ Read(src/foo.rs)"));
    }

    #[test]
    fn cc_tool_call_edit() {
        assert!(is_cc_tool_call_header("⏺ Edit(file_path=/tmp/a.rs)"));
    }

    #[test]
    fn cc_tool_call_mcp() {
        assert!(is_cc_tool_call_header(
            "⏺ mcp__tuicommander__ui(action=tab)"
        ));
    }

    #[test]
    fn cc_tool_call_with_leading_whitespace() {
        assert!(is_cc_tool_call_header("  ⏺ Bash(ls)"));
    }

    #[test]
    fn cc_prose_not_tool_call() {
        assert!(!is_cc_tool_call_header("⏺ Boss, ci sono molti tipi di OSC"));
    }

    #[test]
    fn cc_prose_with_paren_not_tool_call() {
        assert!(!is_cc_tool_call_header(
            "⏺ Nessun errore (tutti i log puliti)"
        ));
    }

    #[test]
    fn cc_calling_collapsed_not_tool_call() {
        assert!(!is_cc_tool_call_header(
            "⏺ Calling tuicommander 2 times… (ctrl+o to expand)"
        ));
    }

    #[test]
    fn cc_mission_control_not_tool_call() {
        assert!(!is_cc_tool_call_header(
            "⏺ Mission Control: opened in TUIC tab"
        ));
    }

    #[test]
    fn cc_empty_after_bullet_not_tool_call() {
        assert!(!is_cc_tool_call_header("⏺ "));
        assert!(!is_cc_tool_call_header("⏺"));
    }

    #[test]
    fn cc_no_bullet_not_tool_call() {
        assert!(!is_cc_tool_call_header("Bash(ls)"));
        assert!(!is_cc_tool_call_header("plain text"));
    }

    /// Closing a tab must kill the agent grandchild, not just the shell.
    ///
    /// Mirrors `claude` launched inside the PTY's shell: shell → grandchild,
    /// both ignoring SIGINT/SIGTERM/SIGHUP so only the SIGKILL on the foreground
    /// process group can reap them. Before the killpg fix, `close_pty_core`
    /// SIGKILLed the shell alone and the grandchild was orphaned to init.
    #[cfg(unix)]
    #[test]
    fn close_pty_core_kills_agent_grandchild() {
        use std::time::{Duration, Instant};

        let pidfile = std::env::temp_dir().join(format!("tuic_pgkill_{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pidfile);

        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        // Outer shell ignores the catchable signals and backgrounds a grandchild
        // that also ignores them, recording the grandchild PID for the probe.
        let script = format!(
            "trap '' INT TERM HUP; sh -c 'trap \"\" INT TERM HUP; sleep 30' & echo $! > {}; wait",
            pidfile.display()
        );
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", &script]);
        let child = pty.slave.spawn_command(cmd).expect("spawn shell");

        let master = pty.master;
        let writer = master.take_writer().expect("writer");

        let state = crate::state::tests_support::make_test_app_state();
        let sid = "test-pgkill";
        state
            .metrics
            .active_sessions
            .fetch_add(1, Ordering::Relaxed);
        state.sessions.insert(
            sid.to_string(),
            Mutex::new(PtySession {
                writer,
                master,
                _child: child,
                paused: Arc::new(AtomicBool::new(false)),
                worktree: None,
                cwd: None,
                display_name: None,
                shell: "/bin/sh".to_string(),
            }),
        );

        let pid_alive = |pid: libc::pid_t| unsafe { libc::kill(pid, 0) } == 0;
        let read_pid = || {
            std::fs::read_to_string(&pidfile)
                .ok()
                .and_then(|s| s.trim().parse::<libc::pid_t>().ok())
        };

        // Wait for the grandchild to come up and record its PID (up to ~3s).
        let mut grandchild = None;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Some(pid) = read_pid() {
                grandchild = Some(pid);
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let grandchild = grandchild.expect("grandchild PID should be written");
        assert!(
            pid_alive(grandchild),
            "grandchild should be alive before close"
        );

        close_pty_core(&state, sid, false);

        // killpg(SIGKILL) is untrappable: the grandchild must be gone shortly.
        let mut dead = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if !pid_alive(grandchild) {
                dead = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = std::fs::remove_file(&pidfile);
        assert!(
            dead,
            "grandchild {grandchild} survived tab close — orphaned process tree"
        );
    }

    // ── process_kitty_actions ───────────────────────────────────────

    #[test]
    fn process_kitty_actions_empty_is_noop() {
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "kitty-empty";
        process_kitty_actions(&[], sid, &state);
        assert!(
            !state.kitty_states.contains_key(sid),
            "empty action list must not allocate per-session kitty state"
        );
    }

    #[test]
    fn process_kitty_actions_push_pop_query_tracks_flag_stack() {
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "kitty-stack";

        // Two pushes: current flags follow the top of the stack.
        process_kitty_actions(&[KittyAction::Push(1), KittyAction::Push(5)], sid, &state);
        assert_eq!(
            state.kitty_states.get(sid).unwrap().lock().current_flags(),
            5
        );

        // Pop returns to the first pushed value.
        process_kitty_actions(&[KittyAction::Pop], sid, &state);
        assert_eq!(
            state.kitty_states.get(sid).unwrap().lock().current_flags(),
            1
        );

        // Query with no live PTY session must not panic (writer path is skipped)
        // and must leave the flag stack untouched.
        process_kitty_actions(&[KittyAction::Query], sid, &state);
        assert_eq!(
            state.kitty_states.get(sid).unwrap().lock().current_flags(),
            1
        );
    }

    // ── cleanup_session ─────────────────────────────────────────────

    #[test]
    fn cleanup_session_clears_transient_session_maps() {
        use std::sync::atomic::{AtomicU8, AtomicU64};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "cleanup-maps";
        state
            .output_buffers
            .insert(sid.to_string(), Mutex::new(OutputRingBuffer::new(4096)));
        state.vt_log_buffers.insert(
            sid.to_string(),
            Mutex::new(crate::state::VtLogBuffer::new(24, 80, 1000)),
        );
        state
            .kitty_states
            .insert(sid.to_string(), Mutex::new(KittyKeyboardState::new()));
        state
            .shell_states
            .insert(sid.to_string(), AtomicU8::new(SHELL_IDLE));
        state
            .last_output_ms
            .insert(sid.to_string(), AtomicU64::new(0));
        state
            .term_aliases
            .insert(sid.to_string(), "alias".to_string());
        state.exit_codes.insert(sid.to_string(), 0);

        cleanup_session(sid, &state);

        assert!(!state.output_buffers.contains_key(sid));
        assert!(!state.vt_log_buffers.contains_key(sid));
        assert!(!state.kitty_states.contains_key(sid));
        assert!(!state.shell_states.contains_key(sid));
        assert!(!state.last_output_ms.contains_key(sid));
        assert!(!state.term_aliases.contains_key(sid));
        assert!(!state.exit_codes.contains_key(sid));
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_session_removes_session_and_decrements_metrics() {
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "cleanup-real";
        spawn_short_session(&state, sid);
        let before = state.metrics.active_sessions.load(Ordering::Relaxed);
        assert!(state.sessions.contains_key(sid));

        cleanup_session(sid, &state);

        assert!(
            !state.sessions.contains_key(sid),
            "the live session entry must be removed"
        );
        assert_eq!(
            state.metrics.active_sessions.load(Ordering::Relaxed),
            before - 1,
            "removing a live session must decrement the active-session gauge"
        );
    }

    /// Insert a minimal real PTY session (short-lived `sleep`) so functions that
    /// require a live `PtySession` can be exercised. Mirrors `create_pty`'s
    /// active-session bookkeeping.
    #[cfg(unix)]
    fn spawn_short_session(state: &crate::state::AppState, sid: &str) {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "sleep 5"]);
        let child = pty.slave.spawn_command(cmd).expect("spawn");
        let master = pty.master;
        let writer = master.take_writer().expect("writer");
        state
            .metrics
            .active_sessions
            .fetch_add(1, Ordering::Relaxed);
        state.sessions.insert(
            sid.to_string(),
            Mutex::new(PtySession {
                writer,
                master,
                _child: child,
                paused: Arc::new(AtomicBool::new(false)),
                worktree: None,
                cwd: None,
                display_name: None,
                shell: "/bin/sh".to_string(),
            }),
        );
    }

    // ── ChunkProcessor::check_pending_planfiles ─────────────────────

    #[test]
    fn check_pending_planfiles_empty_is_noop() {
        let state = crate::state::tests_support::make_test_app_state();
        let mut cp = ChunkProcessor::new(None, None);
        cp.check_pending_planfiles("sid", &state);
        assert!(cp.pending_planfiles.is_empty());
    }

    #[test]
    fn check_pending_planfiles_drops_expired_and_tombstones() {
        use std::time::{Duration, Instant};
        let state = crate::state::tests_support::make_test_app_state();
        let mut cp = ChunkProcessor::new(None, None);
        let missing = "/no/such/planfile/expired.md".to_string();
        // Deadline in the (immediate) past: the internal `Instant::now()` runs
        // after the sleep, so `now > deadline` holds.
        cp.pending_planfiles.push((missing.clone(), Instant::now()));
        std::thread::sleep(Duration::from_millis(2));

        cp.check_pending_planfiles("sid", &state);

        assert!(
            cp.pending_planfiles.is_empty(),
            "an expired retry must be dropped from the queue"
        );
        assert!(
            cp.gaveup_planfiles.contains(&missing),
            "a dropped retry must be tombstoned so it is not re-queued forever"
        );
    }

    #[test]
    fn check_pending_planfiles_keeps_missing_file_until_deadline() {
        use std::time::{Duration, Instant};
        let state = crate::state::tests_support::make_test_app_state();
        let mut cp = ChunkProcessor::new(None, None);
        let missing = "/no/such/planfile/pending.md".to_string();
        cp.pending_planfiles
            .push((missing, Instant::now() + Duration::from_secs(30)));

        cp.check_pending_planfiles("sid", &state);

        assert_eq!(
            cp.pending_planfiles.len(),
            1,
            "a not-yet-existing file with a live deadline stays queued"
        );
    }

    #[test]
    fn check_pending_planfiles_emits_when_file_appears() {
        use std::time::{Duration, Instant};
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "planfile-emit";
        let mut cp = ChunkProcessor::new(None, None);

        let dir = std::env::temp_dir().join(format!("tuic_planfile_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let file = dir.join("plan.md");
        std::fs::write(&file, "# plan").expect("write plan file");
        let path = file.to_string_lossy().to_string();

        cp.pending_planfiles
            .push((path.clone(), Instant::now() + Duration::from_secs(30)));
        let mut rx = state.event_bus.subscribe();

        cp.check_pending_planfiles(sid, &state);

        assert!(
            cp.pending_planfiles.is_empty(),
            "a resolved file must leave the retry queue"
        );
        assert!(
            cp.emitted_planfiles.contains(&path),
            "a resolved path must be recorded as emitted"
        );
        let mut got = false;
        while let Ok(evt) = rx.try_recv() {
            if let crate::state::AppEvent::PtyParsed { parsed, .. } = evt
                && parsed.get("type").and_then(|t| t.as_str()) == Some("plan-file")
                && parsed.get("path").and_then(|p| p.as_str()) == Some(path.as_str())
            {
                got = true;
            }
        }
        assert!(
            got,
            "a resolved plan file must emit a plan-file PtyParsed event"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── wake_session ────────────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn wake_session_returns_false_when_not_in_standby() {
        let state = crate::state::tests_support::make_test_app_state();
        assert_eq!(wake_session(&state, "not-parked"), Ok(false));
    }

    #[cfg(unix)]
    #[test]
    fn wake_session_errors_and_consumes_entry_when_session_missing() {
        let state = crate::state::tests_support::make_test_app_state();
        let sid = "parked-but-gone";
        state.standby_sessions.insert(sid.to_string(), 0);

        let res = wake_session(&state, sid);

        assert!(
            res.is_err(),
            "a standby entry without a live session must error"
        );
        assert!(res.unwrap_err().contains("Session not found"));
        assert!(
            !state.standby_sessions.contains_key(sid),
            "the standby entry is consumed even on the error path"
        );
    }

    // ── process-stats helpers ───────────────────────────────────────

    #[cfg(not(windows))]
    #[test]
    fn query_process_stats_reports_own_process() {
        let own = std::process::id();
        let map = query_process_stats(&[own]);
        assert!(map.contains_key(&own), "ps must report our own pid");
        let (rss, _cpu) = map[&own];
        assert!(
            rss > 0,
            "resident set size of a live process must be positive"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn query_process_stats_empty_input_is_empty() {
        assert!(query_process_stats(&[]).is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn collect_descendant_pids_returns_some_for_live_pid() {
        assert!(
            collect_descendant_pids(std::process::id()).is_some(),
            "walking the process table for a live pid must succeed"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn process_tree_snapshot_reports_own_process() {
        let own = std::process::id();
        let snapshot = process_tree_snapshot().expect("ps process-tree snapshot");
        assert!(
            snapshot.iter().any(|process| process.pid == own),
            "the process-tree parser must preserve live PIDs"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn collect_process_stats_includes_tuicommander_itself() {
        let state = crate::state::tests_support::make_test_app_state();
        let stats = collect_process_stats(&state);
        let own = std::process::id();
        assert!(
            stats
                .iter()
                .any(|s| s.session_id.is_none() && s.pid == own && s.name == "FastAF"),
            "TUIC's own process must appear with no session id"
        );
    }
}
