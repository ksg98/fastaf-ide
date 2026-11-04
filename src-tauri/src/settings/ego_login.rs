//! Human-operated Ego authentication; PTY lifetime is not credential success.
use super::*;
use std::{collections::HashMap, path::PathBuf};
use tokio::time::{Duration, Instant};

const MAX_FLOWS: usize = 32;
const FLOW_LIFETIME: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
struct Flow {
    provider: String,
    session_id: String,
    program: PathBuf,
    workspace: PathBuf,
    started: Instant,
}

#[derive(Default)]
pub(super) struct Logins(Mutex<HashMap<String, Flow>>);

impl EgoSettingsStore {
    pub(crate) async fn perform_auth(
        self: Arc<Self>,
        expected_revision: String,
        action: EgoAuthAction,
    ) -> Result<Value, Failure> {
        match action {
            EgoAuthAction::BeginLogin { provider } => {
                tokio::task::spawn_blocking(move || self.begin_login(&expected_revision, provider))
                    .await
                    .map_err(|_| Error::new(ID, "store_failed"))?
            }
            EgoAuthAction::LoginStatus { flow_id } => self.login_status(&flow_id).await,
            action => {
                let reply =
                    tokio::task::spawn_blocking(move || self.auth_edit(&expected_revision, action))
                        .await
                        .map_err(|_| Error::new(ID, "store_failed"))??;
                serde_json::to_value(reply).map_err(|_| Error::new(ID, "store_failed"))
            }
        }
    }

    fn begin_login(&self, expected_revision: &str, provider: String) -> Result<Value, Failure> {
        if provider.is_empty()
            || provider.len() > 64
            || !provider
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
            || provider.starts_with('-')
        {
            return Err(Error::new(ID, "unknown_path"));
        }
        // Serialize the revision check and process launch with other owner edits. No
        // shell, caller executable or profile override can change the accepted authority.
        let _sequence = self.sequence.lock();
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| Error::new(ID, "unavailable"))?;
        let mut context =
            ConfigContext::configured(&state).map_err(|_| Error::new(ID, "unavailable"))?;
        context.profile = None;
        let snapshot = self.snapshot(&context)?;
        if transaction::revision(&snapshot)? != expected_revision {
            return Err(Error::new(ID, "conflict"));
        }
        let mut flows = self.logins.0.lock();
        flows.retain(|_, flow| flow.started.elapsed() < FLOW_LIFETIME);
        if flows.len() >= MAX_FLOWS {
            return Err(Error::new(ID, "out_of_range"));
        }
        let args = vec!["auth".into(), "login".into(), "--".into(), provider.clone()];
        let session_id = crate::mcp_http::session::spawn_pty_command(
            state,
            &context.program,
            &context.workspace,
            &args,
        )
        .map_err(|_| Error::new(ID, "unavailable"))?;
        let flow_id = uuid::Uuid::new_v4().to_string();
        flows.insert(
            flow_id.clone(),
            Flow {
                provider,
                session_id: session_id.clone(),
                program: context.program,
                workspace: context.workspace,
                started: Instant::now(),
            },
        );
        Ok(
            json!({"flowId":flow_id, "sessionId":session_id, "status":"interactive", "expiresIn":FLOW_LIFETIME.as_secs(), "persisted":false, "nextAction":"login_status"}),
        )
    }

    async fn login_status(&self, flow_id: &str) -> Result<Value, Failure> {
        let flow = self
            .logins
            .0
            .lock()
            .get(flow_id)
            .cloned()
            .ok_or_else(|| Error::new(ID, "not_found"))?;
        if flow.started.elapsed() >= FLOW_LIFETIME {
            return Ok(
                json!({"flowId":flow_id, "sessionId":flow.session_id, "status":"expired", "nextAction":"begin_login"}),
            );
        }
        let state = self
            .state
            .upgrade()
            .ok_or_else(|| Error::new(ID, "unavailable"))?;
        let mut context =
            ConfigContext::configured(&state).map_err(|_| Error::new(ID, "unavailable"))?;
        context.profile = None;
        if context.program != flow.program || context.workspace != flow.workspace {
            return Err(Error::new(ID, "conflict"));
        }
        let active = match state.session_maps.sessions.get(&flow.session_id) {
            Some(session) => session
                .lock()
                ._child
                .try_wait()
                .map_err(|_| Error::new(ID, "unavailable"))?
                .is_none(),
            None => false,
        };
        if active {
            return Ok(
                json!({"flowId":flow_id, "sessionId":flow.session_id, "status":"interactive", "nextAction":"login_status"}),
            );
        }
        // Closed, cancelled, expired at the provider, and successful logins all end
        // the PTY. Only the configured owner's doctor projection describes credentials.
        let providers = crate::ego_cli::providers_in(&context, false)
            .await
            .map_err(|_| Error::new(ID, "unavailable"))?;
        let credential = providers
            .providers
            .into_iter()
            .find(|provider| provider.name == flow.provider)
            .map(|provider| provider.credential)
            .unwrap_or(crate::ego_cli::EgoCredential::Unknown {
                detail: "Provider absent from the owner catalogue".into(),
            });
        Ok(
            json!({"flowId":flow_id, "sessionId":flow.session_id, "status":"closed", "credential":credential, "nextAction":"refresh"}),
        )
    }
}
