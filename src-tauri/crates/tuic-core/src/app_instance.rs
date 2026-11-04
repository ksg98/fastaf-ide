//! Application identity shared with the IPC clients.

use std::sync::OnceLock;

pub use tuic_ipc::app_instance::{
    APP_INSTANCE_ENV_VAR, AppInstance, current_app_instance, is_owned_vault_service,
    select_app_instance, select_app_instance_from_env,
};

/// Who this *running process* is, on the wire.
///
/// Deliberately minted per process rather than derived from the instance id or
/// the config directory: two daemons on one machine are two legitimate peers,
/// and what a remote connection must never do is dial the process it is
/// already running in. `/health` publishes it, and `remote_runtime::connect`
/// refuses a base URL that answers with this exact value — a self-connection
/// mirrors every local event back onto the bus that produced it.
pub fn instance_identity() -> &'static str {
    static IDENTITY: OnceLock<String> = OnceLock::new();
    IDENTITY.get_or_init(|| uuid::Uuid::new_v4().to_string())
}
