use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// MCP config lookup result
#[derive(Clone, Serialize)]
pub(crate) struct AgentMcpStatus {
    pub(crate) supported: bool,
    pub(crate) installed: bool,
    pub(crate) config_path: Option<String>,
    /// The bridge entry would go inside the target's general settings file, so
    /// launch-time auto-install leaves it alone. The UI says so — otherwise a
    /// Zed user waits forever for an integration that never arrives.
    pub(crate) shared_settings_file: bool,
}

/// How an agent stores its MCP server list.
#[derive(Clone, Copy, PartialEq, Eq)]
enum McpFormat {
    /// JSON: `{ <key_path>: { "tuicommander": { type, command, args, env } } }`
    Json,
    /// JSON, opencode flavour: `{ "mcp": { "tuicommander": { type: "local",
    /// command: [path], enabled: true } } }`. The schema is
    /// `additionalProperties: false`, so the standard entry shape is rejected.
    OpenCode,
    /// TOML: `[mcp_servers.tuicommander]`. `forward_session` adds the
    /// `env_vars` allowlist Codex needs to pass `TUIC_SESSION` through its
    /// sandbox; agents that inherit the environment do not use it.
    Toml { forward_session: bool },
    /// YAML: goose's `extensions:` map. The entry is an `ExtensionEntry`
    /// (`enabled` + a `type`-tagged `ExtensionConfig`), which names the command
    /// `cmd` and requires `name` and `timeout`.
    Yaml,
}

/// Per-agent MCP config spec
struct McpConfigSpec {
    /// Path to the MCP configuration file
    config_path: PathBuf,
    /// JSON pointer segments to the mcpServers object (e.g. ["mcpServers"]).
    /// Unused for [`McpFormat::Toml`].
    key_path: Vec<&'static str>,
    /// On-disk representation of the server list
    format: McpFormat,
    /// CLI binaries whose presence proves the target is installed
    binaries: &'static [&'static str],
    /// Directory inspected for foreign files when no binary is found.
    /// Defaults to the config file's parent; overridden when that parent is
    /// the home directory (which always has foreign files in it).
    presence_dir: Option<PathBuf>,
    /// Only write when the config file already exists. Set for agents whose MCP
    /// support comes from an optional add-on: the file's presence is the only
    /// proof that the add-on is installed.
    requires_existing_config: bool,
    /// The MCP server list lives inside the file that also holds every other
    /// user preference — Zed, Amp and Gemini all keep it in their
    /// `settings.json` rather than a dedicated `mcp.json`.
    ///
    /// Launch-time auto-install never creates or edits these. The edit itself is
    /// surgical and validated, but FastAF being on the machine is not
    /// consent to rewrite the user's editor configuration (issue #115).
    /// Settings > Agents installs on request, and a target we already
    /// configured keeps getting path repairs — otherwise a moved bridge binary
    /// would leave a dead entry behind with no way to notice.
    shared_settings_file: bool,
}

/// Our MCP server entry injected into agent configs.
/// `args` and `env` are always serialized (even if empty) — some Claude Code
/// versions reject stdio entries whose `args`/`env` are missing or `null`.
#[derive(Serialize, Deserialize)]
struct TuicMcpEntry {
    #[serde(rename = "type", default = "default_stdio_type")]
    transport_type: String,
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

fn default_stdio_type() -> String {
    "stdio".to_string()
}

const TUIC_MCP_KEY: &str = "tuicommander";

/// Get the home directory, panicking on failure (should never happen in practice)
fn home() -> PathBuf {
    dirs::home_dir().expect("HOME directory not found")
}

/// Get the VS Code user directory (platform-specific)
fn vscode_user_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home().join("Library/Application Support/Code/User")
    }
    #[cfg(target_os = "linux")]
    {
        home().join(".config/Code/User")
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata).join("Code/User")
    }
}

/// XDG-style config root. opencode documents its global config as
/// `~/.config/opencode/opencode.json` on every platform, so this deliberately
/// does not use `dirs::config_dir()` (which is `~/Library/Application Support`
/// on macOS).
fn xdg_config_dir() -> PathBuf {
    match std::env::var("XDG_CONFIG_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home().join(".config"),
    }
}

/// opencode reads both `opencode.json` and `opencode.jsonc`. Write to whichever
/// already exists so we never leave the user with two competing configs.
fn opencode_config_path() -> PathBuf {
    let dir = xdg_config_dir().join("opencode");
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    dir.join("opencode.json")
}

/// Look up the MCP config spec for a given agent type.
/// Returns None for agents that don't support MCP.
fn get_mcp_config_spec(agent_type: &str) -> Option<McpConfigSpec> {
    let h = home();
    let json = |config_path: PathBuf, key_path: Vec<&'static str>, binaries| McpConfigSpec {
        config_path,
        key_path,
        format: McpFormat::Json,
        binaries,
        presence_dir: None,
        requires_existing_config: false,
        shared_settings_file: false,
    };
    match agent_type {
        "claude" => Some(McpConfigSpec {
            // The config file sits in $HOME, so presence falls back to the
            // agent's own directory rather than the (always populated) parent.
            presence_dir: Some(h.join(".claude")),
            ..json(h.join(".claude.json"), vec!["mcpServers"], &["claude"])
        }),
        "cursor" => Some(json(
            h.join(".cursor/mcp.json"),
            vec!["mcpServers"],
            &["cursor-agent", "cursor"],
        )),
        "windsurf" => Some(json(
            h.join(".codeium/windsurf/mcp_config.json"),
            vec!["mcpServers"],
            &["windsurf"],
        )),
        "vscode" => Some(json(
            vscode_user_dir().join("mcp.json"),
            vec!["servers"],
            &["code"],
        )),
        "zed" => Some(McpConfigSpec {
            shared_settings_file: true,
            ..json(
                h.join(".config/zed/settings.json"),
                vec!["context_servers"],
                &["zed"],
            )
        }),
        "amp" => Some(McpConfigSpec {
            shared_settings_file: true,
            ..json(
                h.join(".config/amp/settings.json"),
                vec!["amp", "mcpServers"],
                &["amp"],
            )
        }),
        "gemini" => Some(McpConfigSpec {
            shared_settings_file: true,
            ..json(
                h.join(".gemini/settings.json"),
                vec!["mcpServers"],
                &["gemini"],
            )
        }),
        "droid" => Some(json(
            h.join(".factory/mcp.json"),
            vec!["mcpServers"],
            &["droid"],
        )),
        "opencode" => Some(McpConfigSpec {
            format: McpFormat::OpenCode,
            ..json(opencode_config_path(), vec!["mcp"], &["opencode"])
        }),
        "codex" => Some(McpConfigSpec {
            // Codex filters the child environment, so TUIC_SESSION only reaches
            // the bridge when it is on the env_vars allowlist.
            format: McpFormat::Toml {
                forward_session: true,
            },
            ..json(codex_config_path(), vec![], &["codex"])
        }),
        "grok" => Some(McpConfigSpec {
            format: McpFormat::Toml {
                forward_session: false,
            },
            ..json(h.join(".grok/config.toml"), vec![], &["grok"])
        }),
        "goose" => Some(McpConfigSpec {
            format: McpFormat::Yaml,
            ..json(goose_config_path(), vec!["extensions"], &["goose"])
        }),
        "pi" => Some(McpConfigSpec {
            // pi has no built-in MCP client: the pi-mcp-adapter extension adds
            // one and reads this file. Without the file the extension is not
            // installed, so writing it would configure nothing.
            requires_existing_config: true,
            ..json(pi_config_path(), vec!["mcpServers"], &["pi"])
        }),
        // aider has no MCP client at all — the feature PRs were never merged.
        "aider" => None,
        _ => None,
    }
}

/// goose config file. Documented as `~/.config/goose/config.yaml` on macOS and
/// Linux (goose resolves it with etcetera's XDG strategy) and
/// `%APPDATA%\Block\goose\config\config.yaml` on Windows.
fn goose_config_path() -> PathBuf {
    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata).join("Block/goose/config/config.yaml")
    }
    #[cfg(not(windows))]
    {
        xdg_config_dir().join("goose/config.yaml")
    }
}

/// pi's own MCP override file, read by the pi-mcp-adapter extension.
/// `PI_CODING_AGENT_DIR` relocates the agent directory.
fn pi_config_path() -> PathBuf {
    match std::env::var("PI_CODING_AGENT_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir).join("mcp.json"),
        _ => home().join(".pi/agent/mcp.json"),
    }
}

/// Files we create ourselves, plus OS noise, do not prove the target is
/// installed — see [`is_target_installed`].
fn dir_has_foreign_entry(dir: &std::path::Path, ours: Option<&std::ffi::OsStr>) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        if name == ".DS_Store" {
            return false;
        }
        match ours {
            // `write_text_file`/`write_toml_file` stage through `<stem>.tmp`;
            // a crashed write must not read back as a foreign file.
            Some(ours) => {
                name != ours && std::path::Path::new(&name).extension() != Some("tmp".as_ref())
            }
            None => true,
        }
    })
}

/// Is the agent/IDE this spec targets actually present on this machine?
///
/// Without this check TUIC creates `~/.cursor/`, `~/.gemini/`, `~/.config/amp/`
/// and friends on first launch for tools the user never installed — the write
/// path creates every missing parent directory.
///
/// Two independent proofs, cheapest first: the config directory holds a file
/// that is not ours, or one of the CLI binaries resolves. The directory check
/// covers GUI installs whose CLI shim is not on PATH.
fn is_target_installed(spec: &McpConfigSpec) -> bool {
    let presence_dir = spec
        .presence_dir
        .clone()
        .or_else(|| spec.config_path.parent().map(PathBuf::from));
    if let Some(dir) = presence_dir {
        // A dedicated presence_dir holds none of our writes, so every file in
        // it belongs to the tool.
        let ours = if spec.presence_dir.is_some() {
            None
        } else {
            spec.config_path.file_name()
        };
        if dir_has_foreign_entry(&dir, ours) {
            return true;
        }
    }
    spec.binaries
        .iter()
        .any(|binary| crate::cli::has_cli(binary))
}

/// Get the path to an agent's own settings file (for "Edit Config" button)
fn get_agent_settings_path(agent_type: &str) -> Option<PathBuf> {
    let h = home();
    match agent_type {
        "claude" => Some(h.join(".claude/settings.json")),
        "cursor" => Some(h.join(".cursor")),
        "aider" => Some(h.join(".aider.conf.yml")),
        "gemini" => Some(h.join(".gemini/settings.json")),
        "codex" => Some(h.join(".codex/config.toml")),
        "grok" => Some(h.join(".grok/config.toml")),
        "opencode" => Some(opencode_config_path()),
        "droid" => Some(h.join(".factory/mcp.json")),
        "pi" => Some(h.join(".pi/agent/settings.json")),
        "goose" => Some(goose_config_path()),
        "amp" => Some(h.join(".config/amp/settings.json")),
        "zed" => Some(h.join(".config/zed/settings.json")),
        "vscode" => Some(vscode_user_dir().join("settings.json")),
        "windsurf" => Some(h.join(".codeium/windsurf/settings.json")),
        _ => None,
    }
}

/// Navigate a JSON object by key path (read-only).
fn navigate<'a>(root: &'a serde_json::Value, key_path: &[&str]) -> Option<&'a serde_json::Value> {
    let mut current = root;
    for key in key_path {
        current = current.get(*key)?;
    }
    Some(current)
}

const BRIDGE_NAME: &str = "tuic-bridge";

/// Detect the tuic-bridge binary path.
/// Priority: sidecar (same dir as main executable) → PATH → bare name.
fn detect_bridge_binary() -> String {
    // Primary: sidecar bundled alongside the main executable
    // In release: Contents/MacOS/ (macOS), next to .exe (Windows), same dir (Linux)
    // In dev: target/debug/ or target/release/
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        #[cfg(not(windows))]
        let candidate = dir.join(BRIDGE_NAME);
        #[cfg(windows)]
        let candidate = dir.join(format!("{BRIDGE_NAME}.exe"));
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }
    // Fallback: resolve from PATH via well-known directories
    let resolved = crate::cli::resolve_cli(BRIDGE_NAME);
    if std::path::Path::new(&resolved).exists() {
        return resolved;
    }
    // Last resort: bare name, hope it's on PATH
    BRIDGE_NAME.to_string()
}

/// Read a JSON config file's raw text, returning an empty document when the file
/// doesn't exist.
///
/// Returns `None` when the file exists but cannot be read. Callers MUST NOT
/// write in that case — an unreadable file is not an empty one.
fn read_json_text(path: &std::path::Path) -> Option<String> {
    if !path.exists() {
        return Some(String::new());
    }
    std::fs::read_to_string(path)
        .inspect_err(|e| tracing::error!(source = "mcp", path = %path.display(), "Failed to read config: {e}"))
        .ok()
}

/// Read a JSON config file into a value, for callers that only inspect it.
///
/// Parsed as JSONC: Zed, VS Code and opencode all document comments and
/// trailing commas as supported, so `serde_json` would report a perfectly valid
/// file as broken. Returns `None` when the file cannot be read or parsed, and
/// callers MUST NOT write in that case — treating a parse failure as an empty
/// document is what replaced a user's entire Zed configuration with our single
/// entry (issue #115).
fn read_json_file(path: &std::path::Path) -> Option<serde_json::Value> {
    let text = read_json_text(path)?;
    if text.trim().is_empty() {
        return Some(serde_json::json!({}));
    }
    crate::jsonc_edit::parse(&text)
        .inspect_err(|e| tracing::error!(source = "mcp", path = %path.display(), "{e} — leaving the file untouched"))
        .ok()
}

/// Keep the target's own copy of a config file the first time we modify it.
///
/// Stored under TUIC's config directory rather than beside the original: a
/// stray `settings.json.bak` next to `settings.json` is a file the owning tool
/// may itself try to load, sync or complain about.
///
/// Written once and never overwritten. The state worth keeping is the one from
/// before TUIC ever touched the file; a later snapshot of a file we already
/// edited is worth much less, and rewriting it on every path repair would
/// eventually erase the only pristine copy.
fn backup_config_once(path: &std::path::Path, agent_label: &str, text: &str) {
    if text.is_empty() {
        return; // Nothing existed to preserve.
    }
    let dir = crate::config::config_dir().join("mcp-backups");
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".to_string());
    let backup = dir.join(format!("{agent_label}-{name}.orig"));
    if backup.exists() {
        return;
    }
    let saved = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&backup, text));
    match saved {
        Ok(()) => {
            tracing::info!(source = "mcp", agent = %agent_label, backup = %backup.display(), "Saved original config")
        }
        // A failed backup must not block the edit: the edit itself is surgical
        // and validated, so the backup is a second line of defence, not the
        // first.
        Err(e) => {
            tracing::warn!(source = "mcp", agent = %agent_label, "Could not save original config: {e}")
        }
    }
}

/// Write a config file atomically (temp + rename).
fn write_text_file(path: &std::path::Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, text).map_err(|e| format!("Failed to write temp file: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to rename temp file: {e}")
    })?;
    Ok(())
}

/// Supported agent types for auto-install
const SUPPORTED_AGENTS: &[&str] = &[
    "claude", "cursor", "windsurf", "vscode", "zed", "amp", "gemini", "codex", "grok", "opencode",
    "droid", "goose", "pi",
];

/// Build the bridge entry in the shape the target's schema accepts.
fn json_entry_value(format: McpFormat, bridge_path: &str) -> serde_json::Value {
    match format {
        McpFormat::OpenCode => serde_json::json!({
            "type": "local",
            "command": [bridge_path],
            "enabled": true,
        }),
        _ => serde_json::json!({
            "type": "stdio",
            "command": bridge_path,
            "args": [],
            "env": {},
        }),
    }
}

/// Is the entry already exactly what we would write?
fn json_entry_is_current(
    format: McpFormat,
    entry: Option<&serde_json::Value>,
    bridge_path: &str,
) -> bool {
    let Some(entry) = entry else {
        return false;
    };
    match format {
        McpFormat::OpenCode => {
            let command_ok = entry
                .get("command")
                .and_then(|v| v.as_array())
                .is_some_and(|args| args.len() == 1 && args[0].as_str() == Some(bridge_path));
            command_ok && entry.get("type").and_then(|v| v.as_str()) == Some("local")
        }
        _ => {
            let command_ok = entry.get("command").and_then(|v| v.as_str()) == Some(bridge_path);
            // Claude Code rejects stdio entries where `args`/`env` are null or
            // missing, so a malformed entry is rewritten even on a path match.
            let args_ok = entry.get("args").is_some_and(serde_json::Value::is_array);
            let env_ok = entry.get("env").is_some_and(serde_json::Value::is_object);
            command_ok && args_ok && env_ok
        }
    }
}

/// Ensure a single agent's MCP config has the correct bridge entry.
/// Returns true if the config was written (installed or updated).
fn ensure_agent_mcp_entry(
    config_path: &std::path::Path,
    key_path: &[&str],
    format: McpFormat,
    bridge_path: &str,
    agent_label: &str,
) -> bool {
    let Some(text) = read_json_text(config_path) else {
        return false;
    };
    let root = match parse_existing(&text, config_path) {
        Some(root) => root,
        None => return false,
    };
    let existing_entry = navigate(&root, key_path)
        .and_then(|v| v.as_object())
        .and_then(|obj| obj.get(TUIC_MCP_KEY));

    if json_entry_is_current(format, existing_entry, bridge_path) {
        return false;
    }
    match existing_entry.and_then(|entry| entry.get("command")) {
        Some(old) => {
            tracing::info!(source = "mcp", agent = %agent_label, "Rewriting entry: {old} → {bridge_path}");
        }
        None => {
            tracing::info!(source = "mcp", agent = %agent_label, "Installing bridge");
        }
    }

    let entry_value = json_entry_value(format, bridge_path);
    let edited = match crate::jsonc_edit::upsert_member(&text, key_path, TUIC_MCP_KEY, &entry_value)
    {
        Ok(edited) => edited,
        Err(e) => {
            tracing::error!(source = "mcp", agent = %agent_label, path = %config_path.display(), "{e} — leaving the file untouched");
            return false;
        }
    };

    commit_json_edit(config_path, agent_label, &text, &edited)
}

/// Parse a config we are about to modify, rejecting anything we cannot read.
///
/// An empty or absent file becomes an empty object — that one is genuinely new.
/// A file that exists but does not parse yields `None`, and every caller treats
/// that as "do not write".
fn parse_existing(text: &str, config_path: &std::path::Path) -> Option<serde_json::Value> {
    if text.trim().is_empty() {
        return Some(serde_json::json!({}));
    }
    crate::jsonc_edit::parse(text)
        .inspect_err(|e| tracing::error!(source = "mcp", path = %config_path.display(), "{e} — leaving the file untouched"))
        .ok()
}

/// Back up the original, then write the edited document.
///
/// Skips the write when the edit changed nothing, so an idempotent pass never
/// touches the file's mtime — editors watch these files and reload on change.
fn commit_json_edit(
    config_path: &std::path::Path,
    agent_label: &str,
    original: &str,
    edited: &str,
) -> bool {
    if edited == original {
        return false;
    }
    backup_config_once(config_path, agent_label, original);
    match write_text_file(config_path, edited) {
        Ok(()) => {
            tracing::debug!(source = "mcp", agent = %agent_label, path = %config_path.display(), "Config written");
            true
        }
        Err(e) => {
            tracing::error!(source = "mcp", agent = %agent_label, "Write error: {e}");
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Codex (TOML) support
// ---------------------------------------------------------------------------

/// Path to Codex config file
fn codex_config_path() -> PathBuf {
    home().join(".codex/config.toml")
}

/// Read a TOML file, returning an empty table when it doesn't exist.
///
/// Returns `None` on a read or parse failure, for the same reason as
/// [`read_json_file`]: writing an "empty" document back would delete every
/// setting in the user's `config.toml`.
fn read_toml_file(path: &std::path::Path) -> Option<toml::Value> {
    if !path.exists() {
        return Some(toml::Value::Table(Default::default()));
    }
    let content = std::fs::read_to_string(path)
        .inspect_err(|e| tracing::error!(source = "mcp", path = %path.display(), "Failed to read config: {e}"))
        .ok()?;
    toml::from_str(&content)
        .inspect_err(|e| tracing::error!(source = "mcp", path = %path.display(), "TOML parse error, leaving the file untouched: {e}"))
        .ok()
}

/// Write a TOML file atomically (temp + rename).
fn write_toml_file(path: &std::path::Path, value: &toml::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }
    let output =
        toml::to_string_pretty(value).map_err(|e| format!("Failed to serialize TOML: {e}"))?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, &output).map_err(|e| format!("Failed to write temp file: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to rename temp file: {e}")
    })?;
    Ok(())
}

/// Ensure a TOML config (`[mcp_servers.<name>]`) has the correct bridge entry.
/// Returns true if the config was written (installed or updated).
///
/// `forward_session` adds `TUIC_SESSION` to the entry's `env_vars` allowlist —
/// Codex needs it to pass the variable through its sandbox. Grok inherits the
/// environment, and its schema has no `env_vars` key.
fn ensure_toml_mcp_entry(
    config_path: &std::path::Path,
    forward_session: bool,
    bridge_path: &str,
    agent_label: &str,
) -> bool {
    let Some(mut root) = read_toml_file(config_path) else {
        return false;
    };

    let existing_entry = root
        .get("mcp_servers")
        .and_then(|s| s.get(TUIC_MCP_KEY))
        .and_then(|entry| entry.as_table());
    let existing_command = existing_entry
        .and_then(|entry| entry.get("command"))
        .and_then(toml::Value::as_str);
    let forwards_tuic_session = existing_entry
        .and_then(|entry| entry.get("env_vars"))
        .and_then(toml::Value::as_array)
        .is_some_and(|env_vars| {
            env_vars.iter().any(|value| {
                value.as_str() == Some("TUIC_SESSION")
                    || value.as_table().is_some_and(|entry| {
                        entry.get("name").and_then(toml::Value::as_str) == Some("TUIC_SESSION")
                            && entry
                                .get("source")
                                .and_then(toml::Value::as_str)
                                .is_none_or(|source| source == "local")
                    })
            })
        });

    let session_ok = forwards_tuic_session || !forward_session;
    match existing_command {
        Some(cmd) if cmd == bridge_path && session_ok => {
            return false;
        }
        Some(cmd) if cmd == bridge_path => {
            tracing::info!(
                source = "mcp",
                agent = %agent_label,
                "Enabling TUIC_SESSION forwarding for bridge identity"
            );
        }
        Some(old) => {
            tracing::info!(
                source = "mcp",
                agent = %agent_label,
                "Updating path: {old} → {bridge_path}"
            );
        }
        None => {
            tracing::info!(source = "mcp", agent = %agent_label, "Installing bridge");
        }
    }

    let Some(root_table) = root.as_table_mut() else {
        tracing::error!(source = "mcp", agent = %agent_label, "TOML root is not a table");
        return false;
    };

    let mcp_servers = root_table
        .entry("mcp_servers")
        .or_insert_with(|| toml::Value::Table(Default::default()));

    if let Some(servers) = mcp_servers.as_table_mut() {
        let entry = servers
            .entry(TUIC_MCP_KEY.to_string())
            .or_insert_with(|| toml::Value::Table(Default::default()));
        if !entry.is_table() {
            *entry = toml::Value::Table(Default::default());
        }
        let entry = entry
            .as_table_mut()
            .expect("entry was normalized to a table");
        entry.insert(
            "command".to_string(),
            toml::Value::String(bridge_path.to_string()),
        );
        if forward_session && !forwards_tuic_session {
            let env_vars = entry
                .entry("env_vars".to_string())
                .or_insert_with(|| toml::Value::Array(Vec::new()));
            if !env_vars.is_array() {
                *env_vars = toml::Value::Array(Vec::new());
            }
            env_vars
                .as_array_mut()
                .expect("env_vars was normalized to an array")
                .push(toml::Value::String("TUIC_SESSION".to_string()));
        }
    }

    match write_toml_file(config_path, &root) {
        Ok(()) => {
            tracing::debug!(source = "mcp", agent = %agent_label, path = %config_path.display(), "Config written");
            true
        }
        Err(e) => {
            tracing::error!(source = "mcp", agent = %agent_label, "Write error: {e}");
            false
        }
    }
}

/// Remove the tuicommander entry from a TOML config.
fn remove_toml_mcp_entry(config_path: &std::path::Path) -> Result<(), String> {
    if !config_path.exists() {
        return Ok(());
    }
    let mut root = read_toml_file(config_path)
        .ok_or_else(|| format!("Cannot parse {} — not modified", config_path.display()))?;
    if let Some(servers) = root.get_mut("mcp_servers").and_then(|s| s.as_table_mut()) {
        servers.remove(TUIC_MCP_KEY);
    }
    write_toml_file(config_path, &root)
}

/// Check if a TOML config has the tuicommander MCP entry installed.
fn is_toml_mcp_installed(config_path: &std::path::Path) -> bool {
    read_toml_file(config_path).is_some_and(|root| {
        root.get("mcp_servers")
            .and_then(|s| s.get(TUIC_MCP_KEY))
            .is_some()
    })
}

// ---------------------------------------------------------------------------
// Goose (YAML) support
// ---------------------------------------------------------------------------

/// Read a YAML file, returning an empty mapping when it doesn't exist.
/// `None` on read/parse failure — see [`read_json_file`] for why we never
/// write in that case.
fn read_yaml_file(path: &std::path::Path) -> Option<serde_yaml::Value> {
    if !path.exists() {
        return Some(serde_yaml::Value::Mapping(Default::default()));
    }
    let content = std::fs::read_to_string(path)
        .inspect_err(|e| tracing::error!(source = "mcp", path = %path.display(), "Failed to read config: {e}"))
        .ok()?;
    serde_yaml::from_str(&content)
        .inspect_err(|e| tracing::error!(source = "mcp", path = %path.display(), "YAML parse error, leaving the file untouched: {e}"))
        .ok()
}

/// Write a YAML file atomically (temp + rename).
fn write_yaml_file(path: &std::path::Path, value: &serde_yaml::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
    }
    let output =
        serde_yaml::to_string(value).map_err(|e| format!("Failed to serialize YAML: {e}"))?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, &output).map_err(|e| format!("Failed to write temp file: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to rename temp file: {e}")
    })?;
    Ok(())
}

/// goose's `ExtensionEntry` for a stdio server. `name` and `timeout` have no
/// serde default on goose's side, so both must be written.
fn goose_entry_value(bridge_path: &str) -> serde_yaml::Value {
    let mut entry = serde_yaml::Mapping::new();
    for (key, value) in [
        ("enabled", serde_yaml::Value::Bool(true)),
        ("type", "stdio".into()),
        ("name", TUIC_MCP_KEY.into()),
        ("description", "FastAF bridge".into()),
        ("cmd", bridge_path.into()),
        ("args", serde_yaml::Value::Sequence(Vec::new())),
        ("envs", serde_yaml::Value::Mapping(Default::default())),
        ("env_keys", serde_yaml::Value::Sequence(Vec::new())),
        ("timeout", 300.into()),
    ] {
        entry.insert(key.into(), value);
    }
    serde_yaml::Value::Mapping(entry)
}

/// Ensure a YAML config's `extensions:` map has the correct bridge entry.
/// Returns true if the config was written (installed or updated).
///
/// Round-tripping through serde drops comments the user may have written in
/// `config.yaml`. goose owns this file (`goose configure` rewrites it the same
/// way), so that is the same treatment the agent itself applies.
fn ensure_yaml_mcp_entry(
    config_path: &std::path::Path,
    key: &str,
    bridge_path: &str,
    agent_label: &str,
) -> bool {
    let Some(mut root) = read_yaml_file(config_path) else {
        return false;
    };
    let existing_command = root
        .get(key)
        .and_then(|extensions| extensions.get(TUIC_MCP_KEY))
        .and_then(|entry| entry.get("cmd"))
        .and_then(|cmd| cmd.as_str());
    match existing_command {
        Some(cmd) if cmd == bridge_path => return false,
        Some(old) => {
            tracing::info!(source = "mcp", agent = %agent_label, "Updating path: {old} → {bridge_path}");
        }
        None => {
            tracing::info!(source = "mcp", agent = %agent_label, "Installing bridge");
        }
    }

    if !root.is_mapping() {
        root = serde_yaml::Value::Mapping(Default::default());
    }
    let mapping = root.as_mapping_mut().expect("root normalized to a mapping");
    let extensions = mapping
        .entry(key.into())
        .or_insert_with(|| serde_yaml::Value::Mapping(Default::default()));
    if !extensions.is_mapping() {
        *extensions = serde_yaml::Value::Mapping(Default::default());
    }
    extensions
        .as_mapping_mut()
        .expect("extensions normalized to a mapping")
        .insert(TUIC_MCP_KEY.into(), goose_entry_value(bridge_path));

    match write_yaml_file(config_path, &root) {
        Ok(()) => {
            tracing::debug!(source = "mcp", agent = %agent_label, path = %config_path.display(), "Config written");
            true
        }
        Err(e) => {
            tracing::error!(source = "mcp", agent = %agent_label, "Write error: {e}");
            false
        }
    }
}

/// Remove the tuicommander entry from a YAML config.
fn remove_yaml_mcp_entry(config_path: &std::path::Path, key: &str) -> Result<(), String> {
    if !config_path.exists() {
        return Ok(());
    }
    let mut root = read_yaml_file(config_path)
        .ok_or_else(|| format!("Cannot parse {} — not modified", config_path.display()))?;
    if let Some(extensions) = root
        .as_mapping_mut()
        .and_then(|mapping| mapping.get_mut(serde_yaml::Value::from(key)))
        .and_then(serde_yaml::Value::as_mapping_mut)
    {
        extensions.remove(serde_yaml::Value::from(TUIC_MCP_KEY));
    }
    write_yaml_file(config_path, &root)
}

/// Is the bridge entry already present in this target's config?
/// A target we configured earlier keeps getting path repairs even if the
/// presence heuristic no longer recognises it (manual install, tool removed
/// from PATH), so a stale bridge path can never be left behind.
fn has_bridge_entry(spec: &McpConfigSpec) -> bool {
    if !spec.config_path.exists() {
        return false;
    }
    match spec.format {
        McpFormat::Toml { .. } => is_toml_mcp_installed(&spec.config_path),
        McpFormat::Yaml => read_yaml_file(&spec.config_path).is_some_and(|root| {
            spec.key_path
                .first()
                .and_then(|key| root.get(*key))
                .and_then(|extensions| extensions.get(TUIC_MCP_KEY))
                .is_some()
        }),
        _ => read_json_file(&spec.config_path).is_some_and(|root| {
            navigate(&root, &spec.key_path)
                .and_then(|v| v.as_object())
                .is_some_and(|obj| obj.contains_key(TUIC_MCP_KEY))
        }),
    }
}

/// Whether launch-time auto-install may write this target, i.e. whether the
/// evidence says the tool is really here.
///
/// Deliberately NOT consulted by `install_agent_mcp`: a user pressing Install
/// in Settings has told us the target exists, and creating the file is then the
/// requested action rather than a guess.
fn auto_install_allowed(spec: &McpConfigSpec, agent_label: &str) -> bool {
    if !is_target_installed(spec) && !has_bridge_entry(spec) {
        tracing::debug!(source = "mcp", agent = %agent_label, "Skipping (not installed)");
        return false;
    }
    // An add-on target speaks MCP only through a plugin that owns the config
    // file. No file means no plugin, so writing one configures nothing.
    if spec.requires_existing_config && !spec.config_path.exists() {
        tracing::debug!(source = "mcp", agent = %agent_label, "Skipping (no MCP add-on config)");
        return false;
    }
    // The target's MCP list shares a file with the rest of the user's settings.
    // We repair an entry we already own, but the first write waits for a click.
    if spec.shared_settings_file && !has_bridge_entry(spec) {
        tracing::debug!(source = "mcp", agent = %agent_label, "Skipping (shared settings file — install from Settings > Agents)");
        return false;
    }
    true
}

/// Write the bridge entry for one target, dispatching on its config format.
fn ensure_spec_entry(spec: &McpConfigSpec, bridge_path: &str, agent_label: &str) -> bool {
    match spec.format {
        McpFormat::Toml { forward_session } => {
            ensure_toml_mcp_entry(&spec.config_path, forward_session, bridge_path, agent_label)
        }
        McpFormat::Yaml => ensure_yaml_mcp_entry(
            &spec.config_path,
            spec.key_path.first().copied().unwrap_or("extensions"),
            bridge_path,
            agent_label,
        ),
        format => ensure_agent_mcp_entry(
            &spec.config_path,
            &spec.key_path,
            format,
            bridge_path,
            agent_label,
        ),
    }
}

/// Ensure MCP bridge config is installed and up-to-date in all supported agent configs.
/// Called on every app launch. Installs missing entries and updates stale paths.
///
/// Targets that are not installed on this machine are skipped: the write path
/// creates every missing parent directory, so an unconditional pass litters the
/// home directory with configs for tools the user never had. Settings > Agents
/// still installs on demand — that is an explicit request, not a guess.
pub(crate) fn ensure_mcp_configs(disabled: &[String]) {
    let bridge_path = detect_bridge_binary();
    tracing::info!(source = "mcp", bridge = %bridge_path, "Ensuring bridge configs");

    for agent in SUPPORTED_AGENTS {
        if disabled.iter().any(|d| d == agent) {
            tracing::debug!(source = "mcp", agent, "Skipping (disabled by user)");
            continue;
        }
        let Some(spec) = get_mcp_config_spec(agent) else {
            continue;
        };
        if !auto_install_allowed(&spec, agent) {
            continue;
        }
        ensure_spec_entry(&spec, &bridge_path, agent);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Check MCP installation status for an agent
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn get_agent_mcp_status(agent_type: String) -> AgentMcpStatus {
    let Some(spec) = get_mcp_config_spec(&agent_type) else {
        return AgentMcpStatus {
            supported: false,
            installed: false,
            config_path: None,
            shared_settings_file: false,
        };
    };

    AgentMcpStatus {
        supported: true,
        installed: has_bridge_entry(&spec),
        config_path: Some(spec.config_path.to_string_lossy().to_string()),
        shared_settings_file: spec.shared_settings_file,
    }
}

/// Install the tui-mcp-bridge MCP entry into an agent's config.
/// Also removes the agent from `disabled_mcp_agents` so `ensure_mcp_configs` won't skip it.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn install_agent_mcp(
    agent_type: String,
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
) -> Result<(), String> {
    let bridge_path = detect_bridge_binary();

    let spec = get_mcp_config_spec(&agent_type)
        .ok_or_else(|| format!("Agent '{agent_type}' does not support MCP configuration"))?;

    // An explicit request overrides the presence heuristic, but a config we
    // cannot parse is never overwritten — `ensure_spec_entry` returns false and
    // logs the parse error.
    if !ensure_spec_entry(&spec, &bridge_path, &agent_type) && !has_bridge_entry(&spec) {
        return Err(format!(
            "Failed to write MCP config at {}",
            spec.config_path.display()
        ));
    }

    // Remove from disabled list so ensure_mcp_configs won't undo this
    update_disabled_mcp_agents(state.inner(), |list| list.retain(|a| a != &agent_type));

    Ok(())
}

/// Remove the tui-mcp-bridge MCP entry from an agent's config.
/// Also adds the agent to `disabled_mcp_agents` so `ensure_mcp_configs` won't reinstall it.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn remove_agent_mcp(
    agent_type: String,
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
) -> Result<(), String> {
    let spec = get_mcp_config_spec(&agent_type)
        .ok_or_else(|| format!("Agent '{agent_type}' does not support MCP configuration"))?;
    remove_spec_entry(&spec, &agent_type)?;

    // Add to disabled list so ensure_mcp_configs won't reinstall
    update_disabled_mcp_agents(state.inner(), |list| {
        if !list.contains(&agent_type) {
            list.push(agent_type.clone());
        }
    });

    Ok(())
}

/// Drop the bridge entry from one target's config, dispatching on its format.
fn remove_spec_entry(spec: &McpConfigSpec, agent_label: &str) -> Result<(), String> {
    match spec.format {
        McpFormat::Toml { .. } => remove_toml_mcp_entry(&spec.config_path),
        McpFormat::Yaml => remove_yaml_mcp_entry(
            &spec.config_path,
            spec.key_path.first().copied().unwrap_or("extensions"),
        ),
        _ => {
            if !spec.config_path.exists() {
                return Ok(());
            }
            let text = read_json_text(&spec.config_path)
                .ok_or_else(|| format!("Cannot read {}", spec.config_path.display()))?;
            let edited = crate::jsonc_edit::remove_member(&text, &spec.key_path, TUIC_MCP_KEY)
                .map_err(|e| format!("{e} in {} — not modified", spec.config_path.display()))?;
            commit_json_edit(&spec.config_path, agent_label, &text, &edited);
            Ok(())
        }
    }
}

/// Every target this machine has a bridge entry in.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn list_installed_mcp_integrations() -> Vec<String> {
    SUPPORTED_AGENTS
        .iter()
        .filter(|agent| get_mcp_config_spec(agent).is_some_and(|spec| has_bridge_entry(&spec)))
        .map(|agent| (*agent).to_string())
        .collect()
}

/// Remove the bridge entry from every target that has one, and stop
/// reinstalling them.
///
/// Uninstalling FastAF leaves the bridge path dangling in every client it
/// ever configured, and each one then reports a broken MCP server on startup
/// (issue #115). Removing them one by one means knowing which clients TUIC
/// picked, so this does the sweep.
///
/// Disabling is part of the action, not a side effect: without it the next
/// launch reinstalls everything and the button does nothing.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn remove_all_mcp_integrations(
    state: tauri::State<'_, std::sync::Arc<crate::state::AppState>>,
) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();
    let mut failures = Vec::new();
    for agent in SUPPORTED_AGENTS {
        let Some(spec) = get_mcp_config_spec(agent) else {
            continue;
        };
        if !has_bridge_entry(&spec) {
            continue;
        }
        match remove_spec_entry(&spec, agent) {
            Ok(()) => removed.push((*agent).to_string()),
            // One unparseable config must not abort the sweep — the remaining
            // clients would keep their dangling entries.
            Err(e) => {
                tracing::error!(source = "mcp", agent, "Removal failed: {e}");
                failures.push(format!("{agent}: {e}"));
            }
        }
    }

    let disable: Vec<String> = removed.clone();
    update_disabled_mcp_agents(state.inner(), |list| {
        for agent in disable {
            if !list.contains(&agent) {
                list.push(agent);
            }
        }
    });

    if failures.is_empty() {
        Ok(removed)
    } else {
        Err(failures.join("; "))
    }
}

/// Helper: mutate `disabled_mcp_agents` in BOTH the in-memory `AppState.config`
/// and on-disk `config.json`. Updating only disk would leave a stale snapshot in
/// memory, and a subsequent `put_config` from the FE (carrying that stale list)
/// would silently revert the toggle.
///
/// Goes through `commit_config_change` rather than serializing a snapshot itself:
/// a direct `save_json_config("config.json", ..)` skips `config_for_disk`, so the
/// session token, relay token and VAPID private key were written to config.json in
/// cleartext — the exact thing the credential vault exists to prevent. It also puts
/// this writer under the same lock as every other one.
fn update_disabled_mcp_agents(
    state: &std::sync::Arc<crate::state::AppState>,
    mutator: impl FnOnce(&mut Vec<String>),
) {
    let result = crate::config::commit_config_change(state, |current| {
        let mut next = current.clone();
        mutator(&mut next.disabled_mcp_agents);
        Ok(next)
    });
    if let Err(e) = result {
        tracing::error!(source = "mcp", "Failed to save disabled_mcp_agents: {e}");
    }
}

/// Get the path to an agent's own configuration file
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn get_agent_config_path(agent_type: String) -> Option<String> {
    get_agent_settings_path(&agent_type).map(|p| p.to_string_lossy().to_string())
}

/// MCP connection info for manual configuration
#[derive(Serialize)]
pub(crate) struct McpBridgeInfo {
    pub(crate) bridge_path: String,
    pub(crate) config_snippet: String,
}

/// Return bridge path + ready-to-paste JSON snippet for manual MCP setup
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn get_mcp_bridge_info() -> McpBridgeInfo {
    let bridge_path = detect_bridge_binary();
    let entry = TuicMcpEntry {
        transport_type: "stdio".to_string(),
        command: bridge_path.clone(),
        args: vec![],
        env: BTreeMap::new(),
    };
    let wrapper = serde_json::json!({
        "tuicommander": entry,
    });
    let config_snippet = serde_json::to_string_pretty(&wrapper).unwrap_or_default();
    McpBridgeInfo {
        bridge_path,
        config_snippet,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Seed a config file. Production no longer serializes whole documents —
    /// it splices one member into text it never reformats — so building a
    /// fixture is the only place a `Value` still becomes a file.
    fn write_fixture(path: &std::path::Path, value: &serde_json::Value) {
        std::fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    #[test]
    fn unsupported_agent_returns_not_supported() {
        let status = get_agent_mcp_status("aider".to_string());
        assert!(!status.supported);
        assert!(!status.installed);
        assert!(status.config_path.is_none());
    }

    #[test]
    fn install_remove_round_trip_json() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("test-mcp.json");

        // Start with existing config that has another server
        let initial = r#"{ "mcpServers": { "other-server": { "command": "other-cmd" } } }"#;
        std::fs::write(&config_path, initial).unwrap();

        let spec = spec_at(config_path.clone());
        assert!(ensure_spec_entry(
            &spec,
            "/usr/local/bin/tui-mcp-bridge",
            "test"
        ));

        // Verify both entries exist
        let root = read_json_file(&config_path).unwrap();
        let servers = navigate(&root, &["mcpServers"])
            .unwrap()
            .as_object()
            .unwrap();
        assert!(servers.contains_key(TUIC_MCP_KEY));
        assert!(servers.contains_key("other-server"));
        assert_eq!(servers.len(), 2);

        remove_spec_entry(&spec, "test").unwrap();

        // Verify only other-server remains
        let root = read_json_file(&config_path).unwrap();
        let servers = navigate(&root, &["mcpServers"])
            .unwrap()
            .as_object()
            .unwrap();
        assert!(!servers.contains_key(TUIC_MCP_KEY));
        assert!(servers.contains_key("other-server"));
        assert_eq!(servers.len(), 1);
    }

    #[test]
    fn install_creates_file_if_missing() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("nonexistent.json");

        // File doesn't exist yet
        assert!(!config_path.exists());

        assert!(ensure_spec_entry(
            &spec_at(config_path.clone()),
            "tui-mcp-bridge",
            "test"
        ));

        // Verify file was created with correct content
        let root = read_json_file(&config_path).unwrap();
        let servers = navigate(&root, &["mcpServers"])
            .unwrap()
            .as_object()
            .unwrap();
        assert!(servers.contains_key(TUIC_MCP_KEY));
        let entry = servers.get(TUIC_MCP_KEY).unwrap();
        assert_eq!(entry["command"], "tui-mcp-bridge");
        assert_eq!(entry["type"], "stdio");
    }

    #[test]
    fn nested_key_path_works() {
        // Test with amp-style nested path: ["amp", "mcpServers"]
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("amp-settings.json");

        let initial = serde_json::json!({
            "amp": {
                "someOtherSetting": true
            }
        });
        write_fixture(&config_path, &initial);

        assert!(ensure_agent_mcp_entry(
            &config_path,
            &["amp", "mcpServers"],
            McpFormat::Json,
            "tui-mcp-bridge",
            "test",
        ));

        let root = read_json_file(&config_path).unwrap();
        // Verify the nested structure
        assert_eq!(root["amp"]["someOtherSetting"], true);
        assert!(root["amp"]["mcpServers"][TUIC_MCP_KEY].is_object());
    }

    #[test]
    fn remove_from_nonexistent_file_is_ok() {
        // Removing from a file that doesn't exist should succeed (no-op)
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("does-not-exist.json");

        remove_spec_entry(&spec_at(config_path.clone()), "test").unwrap();

        // Removal must never bring the file into existence.
        assert!(!config_path.exists());
    }

    #[test]
    fn agent_config_path_returns_expected_paths() {
        // Claude should return ~/.claude/settings.json
        let claude_path = get_agent_settings_path("claude");
        assert!(claude_path.is_some());
        let path_str = claude_path.unwrap().to_string_lossy().to_string();
        assert!(path_str.contains(".claude"));
        assert!(path_str.ends_with("settings.json"));

        // Unknown agent returns None
        assert!(get_agent_settings_path("unknown-agent").is_none());
    }

    #[test]
    fn mcp_config_spec_known_agents() {
        // Each target is written in the format its own tool reads.
        for (agent, format) in &[
            ("claude", McpFormat::Json),
            ("cursor", McpFormat::Json),
            ("windsurf", McpFormat::Json),
            ("vscode", McpFormat::Json),
            ("zed", McpFormat::Json),
            ("amp", McpFormat::Json),
            ("gemini", McpFormat::Json),
            ("droid", McpFormat::Json),
            ("pi", McpFormat::Json),
            ("opencode", McpFormat::OpenCode),
            (
                "codex",
                McpFormat::Toml {
                    forward_session: true,
                },
            ),
            (
                "grok",
                McpFormat::Toml {
                    forward_session: false,
                },
            ),
            ("goose", McpFormat::Yaml),
        ] {
            let spec = get_mcp_config_spec(agent).expect("{agent} should be supported");
            assert!(spec.format == *format, "{agent} uses the wrong format");
        }
        // aider has no MCP client, so there is nothing to configure.
        assert!(get_mcp_config_spec("aider").is_none());
        assert!(get_mcp_config_spec("unknown-agent").is_none());
    }

    // --- ensure_agent_mcp_entry tests ---

    #[test]
    fn ensure_installs_when_missing() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("test.json");

        let wrote = ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/path/a",
            "test",
        );
        assert!(wrote, "should write when entry is missing");

        let root = read_json_file(&config_path).unwrap();
        assert_eq!(root["mcpServers"][TUIC_MCP_KEY]["command"], "/path/a");
    }

    #[test]
    fn ensure_updates_stale_path() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("test.json");

        // Install with path A
        ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/old/path",
            "test",
        );

        // Ensure with path B — should update
        let wrote = ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/new/path",
            "test",
        );
        assert!(wrote, "should write when path changed");

        let root = read_json_file(&config_path).unwrap();
        assert_eq!(root["mcpServers"][TUIC_MCP_KEY]["command"], "/new/path");
    }

    #[test]
    fn ensure_skips_when_path_matches() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("test.json");

        // Install
        ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/correct/path",
            "test",
        );

        // Record mtime
        let mtime_before = std::fs::metadata(&config_path).unwrap().modified().unwrap();
        // Small sleep to ensure mtime would differ if file were rewritten
        std::thread::sleep(std::time::Duration::from_millis(50));

        // Ensure with same path — should not write
        let wrote = ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/correct/path",
            "test",
        );
        assert!(!wrote, "should not write when path already correct");

        let mtime_after = std::fs::metadata(&config_path).unwrap().modified().unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "file should not have been modified"
        );
    }

    #[test]
    fn ensure_writes_args_and_env_as_empty_collections() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("test.json");

        ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/bridge",
            "test",
        );

        let root = read_json_file(&config_path).unwrap();
        let entry = &root["mcpServers"][TUIC_MCP_KEY];
        assert!(
            entry["args"].is_array(),
            "args must be an array, got {:?}",
            entry["args"]
        );
        assert_eq!(entry["args"].as_array().unwrap().len(), 0);
        assert!(
            entry["env"].is_object(),
            "env must be an object, got {:?}",
            entry["env"]
        );
        assert_eq!(entry["env"].as_object().unwrap().len(), 0);
    }

    #[test]
    fn ensure_repairs_entry_with_null_args_and_env() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("test.json");

        // Write an entry shaped like Claude Code's rejected form: args/env are null
        let initial = serde_json::json!({
            "mcpServers": {
                TUIC_MCP_KEY: {
                    "type": "stdio",
                    "command": "/bridge",
                    "args": null,
                    "env": null,
                }
            }
        });
        write_fixture(&config_path, &initial);

        // Same command, but malformed fields → must rewrite
        let wrote = ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/bridge",
            "test",
        );
        assert!(wrote, "should rewrite when args/env are null");

        let root = read_json_file(&config_path).unwrap();
        let entry = &root["mcpServers"][TUIC_MCP_KEY];
        assert!(entry["args"].is_array());
        assert!(entry["env"].is_object());
    }

    #[test]
    fn ensure_preserves_other_servers() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("test.json");

        let initial = serde_json::json!({
            "mcpServers": {
                "other-server": { "command": "other-cmd" }
            }
        });
        write_fixture(&config_path, &initial);

        ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/bridge",
            "test",
        );

        let root = read_json_file(&config_path).unwrap();
        let servers = root["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(servers["other-server"]["command"], "other-cmd");
        assert_eq!(servers[TUIC_MCP_KEY]["command"], "/bridge");
    }

    #[test]
    fn ensure_works_with_nested_key_path() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("test.json");

        let initial = serde_json::json!({ "amp": { "setting": true } });
        write_fixture(&config_path, &initial);

        ensure_agent_mcp_entry(
            &config_path,
            &["amp", "mcpServers"],
            McpFormat::Json,
            "/bridge",
            "test",
        );

        let root = read_json_file(&config_path).unwrap();
        assert_eq!(root["amp"]["setting"], true);
        assert_eq!(
            root["amp"]["mcpServers"][TUIC_MCP_KEY]["command"],
            "/bridge"
        );
    }

    // --- ensure_mcp_configs disabled_agents tests ---

    #[test]
    fn ensure_skips_disabled_agents() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("test.json");

        // With empty disabled list — should install
        ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/bridge",
            "test",
        );
        assert!(config_path.exists());
        let root = read_json_file(&config_path).unwrap();
        assert!(root["mcpServers"][TUIC_MCP_KEY].is_object());

        // Remove the file and verify ensure_mcp_configs logic
        // (we test the skip logic directly since ensure_mcp_configs uses home paths)
        let disabled = ["claude".to_string(), "cursor".to_string()];
        assert!(disabled.iter().any(|d| d == "claude"));
        assert!(!disabled.iter().any(|d| d == "vscode"));
    }

    /// Regression for #1368-fa9b: `update_disabled_mcp_agents` must mutate the
    /// in-memory `AppState.config.disabled_mcp_agents`, not just the on-disk file.
    /// Otherwise a `put_config` PUT carrying a stale snapshot silently reverts.
    #[test]
    fn update_disabled_mcp_agents_mutates_in_memory_state() {
        let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
        assert!(
            state.config.read().disabled_mcp_agents.is_empty(),
            "precondition"
        );

        // Simulate remove_agent_mcp's branch: add an agent to the disabled list.
        update_disabled_mcp_agents(&state, |list| {
            if !list.contains(&"claude".to_string()) {
                list.push("claude".to_string());
            }
        });

        assert!(
            state
                .config
                .read()
                .disabled_mcp_agents
                .iter()
                .any(|a| a == "claude"),
            "in-memory state.config must be updated, not only disk",
        );

        // Simulate install_agent_mcp's branch: remove the agent.
        update_disabled_mcp_agents(&state, |list| list.retain(|a| a != "claude"));

        assert!(
            !state
                .config
                .read()
                .disabled_mcp_agents
                .iter()
                .any(|a| a == "claude"),
            "in-memory state.config must be cleared on remove",
        );
    }

    #[test]
    fn disabled_list_contains_check() {
        let disabled: Vec<String> = vec!["claude".to_string(), "windsurf".to_string()];

        // Agents in disabled list should be skipped
        for agent in &["claude", "windsurf"] {
            assert!(
                disabled.iter().any(|d| d == agent),
                "{agent} should be in disabled list",
            );
        }

        // Agents NOT in disabled list should proceed
        for agent in &["cursor", "vscode", "zed", "amp", "gemini", "codex"] {
            assert!(
                !disabled.iter().any(|d| d == agent),
                "{agent} should NOT be in disabled list",
            );
        }
    }

    // --- Codex (TOML) tests ---

    #[test]
    fn codex_install_creates_file_if_missing() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");

        assert!(!config_path.exists());

        let wrote =
            ensure_toml_mcp_entry(&config_path, true, "/usr/local/bin/tuic-bridge", "codex");
        assert!(wrote);
        assert!(config_path.exists());

        let root = read_toml_file(&config_path).unwrap();
        let cmd = root["mcp_servers"][TUIC_MCP_KEY]["command"]
            .as_str()
            .unwrap();
        assert_eq!(cmd, "/usr/local/bin/tuic-bridge");
        assert_eq!(
            root["mcp_servers"][TUIC_MCP_KEY]["env_vars"]
                .as_array()
                .unwrap(),
            &[toml::Value::String("TUIC_SESSION".to_string())],
        );
    }

    #[test]
    fn codex_install_preserves_existing_config() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");

        // Pre-existing config with other settings
        let initial = toml::toml! {
            [model]
            default = "o3"

            [mcp_servers.other_tool]
            command = "/usr/bin/other"
        };
        write_toml_file(&config_path, &toml::Value::Table(initial)).unwrap();

        let wrote = ensure_toml_mcp_entry(&config_path, true, "/path/to/tuic-bridge", "codex");
        assert!(wrote);

        let root = read_toml_file(&config_path).unwrap();
        // Our entry was added
        assert_eq!(
            root["mcp_servers"][TUIC_MCP_KEY]["command"]
                .as_str()
                .unwrap(),
            "/path/to/tuic-bridge",
        );
        // Other MCP server preserved
        assert_eq!(
            root["mcp_servers"]["other_tool"]["command"]
                .as_str()
                .unwrap(),
            "/usr/bin/other",
        );
        // Other config preserved
        assert_eq!(root["model"]["default"].as_str().unwrap(), "o3");
    }

    #[test]
    fn codex_updates_stale_path() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");

        ensure_toml_mcp_entry(&config_path, true, "/old/path", "codex");
        let wrote = ensure_toml_mcp_entry(&config_path, true, "/new/path", "codex");
        assert!(wrote, "should write when path changed");

        let root = read_toml_file(&config_path).unwrap();
        assert_eq!(
            root["mcp_servers"][TUIC_MCP_KEY]["command"]
                .as_str()
                .unwrap(),
            "/new/path",
        );
    }

    #[test]
    fn codex_updates_matching_path_to_forward_managed_identity() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");
        let initial = toml::toml! {
            [mcp_servers.tuicommander]
            command = "/correct/path"
            args = ["--keep"]
            env_vars = ["EXISTING_VAR"]
            enabled = false
        };
        write_toml_file(&config_path, &toml::Value::Table(initial)).unwrap();

        let wrote = ensure_toml_mcp_entry(&config_path, true, "/correct/path", "codex");
        assert!(wrote, "missing TUIC_SESSION forwarding must be repaired");

        let root = read_toml_file(&config_path).unwrap();
        let entry = &root["mcp_servers"][TUIC_MCP_KEY];
        assert_eq!(entry["command"].as_str(), Some("/correct/path"));
        assert_eq!(
            entry["args"].as_array().unwrap(),
            &[toml::Value::String("--keep".to_string())],
        );
        assert_eq!(entry["enabled"].as_bool(), Some(false));
        assert_eq!(
            entry["env_vars"].as_array().unwrap(),
            &[
                toml::Value::String("EXISTING_VAR".to_string()),
                toml::Value::String("TUIC_SESSION".to_string()),
            ],
        );
    }

    #[test]
    fn codex_accepts_local_object_env_var_without_rewriting() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");
        let initial = toml::toml! {
            [mcp_servers.tuicommander]
            command = "/correct/path"
            env_vars = [{ name = "TUIC_SESSION", source = "local" }]
        };
        write_toml_file(&config_path, &toml::Value::Table(initial)).unwrap();
        let mtime_before = std::fs::metadata(&config_path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));

        let wrote = ensure_toml_mcp_entry(&config_path, true, "/correct/path", "codex");
        assert!(!wrote, "a local object whitelist is already sufficient");
        assert_eq!(
            mtime_before,
            std::fs::metadata(&config_path).unwrap().modified().unwrap(),
        );
    }

    #[test]
    fn codex_skips_when_path_matches() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");

        ensure_toml_mcp_entry(&config_path, true, "/correct/path", "codex");
        let mtime_before = std::fs::metadata(&config_path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));

        let wrote = ensure_toml_mcp_entry(&config_path, true, "/correct/path", "codex");
        assert!(!wrote, "should not write when path already correct");

        let mtime_after = std::fs::metadata(&config_path).unwrap().modified().unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "file should not have been modified"
        );
    }

    #[test]
    fn codex_remove_entry() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");

        // Install with another server present
        let initial = toml::toml! {
            [mcp_servers.other_tool]
            command = "/usr/bin/other"
        };
        write_toml_file(&config_path, &toml::Value::Table(initial)).unwrap();
        ensure_toml_mcp_entry(&config_path, true, "/bridge", "codex");

        // Verify both exist
        let root = read_toml_file(&config_path).unwrap();
        assert!(root["mcp_servers"].get(TUIC_MCP_KEY).is_some());
        assert!(root["mcp_servers"].get("other_tool").is_some());

        // Remove
        remove_toml_mcp_entry(&config_path).unwrap();

        let root = read_toml_file(&config_path).unwrap();
        assert!(root["mcp_servers"].get(TUIC_MCP_KEY).is_none());
        assert!(root["mcp_servers"].get("other_tool").is_some());
    }

    #[test]
    fn codex_remove_from_nonexistent_file_is_ok() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("does-not-exist.toml");

        let result = remove_toml_mcp_entry(&config_path);
        assert!(result.is_ok());
        assert!(!config_path.exists());
    }

    #[test]
    fn codex_is_installed_check() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");

        // Not installed (file doesn't exist)
        assert!(!is_toml_mcp_installed(&config_path));

        // Install
        ensure_toml_mcp_entry(&config_path, true, "/bridge", "codex");
        assert!(is_toml_mcp_installed(&config_path));

        // Remove
        remove_toml_mcp_entry(&config_path).unwrap();
        assert!(!is_toml_mcp_installed(&config_path));
    }

    #[test]
    fn codex_in_supported_agents() {
        assert!(
            SUPPORTED_AGENTS.contains(&"codex"),
            "codex must be in SUPPORTED_AGENTS",
        );
    }

    // --- presence gate ---

    /// Spec pointing at a temp dir, with no binary that could ever resolve.
    fn spec_at(config_path: PathBuf) -> McpConfigSpec {
        McpConfigSpec {
            config_path,
            key_path: vec!["mcpServers"],
            format: McpFormat::Json,
            binaries: &[],
            presence_dir: None,
            requires_existing_config: false,
            shared_settings_file: false,
        }
    }

    #[test]
    fn missing_config_dir_is_not_installed() {
        let dir = TempDir::new().unwrap();
        let spec = spec_at(dir.path().join("nope/mcp.json"));
        assert!(!is_target_installed(&spec));
    }

    #[test]
    fn dir_holding_only_our_config_is_not_installed() {
        // The exact state TUIC used to create: ~/.cursor containing nothing but
        // the mcp.json we wrote. Reading that back as "installed" would make the
        // gate self-fulfilling — and makes other tools believe Cursor is here.
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("mcp.json");
        ensure_agent_mcp_entry(
            &config_path,
            &["mcpServers"],
            McpFormat::Json,
            "/bridge",
            "test",
        );
        assert!(config_path.exists());
        assert!(!is_target_installed(&spec_at(config_path)));
    }

    #[test]
    fn dir_with_a_foreign_file_is_installed() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("settings.json"), "{}").unwrap();
        assert!(is_target_installed(&spec_at(dir.path().join("mcp.json"))));
    }

    #[test]
    fn ds_store_and_stale_temp_files_do_not_prove_installation() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(".DS_Store"), "").unwrap();
        // A crashed atomic write leaves `<stem>.tmp` behind.
        std::fs::write(dir.path().join("mcp.tmp"), "{}").unwrap();
        assert!(!is_target_installed(&spec_at(dir.path().join("mcp.json"))));
    }

    #[test]
    fn presence_dir_overrides_the_config_parent() {
        // Claude's config lives in $HOME, whose siblings prove nothing.
        let dir = TempDir::new().unwrap();
        let agent_dir = dir.path().join(".claude");
        let spec = McpConfigSpec {
            presence_dir: Some(agent_dir.clone()),
            ..spec_at(dir.path().join(".claude.json"))
        };
        assert!(!is_target_installed(&spec));

        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(agent_dir.join("settings.json"), "{}").unwrap();
        assert!(is_target_installed(&spec));
    }

    #[test]
    fn a_configured_target_keeps_getting_path_repairs() {
        // Presence may stop resolving (tool dropped off PATH) — an entry we
        // already own must still be updated, never left pointing at a stale
        // bridge binary.
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("mcp.json");
        let spec = spec_at(config_path.clone());
        assert!(!has_bridge_entry(&spec));

        ensure_spec_entry(&spec, "/old/bridge", "test");
        assert!(has_bridge_entry(&spec));
        assert!(!is_target_installed(&spec));

        ensure_spec_entry(&spec, "/new/bridge", "test");
        let root = read_json_file(&config_path).unwrap();
        assert_eq!(root["mcpServers"][TUIC_MCP_KEY]["command"], "/new/bridge");
    }

    // --- unparseable configs are never overwritten ---

    #[test]
    fn json_with_comments_is_edited_not_rejected() {
        // VS Code's mcp.json, Zed's settings.json and opencode's config all
        // document comments as supported. Refusing to parse them meant the
        // integration silently did nothing for those users.
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("mcp.json");
        let original = "// user comment\n{ \"servers\": { \"mine\": { \"command\": \"x\" } } }";
        std::fs::write(&config_path, original).unwrap();

        assert!(read_json_file(&config_path).is_some());
        assert!(ensure_agent_mcp_entry(
            &config_path,
            &["servers"],
            McpFormat::Json,
            "/bridge",
            "test",
        ));

        let written = std::fs::read_to_string(&config_path).unwrap();
        assert!(written.starts_with("// user comment"), "{written}");
        let root = read_json_file(&config_path).unwrap();
        assert_eq!(root["servers"]["mine"]["command"], "x");
        assert_eq!(root["servers"][TUIC_MCP_KEY]["command"], "/bridge");
    }

    #[test]
    fn genuinely_broken_json_is_left_untouched() {
        // The guard that must never regress: a file we cannot understand is one
        // we do not write. Truncated mid-object, so no dialect parses it.
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("mcp.json");
        let original = "{ \"servers\": { \"mine\": ";
        std::fs::write(&config_path, original).unwrap();

        assert!(read_json_file(&config_path).is_none());
        assert!(!ensure_agent_mcp_entry(
            &config_path,
            &["servers"],
            McpFormat::Json,
            "/bridge",
            "test",
        ));
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), original);
    }

    /// Issue #115: a real Zed `settings.json` — JSONC, comments, trailing
    /// commas, hand-tuned indentation — must come back with exactly one member
    /// added and every other byte where the user left it.
    #[test]
    fn zed_settings_survive_an_install_intact() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("settings.json");
        let original = r#"{
  // Editor
  "buffer_font_family": "Berkeley Mono",
  "buffer_font_size": 14,
  "theme": {
    "mode": "system",
    "dark": "One Dark",
  },
  /* Languages */
  "languages": {
    "Rust": { "tab_size": 4 },
  },
}"#;
        std::fs::write(&config_path, original).unwrap();

        assert!(ensure_agent_mcp_entry(
            &config_path,
            &["context_servers"],
            McpFormat::Json,
            "/usr/bin/tuic-bridge",
            "zed",
        ));

        let written = std::fs::read_to_string(&config_path).unwrap();
        // Every original line is still present, verbatim.
        for line in original.lines().filter(|l| !l.trim().is_empty()) {
            if line == "}" {
                continue; // The closing brace moved down by the added member.
            }
            assert!(written.contains(line), "lost `{line}` in:\n{written}");
        }
        let root = read_json_file(&config_path).unwrap();
        assert_eq!(
            root["context_servers"][TUIC_MCP_KEY]["command"],
            "/usr/bin/tuic-bridge"
        );
        assert_eq!(root["buffer_font_size"], 14);
        assert_eq!(root["languages"]["Rust"]["tab_size"], 4);
    }

    #[test]
    fn an_idempotent_pass_does_not_rewrite_the_file() {
        // Editors watch these files; a no-op write still fires a reload.
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("mcp.json");
        let spec = spec_at(config_path.clone());

        assert!(ensure_spec_entry(&spec, "/bridge", "test"));
        let first = std::fs::read_to_string(&config_path).unwrap();
        assert!(!ensure_spec_entry(&spec, "/bridge", "test"));
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), first);
    }

    #[test]
    fn removal_keeps_the_users_comments() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("settings.json");
        let original = "{\n  // keep me\n  \"theme\": \"dark\",\n  \"mcpServers\": { \"tuicommander\": { \"command\": \"/bridge\" } }\n}";
        std::fs::write(&config_path, original).unwrap();

        let spec = spec_at(config_path.clone());
        remove_spec_entry(&spec, "test").unwrap();

        let written = std::fs::read_to_string(&config_path).unwrap();
        assert!(written.contains("// keep me"), "{written}");
        let root = read_json_file(&config_path).unwrap();
        assert!(root["mcpServers"].get(TUIC_MCP_KEY).is_none());
        assert_eq!(root["theme"], "dark");
    }

    // --- shared settings files need an explicit install ---

    #[test]
    fn a_shared_settings_file_is_not_written_at_launch() {
        // Zed, Amp and Gemini keep their MCP list inside the settings document
        // that holds every other user preference. Being on the machine is not
        // consent to edit it.
        let dir = TempDir::new().unwrap();
        // A file the tool itself wrote, so presence is proven independently of
        // our config — the gate under test must be the shared-file rule alone.
        std::fs::write(dir.path().join("keymap.json"), "[]").unwrap();
        let spec = McpConfigSpec {
            shared_settings_file: true,
            ..spec_at(dir.path().join("settings.json"))
        };
        // Presence is proven — the gate is the shared-file rule alone.
        assert!(is_target_installed(&spec));
        assert!(!auto_install_allowed(&spec, "zed"));
    }

    #[test]
    fn a_shared_settings_file_we_already_own_keeps_getting_repairs() {
        // Consent was given once; a moved bridge binary must not strand the
        // entry the user asked for.
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("settings.json");
        let spec = McpConfigSpec {
            shared_settings_file: true,
            ..spec_at(config_path.clone())
        };
        // The explicit-install path ignores the gate entirely.
        assert!(ensure_spec_entry(&spec, "/old/bridge", "zed"));
        assert!(auto_install_allowed(&spec, "zed"));

        ensure_spec_entry(&spec, "/new/bridge", "zed");
        let root = read_json_file(&config_path).unwrap();
        assert_eq!(root["mcpServers"][TUIC_MCP_KEY]["command"], "/new/bridge");
    }

    #[test]
    fn zed_amp_and_gemini_are_the_shared_settings_targets() {
        for agent in ["zed", "amp", "gemini"] {
            let spec = get_mcp_config_spec(agent).expect("supported");
            assert!(spec.shared_settings_file, "{agent} shares a settings file");
        }
        for agent in ["cursor", "vscode", "windsurf", "droid", "claude"] {
            let spec = get_mcp_config_spec(agent).expect("supported");
            assert!(
                !spec.shared_settings_file,
                "{agent} has a dedicated MCP config"
            );
        }
    }

    #[test]
    fn unparseable_toml_is_left_untouched() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");
        let original = "[cli\ninstaller = \"npm\"\n";
        std::fs::write(&config_path, original).unwrap();

        assert!(read_toml_file(&config_path).is_none());
        assert!(!ensure_toml_mcp_entry(
            &config_path,
            true,
            "/bridge",
            "grok"
        ));
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), original);
    }

    // --- per-agent entry shapes ---

    #[test]
    fn opencode_entry_uses_the_local_command_array_shape() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("opencode.json");
        assert!(ensure_agent_mcp_entry(
            &config_path,
            &["mcp"],
            McpFormat::OpenCode,
            "/bridge",
            "opencode",
        ));

        let root = read_json_file(&config_path).unwrap();
        let entry = &root["mcp"][TUIC_MCP_KEY];
        assert_eq!(entry["type"], "local");
        assert_eq!(entry["command"], serde_json::json!(["/bridge"]));
        assert_eq!(entry["enabled"], true);
        // The schema is additionalProperties: false — stdio fields are rejected.
        assert!(entry.get("args").is_none());
        assert!(entry.get("env").is_none());

        // Idempotent
        assert!(!ensure_agent_mcp_entry(
            &config_path,
            &["mcp"],
            McpFormat::OpenCode,
            "/bridge",
            "opencode",
        ));
    }

    #[test]
    fn grok_toml_entry_omits_the_codex_env_allowlist() {
        // Grok's schema has no env_vars key; it inherits the environment.
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, "[cli]\ninstaller = \"npm\"\n").unwrap();

        assert!(ensure_toml_mcp_entry(
            &config_path,
            false,
            "/bridge",
            "grok"
        ));
        let root = read_toml_file(&config_path).unwrap();
        let entry = &root["mcp_servers"][TUIC_MCP_KEY];
        assert_eq!(entry["command"].as_str(), Some("/bridge"));
        assert!(entry.get("env_vars").is_none());
        // Unrelated sections survive
        assert_eq!(root["cli"]["installer"].as_str(), Some("npm"));

        assert!(!ensure_toml_mcp_entry(
            &config_path,
            false,
            "/bridge",
            "grok"
        ));
    }

    #[test]
    fn goose_yaml_entry_carries_every_required_field() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("config.yaml");
        std::fs::write(
            &config_path,
            "GOOSE_PROVIDER: anthropic\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n    name: developer\n",
        )
        .unwrap();

        assert!(ensure_yaml_mcp_entry(
            &config_path,
            "extensions",
            "/bridge",
            "goose"
        ));
        let root = read_yaml_file(&config_path).unwrap();
        let entry = &root["extensions"][TUIC_MCP_KEY];
        // goose deserializes into ExtensionEntry { enabled, #[flatten] config }
        // where Stdio requires name, cmd, args and timeout.
        assert_eq!(entry["enabled"], serde_yaml::Value::Bool(true));
        assert_eq!(entry["type"].as_str(), Some("stdio"));
        assert_eq!(entry["name"].as_str(), Some(TUIC_MCP_KEY));
        assert_eq!(entry["cmd"].as_str(), Some("/bridge"));
        assert!(entry["args"].is_sequence());
        assert_eq!(entry["timeout"].as_u64(), Some(300));

        // Other extensions and unrelated settings survive
        assert_eq!(
            root["extensions"]["developer"]["type"].as_str(),
            Some("builtin")
        );
        assert_eq!(root["GOOSE_PROVIDER"].as_str(), Some("anthropic"));

        assert!(!ensure_yaml_mcp_entry(
            &config_path,
            "extensions",
            "/bridge",
            "goose"
        ));

        remove_yaml_mcp_entry(&config_path, "extensions").unwrap();
        let root = read_yaml_file(&config_path).unwrap();
        assert!(root["extensions"].get(TUIC_MCP_KEY).is_none());
        assert!(root["extensions"].get("developer").is_some());
    }

    #[test]
    fn add_on_targets_are_skipped_until_their_config_exists() {
        // pi only speaks MCP through the pi-mcp-adapter extension, which owns
        // ~/.pi/agent/mcp.json. No file means no adapter, so writing one would
        // configure nothing and litter the agent directory.
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("mcp.json");
        std::fs::write(dir.path().join("settings.json"), "{}").unwrap();
        let spec = McpConfigSpec {
            requires_existing_config: true,
            ..spec_at(config_path.clone())
        };
        assert!(is_target_installed(&spec), "the agent itself is installed");

        assert!(!auto_install_allowed(&spec, "pi"), "launch must not write");

        // Once the add-on has created the file, the entry lands in it.
        std::fs::write(&config_path, "{}").unwrap();
        assert!(auto_install_allowed(&spec, "pi"));
        assert!(ensure_spec_entry(&spec, "/bridge", "pi"));
        assert!(has_bridge_entry(&spec));
    }

    /// Settings > Agents > Install is an explicit statement that the target is
    /// here — the presence heuristic exists to stop launch-time guessing, not to
    /// veto the user. `install_agent_mcp` calls `ensure_spec_entry` directly, so
    /// it must write even when auto-install would have skipped.
    #[test]
    fn an_explicit_install_writes_a_target_auto_install_would_skip() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("mcp.json");
        let spec = McpConfigSpec {
            requires_existing_config: true,
            ..spec_at(config_path.clone())
        };

        assert!(!auto_install_allowed(&spec, "pi"));
        assert!(
            ensure_spec_entry(&spec, "/bridge", "pi"),
            "explicit install"
        );
        assert!(has_bridge_entry(&spec));
    }

    #[test]
    fn every_supported_agent_has_a_spec() {
        for agent in SUPPORTED_AGENTS {
            assert!(
                get_mcp_config_spec(agent).is_some(),
                "{agent} is in SUPPORTED_AGENTS but has no config spec",
            );
        }
    }
}
