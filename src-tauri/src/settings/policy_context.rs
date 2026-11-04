//! Host-origin identity is never part of a model-deserialized request.
use super::super::request::{Error, Failure};
use std::{net::SocketAddr, time::Duration};

#[derive(Clone, PartialEq, Eq)]
pub(super) struct CallerKey {
    pub connection: String,
    pub origin: &'static str,
}
/// Constructed by the server transport, never deserialized from a model payload.
#[derive(Clone)]
pub struct Caller {
    pub(super) key: CallerKey,
    allowed: bool,
    read_allowed: bool,
    enabled: bool,
}
impl Caller {
    pub fn native() -> Self {
        Self {
            key: CallerKey {
                connection: "native".into(),
                origin: "ipc",
            },
            allowed: true,
            read_allowed: true,
            enabled: true,
        }
    }
    pub fn http(connection: String, authenticated_or_local: bool) -> Self {
        let enabled = !connection.is_empty();
        Self {
            key: CallerKey {
                connection,
                origin: "http",
            },
            allowed: authenticated_or_local,
            read_allowed: authenticated_or_local,
            enabled,
        }
    }
    pub fn mcp(addr: SocketAddr, connection: String, settings_enabled: bool) -> Self {
        let enabled = settings_enabled && !connection.is_empty();
        Self {
            key: CallerKey {
                connection,
                origin: "mcp",
            },
            allowed: addr.ip().is_loopback(),
            read_allowed: true,
            enabled,
        }
    }
    pub fn check(&self, mutation: bool) -> Result<(), Failure> {
        if !self.enabled {
            return Err(Error::new("settings", "unavailable"));
        }
        if !self.read_allowed || (mutation && !self.allowed) {
            return Err(Error::new("settings", "forbidden_origin"));
        }
        Ok(())
    }
}

/// Backend-built redacted text for the existing confirmation dialog.
#[derive(Clone)]
pub struct Preview {
    pub title: String,
    pub message: String,
    pub(crate) remaining: Duration,
}
/// Bounded audit contains identifiers and outcomes only, never values or dynamic keys.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
    pub connection: String,
    pub origin: &'static str,
    pub target: super::super::request::Target,
    pub store: String,
    pub changed_ids: Vec<String>,
    pub outcome: String,
}
