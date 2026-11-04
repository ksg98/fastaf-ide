//! One immutable authority/workspace/profile snapshot for a configuration operation.
use super::{EgoCliError, run_at};
use crate::AppState;
use std::path::PathBuf;

pub(crate) struct ConfigContext {
    pub(crate) program: PathBuf,
    pub(crate) workspace: PathBuf,
    pub(crate) profile: Option<String>,
}

impl ConfigContext {
    pub(crate) fn configured(state: &AppState) -> Result<Self, EgoCliError> {
        let settings = state.config.read();
        if settings.ego_executable.trim().is_empty() {
            return Err(EgoCliError::not_configured());
        }
        let program = PathBuf::from(&settings.ego_executable);
        if !program.is_absolute() {
            return Err(EgoCliError::invalid_input(
                "the trusted ego executable must be absolute",
            ));
        }
        let workspace = if settings.ai_chat_workspace.trim().is_empty() {
            dirs::home_dir().ok_or_else(|| EgoCliError::invalid_input("HOME is unavailable"))?
        } else {
            PathBuf::from(settings.ai_chat_workspace.trim())
        };
        // Created like `acp_commands::workspace_root` does, so the tab works before the first chat.
        if !workspace.is_absolute() || std::fs::create_dir_all(&workspace).is_err() {
            return Err(EgoCliError::invalid_input(
                "AI Chat workspace must be a usable absolute directory (Settings > General)",
            ));
        }
        let profile = settings.ego_profile.trim();
        if profile.len() > 64 || profile.chars().any(char::is_control) {
            return Err(EgoCliError::invalid_input("invalid ego profile"));
        }
        Ok(Self {
            program,
            workspace,
            profile: (!profile.is_empty()).then(|| profile.to_owned()),
        })
    }

    pub(crate) async fn run(&self, args: &[String]) -> Result<String, EgoCliError> {
        run_at(&self.program, args, Some(&self.workspace)).await
    }

    /// Transaction options are flags, not positional assignments after `--`.
    pub(crate) async fn managed(
        &self,
        operation: &str,
        tail: &[String],
    ) -> Result<String, EgoCliError> {
        let mut args = vec!["config".into(), operation.into()];
        if let Some(profile) = &self.profile {
            args.push(format!("--profile={profile}"));
        }
        args.extend_from_slice(tail);
        self.run(&args).await
    }

    pub(crate) async fn command(
        &self,
        operation: &str,
        tail: &[&str],
    ) -> Result<String, EgoCliError> {
        let mut args = vec!["config".into(), operation.into()];
        if let Some(profile) = &self.profile {
            args.push(format!("--profile={profile}"));
        }
        if operation != "ls" {
            args.push("--".into());
        }
        args.extend(tail.iter().map(|s| (*s).to_owned()));
        self.run(&args).await
    }
}
