//! User/profile perimeter edits and ego's own effective view. No config file I/O.

use serde::Deserialize;

use super::{ConfigContext, ConfigListing, EgoCliError, EgoCliErrorCode, unreadable};
use crate::AppState;

mod types;
pub(crate) use types::*;

impl ConfigContext {
    async fn view(&self) -> Result<PerimeterView, EgoCliError> {
        let stored = self.command("ls", &["--json"]).await?;
        let listing: ConfigListing = serde_json::from_str(&stored)
            .map_err(|error| unreadable("ego config ls --json", stored, error))?;
        let raw = self.command("ls", &["--effective", "--json"]).await?;
        let effective: EffectivePerimeter = serde_json::from_str(&raw)
            .map_err(|error| unreadable("ego config ls --effective --json", raw, error))?;
        project(listing, effective, self.profile.clone())
    }
}

#[derive(Deserialize)]
struct StoredRoot {
    path: String,
    access: RootAccess,
}

fn project(
    listing: ConfigListing,
    effective: EffectivePerimeter,
    profile: Option<String>,
) -> Result<PerimeterView, EgoCliError> {
    let stored_roots = listing.values.get("roots");
    let roots: Vec<StoredRoot> = if let Some(value) = stored_roots {
        serde_json::from_value(value.clone())
            .map_err(|error| unreadable("ego config ls --json", value.to_string(), error))?
    } else {
        effective
            .roots
            .iter()
            .map(|root| StoredRoot {
                path: root.path.clone(),
                access: root.access,
            })
            .collect()
    };
    let network_enabled = match listing
        .values
        .get("network")
        .and_then(|value| value.as_str())
    {
        Some("on") => true,
        Some("off") => false,
        None if !listing.values.contains_key("network") => effective.network == "online",
        _ => {
            return Err(EgoCliError::plain(
                EgoCliErrorCode::UnreadableOutput,
                "ego returned an unknown network setting",
            ));
        }
    };
    let first = roots.first();
    let edit = RootsEdit {
        root_dir: first.map_or_else(String::new, |root| root.path.clone()),
        root_access: first.map_or(RootAccess::ReadWrite, |root| root.access),
        read_allowlist: roots
            .iter()
            .skip(1)
            .filter(|root| root.access == RootAccess::Read)
            .map(|root| root.path.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        writable_dirs: roots
            .iter()
            .skip(1)
            .filter(|root| root.access == RootAccess::ReadWrite)
            .map(|root| root.path.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
    };
    let preview = serde_json::to_string_pretty(&effective).map_err(|error| {
        EgoCliError::plain(EgoCliErrorCode::UnreadableOutput, error.to_string())
    })?;
    Ok(PerimeterView {
        profile,
        roots: edit,
        network_enabled,
        exec_enforcement: exec_enforcement(&effective),
        effective,
        preview,
    })
}

/// Interpret ego's measured guarantees for spawned processes, never root-tool permissions.
fn exec_enforcement(effective: &EffectivePerimeter) -> ExecEnforcement {
    let CapabilityEvidence::Measured(capabilities) = &effective.capabilities else {
        return ExecEnforcement::NotChecked;
    };
    if effective.capabilities_reason.is_some()
        || effective
            .probe_evidence
            .as_ref()
            .is_none_or(String::is_empty)
        || capabilities.iter().any(|capability| {
            !matches!(
                capability.as_str(),
                "read_scoped" | "write_denied" | "write_scoped" | "no_ip_network"
            )
        })
    {
        return ExecEnforcement::NotChecked;
    }
    // ego-core Confinement::required_caps; networking is a separate axis.
    let mut required = match effective.sandbox.as_str() {
        "ro" => vec!["read_scoped", "write_denied"],
        "workspace" => vec!["read_scoped", "write_scoped"],
        "off" => Vec::new(),
        _ => return ExecEnforcement::NotChecked,
    };
    match effective.network.as_str() {
        "offline" => required.push("no_ip_network"),
        "online" => {}
        _ => return ExecEnforcement::NotChecked,
    }
    if required.is_empty()
        || required
            .iter()
            .any(|needed| !capabilities.iter().any(|capability| capability == needed))
    {
        ExecEnforcement::PromptOnly
    } else {
        ExecEnforcement::EnforcedByOs
    }
}

fn roots_assignment(edit: &RootsEdit) -> Result<String, EgoCliError> {
    if edit.root_dir.chars().any(char::is_control) {
        return Err(EgoCliError::invalid_input(
            "root directory must be a single path without control characters",
        ));
    }
    if edit.root_dir.len() + edit.read_allowlist.len() + edit.writable_dirs.len() > 65536 {
        return Err(EgoCliError::invalid_input("perimeter paths exceed 64 KiB"));
    }
    let mut roots = Vec::new();
    for (text, access) in [
        (edit.root_dir.as_str(), edit.root_access),
        (edit.read_allowlist.as_str(), RootAccess::Read),
        (edit.writable_dirs.as_str(), RootAccess::ReadWrite),
    ] {
        for path in text.lines().map(str::trim).filter(|path| !path.is_empty()) {
            if path.chars().any(char::is_control)
                || (!crate::fs::is_absolute_on_any_platform(path) && !path.starts_with("~/"))
            {
                return Err(EgoCliError::invalid_input(
                    "root paths must be absolute or start with ~/ and contain no control characters",
                ));
            }
            if roots.len() >= 128 {
                return Err(EgoCliError::invalid_input(
                    "at most 128 perimeter roots are allowed",
                ));
            }
            let path = toml_edit::Value::from(path).to_string();
            let access = match access {
                RootAccess::Read => "read",
                RootAccess::ReadWrite => "read-write",
            };
            roots.push(format!("{{path={path},access=\"{access}\"}}"));
        }
    }
    Ok(format!("roots=[{}]", roots.join(",")))
}

pub(crate) async fn read(state: &AppState) -> Result<PerimeterView, EgoCliError> {
    ConfigContext::configured(state)?.view().await
}

pub(crate) async fn set_roots(
    state: &AppState,
    roots: RootsEdit,
) -> Result<PerimeterView, EgoCliError> {
    let assignment = roots_assignment(&roots)?;
    let context = ConfigContext::configured(state)?;
    context.command("set", &[&assignment]).await?;
    context.view().await
}

pub(crate) async fn set_network(
    state: &AppState,
    enabled: bool,
) -> Result<PerimeterView, EgoCliError> {
    let context = ConfigContext::configured(state)?;
    context
        .command(
            "set",
            &[if enabled {
                "network=\"on\""
            } else {
                "network=\"off\""
            }],
        )
        .await?;
    context.view().await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn ego_perimeter(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
) -> Result<PerimeterView, EgoCliError> {
    read(&state).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn ego_set_perimeter_roots(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    roots: RootsEdit,
) -> Result<PerimeterView, EgoCliError> {
    set_roots(&state, roots).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn ego_set_perimeter_network(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    enabled: bool,
) -> Result<PerimeterView, EgoCliError> {
    set_network(&state, enabled).await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod critic_tests;
