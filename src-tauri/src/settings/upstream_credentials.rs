//! Typed credential actions delegate storage and origin binding to the upstream owner.
use super::request::{Error, Failure};
use crate::{
    config::ConfigFile,
    mcp_upstream_config::{
        UPSTREAM_SAVE_SEQUENCE, UPSTREAMS_FILE, UpstreamAuth, UpstreamMcpConfig, UpstreamTransport,
        validate_upstream_config,
    },
    state::AppState,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
const ID: &str = "upstreams";

// No Debug/Serialize: credential values are input-only.
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum CredentialAction {
    SetBearer {
        id: String,
        #[schemars(extend("writeOnly"=true,"x-sensitivity"="secret"))]
        token: String,
    },
    SetHeader {
        id: String,
        header: String,
        #[schemars(extend("writeOnly"=true,"x-sensitivity"="secret"))]
        token: String,
    },
    Clear {
        id: String,
        header: Option<String>,
    },
    BeginLogin {
        id: String,
    },
}

pub struct UpstreamCredentials {
    state: Arc<AppState>,
}
impl UpstreamCredentials {
    pub(crate) fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }
    pub fn action_schema() -> Value {
        super::catalogue::schema::<CredentialAction>()
    }
    pub fn read(&self) -> Result<Value, Failure> {
        ConfigFile::<UpstreamMcpConfig>::new(UPSTREAMS_FILE).update_with_strict(|config| {
            let mut rows=Vec::new();
            for server in &config.servers {
                let presence=|key:&str| match crate::mcp_upstream_credentials::has_upstream_credential(key) { Ok(true)=>"set",Ok(false)=>"unset",Err(_)=>"unavailable" };
                rows.push(json!({"id":server.id,"credentials":{
                    "auth":presence(&server.name),
                    "headers":server.headers.iter().map(|header|json!({"name":header.name,"status":presence(&header.credential_key(&server.name))})).collect::<Vec<_>>()
                }}));
            }
            Ok((json!({"servers":rows}),false))
        }).map_err(|_|Error::new(ID,"store_failed"))
    }
    pub async fn perform(&self, action: CredentialAction) -> Result<Value, Failure> {
        if let CredentialAction::BeginLogin { id } = action {
            // OAuth needs the desktop browser and its local callback listener.
            #[cfg(feature = "desktop")]
            let desktop_available = self.state.app_handle.read().is_some();
            #[cfg(not(feature = "desktop"))]
            let desktop_available = false;
            if !desktop_available {
                return Err(Error::new(ID, "unavailable"));
            }
            let name = ConfigFile::<UpstreamMcpConfig>::new(UPSTREAMS_FILE)
                .update_with_strict(|config| {
                    Ok((
                        config
                            .servers
                            .iter()
                            .find(|server| server.id == id)
                            .map(|server| server.name.clone()),
                        false,
                    ))
                })
                .map_err(|_| Error::new(ID, "store_failed"))?
                .ok_or_else(|| Error::new(ID, "not_found"))?;
            return crate::mcp_oauth::commands::start_mcp_upstream_oauth_inner(&self.state,name).await.map(|response|json!({"authorizationUrl":response.authorization_url,"state":response.state,"crossDomainAs":response.cross_domain_as})).map_err(|_|Error::new(ID,"unavailable"));
        }
        let _sequence = UPSTREAM_SAVE_SEQUENCE.lock().await;
        let mut committed = false;
        let self_port = self.state.config.read().services.server.port;
        let result =
            ConfigFile::<UpstreamMcpConfig>::new(UPSTREAMS_FILE).update_with_strict(|config| {
                let old = config.clone();
                let (id, header_name) = match &action {
                    CredentialAction::SetBearer { id, .. } => (id, None),
                    CredentialAction::SetHeader { id, header, .. } => (id, Some(header.as_str())),
                    CredentialAction::Clear { id, header } => (id, header.as_deref()),
                    CredentialAction::BeginLogin { .. } => unreachable!(),
                };
                if matches!(&action, CredentialAction::SetBearer { .. }) {
                    let mut proposed = config.clone();
                    let server = proposed
                        .servers
                        .iter_mut()
                        .find(|server| &server.id == id)
                        .ok_or("not found")?;
                    server.auth = Some(UpstreamAuth::Bearer {
                        token: String::new(),
                    });
                    if !validate_upstream_config(&proposed, self_port).is_empty() {
                        return Err("invalid upstream config".into());
                    }
                }
                let server = config
                    .servers
                    .iter_mut()
                    .find(|server| &server.id == id)
                    .ok_or("not found")?;
                let UpstreamTransport::Http { url } = &server.transport else {
                    return Err("HTTP required".into());
                };
                let header = header_name
                    .map(|name| {
                        server
                            .headers
                            .iter()
                            .find(|header| header.name.eq_ignore_ascii_case(name))
                            .cloned()
                            .ok_or("header not found")
                    })
                    .transpose()?;
                match &action {
                    CredentialAction::SetBearer { token, .. }
                    | CredentialAction::SetHeader { token, .. } => {
                        crate::mcp_upstream_credentials::write_credential(
                            &server.name,
                            token,
                            header.as_ref(),
                            url,
                            true,
                        )?;
                        committed = true;
                        if header.is_none() {
                            server.auth = Some(UpstreamAuth::Bearer {
                                token: String::new(),
                            });
                        }
                    }
                    CredentialAction::Clear { .. } => {
                        crate::mcp_upstream_credentials::delete_mcp_upstream_credential(
                            server.name.clone(),
                            header.clone(),
                        )?;
                        committed = true;
                        if header.is_none() {
                            server.auth = None;
                        }
                    }
                    CredentialAction::BeginLogin { .. } => unreachable!(),
                }
                Ok(((old, config.clone()), true))
            });
        let (_old, new) = result.map_err(|_| {
            let mut error = Error::new(ID, "store_failed");
            error.persisted = committed;
            error.next_action = "get".into();
            error
        })?;
        // A credential rotation may leave metadata identical; explicitly reconnect that owner.
        let id = match &action {
            CredentialAction::SetBearer { id, .. }
            | CredentialAction::SetHeader { id, .. }
            | CredentialAction::Clear { id, .. } => id,
            CredentialAction::BeginLogin { .. } => unreachable!(),
        };
        if let Some(server) = new.servers.iter().find(|server| &server.id == id) {
            self.state
                .mcp
                .oauth_flow_manager
                .cancel_flows_for(&server.name);
        }
        if let Some(server) = new
            .servers
            .iter()
            .find(|server| &server.id == id && server.enabled)
        {
            let _ = self
                .state
                .mcp
                .upstream_registry
                .disconnect_upstream(&server.name);
            self.state
                .mcp
                .upstream_registry
                .connect_upstream(server.clone(), Some(self_port))
                .await
                .map_err(|_| {
                    let mut e = Error::new(ID, "apply_failed");
                    e.persisted = true;
                    e.next_action = "get".into();
                    e
                })?;
        }
        let snapshot = self.read().map_err(|mut e| {
            e.persisted = true;
            e.next_action = "get".into();
            e
        })?;
        Ok(json!({"persisted":true,"applied":true,"snapshot":snapshot}))
    }
}

pub(super) fn catalogue_schema() -> Value {
    let mut schema = super::catalogue::schema::<UpstreamMcpConfig>();
    let status = json!({
        "type":"string", "enum":["set","unset","unavailable"],
        "x-setting": {"sensitivity":"secret","apply":"live",
            "effect":"Reads credential presence. Use typed upstream owner actions for bearer/header rotation, clearing and OAuth login; values never leave the owner.",
            "operations":["get","set_secret","clear_secret"],"confirmationClass":"execution_authority"}
    });
    schema["properties"]["servers"]["items"]["properties"]["credentials"] = json!({
        "type":"object", "properties": {
            "auth": status,
            "headers": {"type":"array","x-collection-key":"name","items":{
                "type":"object", "properties":{
                    "name":{"type":"string","x-not-setting":"Header identity supplied by the upstream owner."},
                    "status":status
                }
            }}
        }
    });
    schema
}
