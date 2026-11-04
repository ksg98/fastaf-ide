//! AppConfig owner seam: private config helpers stay inside their owning module.
use super::*;
use crate::settings::{request::*, service::Store, transaction::Prepared};
use std::sync::Arc;

pub(crate) struct AppSettingsStore {
    state: std::sync::Weak<crate::AppState>,
}

impl AppSettingsStore {
    pub(crate) fn new(state: Arc<crate::AppState>) -> Self {
        Self {
            state: Arc::downgrade(&state),
        }
    }

    fn latest(&self, file: &ConfigFile<AppConfig>) -> Result<AppConfig, Failure> {
        // Unlike legacy forgiving hydration, an unavailable vault cannot become unset.
        let secrets =
            AppSecretSnapshot::capture().map_err(|_| Error::new("app", "secret_unreadable"))?;
        let mut config: AppConfig = if file.path.exists() {
            let content = std::fs::read_to_string(&file.path)
                .map_err(|_| Error::new("app", "store_failed"))?;
            let mut json: serde_json::Value =
                serde_json::from_str(&content).map_err(|_| Error::new("app", "store_failed"))?;
            migrate_flat_services(&mut json);
            serde_json::from_value(json).map_err(|_| Error::new("app", "store_failed"))?
        } else {
            self.state
                .upgrade()
                .ok_or_else(|| Error::new("app", "unavailable"))?
                .config
                .read()
                .clone()
        };
        migrate_legacy_session_token_duration(&mut config);
        migrate_legacy_scrollback_reflow(&mut config);
        migrate_retired_beta_channel(&mut config);
        for (value, exists, secret) in [
            (
                &mut config.services.auth.session_token,
                config.services.auth.session_token_exists,
                secrets.session_token,
            ),
            (
                &mut config.services.relay.token,
                config.services.relay.token_exists.unwrap_or(false),
                secrets.relay_token,
            ),
            (
                &mut config.services.push.vapid_private_key,
                config.services.push.vapid_private_key_exists,
                secrets.vapid_private_key,
            ),
        ] {
            if value.is_empty() {
                if exists && secret.is_none() {
                    return Err(Error::new("app", "secret_unreadable"));
                }
                *value = secret.unwrap_or_default();
            }
        }
        // Match the vault-presence flags written by config_for_disk even on first save.
        config.services.auth.session_token_exists = !config.services.auth.session_token.is_empty();
        config.services.relay.token_exists = Some(!config.services.relay.token.is_empty());
        config.services.push.vapid_private_key_exists =
            !config.services.push.vapid_private_key.is_empty();
        Ok(config)
    }
}

impl Store for AppSettingsStore {
    fn id(&self) -> &'static str {
        "app"
    }
    fn target(&self) -> Target {
        Target::Machine
    }

    fn read(&self) -> Result<serde_json::Value, Failure> {
        let _guard = config_write_lock();
        let file = ConfigFile::<AppConfig>::new(APP_CONFIG_FILE);
        let _file_lock = file
            .acquire_file_lock()
            .map_err(|_| Error::new("app", "store_failed"))?;
        serde_json::to_value(self.latest(&file)?).map_err(|_| Error::new("app", "store_failed"))
    }

    async fn refresh_choices(
        &self,
        resolver: &str,
        _path: &str,
    ) -> Result<Vec<serde_json::Value>, Failure> {
        crate::settings::app_choices::refresh(resolver).await
    }

    fn validate_proposal(
        &self,
        latest: &serde_json::Value,
        value: &serde_json::Value,
    ) -> Result<(), Failure> {
        crate::settings::app_choices::validate(value)?;
        let next: AppConfig =
            serde_json::from_value(value.clone()).map_err(|_| Error::new("app", "invalid_type"))?;
        if latest.get("ego_executable") != value.get("ego_executable")
            && !next.ego_executable.is_empty()
            && !std::path::Path::new(&next.ego_executable).is_absolute()
        {
            return Err(Error::new("app", "out_of_range"));
        }
        Ok(())
    }

    fn commit(
        &self,
        prepare: &mut dyn FnMut(&serde_json::Value) -> Result<Prepared, Failure>,
    ) -> Result<CommitReply, Failure> {
        let _guard = config_write_lock();
        let file = ConfigFile::<AppConfig>::new(APP_CONFIG_FILE);
        let _file_lock = file
            .acquire_file_lock()
            .map_err(|_| Error::new("app", "store_failed"))?;
        let latest = self.latest(&file)?;
        let json = serde_json::to_value(&latest).map_err(|_| Error::new("app", "store_failed"))?;
        let Prepared { value, mut reply } = prepare(&json)?;
        let mut next: AppConfig =
            serde_json::from_value(value).map_err(|_| Error::new("app", "invalid_type"))?;
        // Before the revision is taken, so it describes what is stored.
        let rotated_session_token = rotate_session_token_if_switched_on(&latest, &mut next);
        let canonical =
            serde_json::to_value(&next).map_err(|_| Error::new("app", "store_failed"))?;
        reply.revision = crate::settings::transaction::revision(&canonical)?;
        if canonical == json {
            reply.changed_ids.clear();
            reply.effects.clear();
            reply.restart.clear();
        }
        if reply.changed_ids.is_empty() {
            return Ok(reply);
        }
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| Error::new("app", "unavailable"))?;
        let cached = state.config.read();
        let tools_changed = cached.settings_mcp_enabled != next.settings_mcp_enabled
            || cached.mcp_capabilities != next.mcp_capabilities
            || cached.collapse_tools != next.collapse_tools;
        let server_changed = server_settings_changed(&cached, &next);
        let reflow_changed = cached.scrollback_reflow != next.scrollback_reflow;
        drop(cached);
        // Preserve the existing vault snapshot/rollback and atomic config-file write.
        save_app_config_with(next.clone(), |disk| file.write_atomic(disk))
            .map_err(|_| Error::new("app", "store_failed"))?;
        publish_rotated_session_token(&state, rotated_session_token);
        *state.config.write() = next;
        reply.persisted = true;
        for (enabled, effect) in [
            (tools_changed, "tools_changed"),
            (server_changed, "server_changed"),
            (reflow_changed, "reflow_changed"),
        ] {
            if enabled {
                reply.effects.push(effect.into());
            }
        }
        Ok(reply)
    }

    fn apply(
        &self,
        reply: &CommitReply,
    ) -> impl std::future::Future<Output = Result<bool, Failure>> + Send {
        std::future::ready(self.apply_committed(reply))
    }
}

impl AppSettingsStore {
    fn apply_committed(&self, reply: &CommitReply) -> Result<bool, Failure> {
        // File/config locks were dropped before the effect phase.
        if reply.effects.iter().any(|e| e == "tools_changed") {
            let _ = self
                .state
                .upgrade()
                .ok_or_else(|| Error::new("app", "unavailable"))?
                .mcp
                .tools_changed
                .send(());
        }
        let server_changed = reply.effects.iter().any(|e| e == "server_changed");
        if server_changed {
            #[cfg(feature = "desktop")]
            crate::mcp_http::restart_after_server_settings_change(
                &self
                    .state
                    .upgrade()
                    .ok_or_else(|| Error::new("app", "unavailable"))?,
                "settings transaction committed",
            );
        }
        if reply.effects.iter().any(|e| e == "reflow_changed") {
            self.state
                .upgrade()
                .ok_or_else(|| Error::new("app", "unavailable"))?
                .apply_reflow_history(
                    self.state
                        .upgrade()
                        .ok_or_else(|| Error::new("app", "unavailable"))?
                        .config
                        .read()
                        .scrollback_reflow,
                );
        }
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| Error::new("app", "unavailable"))?;
        crate::relay_client::notify_config_changed(state.as_ref());
        #[cfg(not(feature = "desktop"))]
        if server_changed {
            return Err(Error::new("app", "unavailable"));
        }
        Ok(!server_changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::request::CommitReply;

    /// Commit `edit` through the settings transaction's own store, the path
    /// behind All Settings, `POST /settings/action` and the MCP settings tool.
    fn commit_edit(state: &Arc<crate::AppState>, edit: impl Fn(&mut serde_json::Value)) {
        let store = AppSettingsStore::new(state.clone());
        let reply = store
            .commit(&mut |latest| {
                let mut value = latest.clone();
                edit(&mut value);
                Ok(Prepared {
                    value,
                    reply: CommitReply {
                        revision: String::new(),
                        changed_ids: vec!["app.services.server".into()],
                        persisted: false,
                        applied: false,
                        effects: Vec::new(),
                        restart: Vec::new(),
                    },
                })
            })
            .expect("commit");
        assert!(reply.persisted);
    }

    // Catches: remote access switched on from All Settings, `POST /settings/action`
    // or the MCP settings tool keeping a token that crossed the LAN in clear text
    // while it was last on (the IPC/HTTP config writers already rotated).
    #[test]
    #[serial_test::serial]
    fn enabling_remote_access_through_settings_issues_a_new_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _guard = set_config_dir_override(dir.path().to_path_buf());
        crate::credentials::reset_test_faults();
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        {
            let mut cfg = state.config.write();
            cfg.services.server.enabled = false;
            cfg.services.auth.session_token = "captured-token".to_string();
            cfg.services.auth.session_token_exists = true;
        }
        *state.session_token.write() = "captured-token".to_string();

        commit_edit(&state, |value| {
            value["services"]["server"]["enabled"] = serde_json::json!(true)
        });
        let issued = state.session_token.read().clone();
        assert_ne!(issued, "captured-token");
        assert!(uuid::Uuid::parse_str(&issued).is_ok(), "{issued}");
        assert_eq!(state.config.read().services.auth.session_token, issued);
        assert_eq!(
            crate::credentials::get(crate::credentials::Credential::RemoteSessionToken)
                .expect("vault readable"),
            Some(issued.clone())
        );

        // Staying on keeps it; paired phones survive ordinary edits.
        commit_edit(&state, |value| {
            value["services"]["server"]["port"] = serde_json::json!(9981)
        });
        assert_eq!(*state.session_token.read(), issued);
    }
}
