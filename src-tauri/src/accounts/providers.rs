//! Trusted registration seam; plugin manifests register through `plugins::register_loaded_plugin_impl`.
use super::model::AuthKind;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{LazyLock, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct VerifyRequest {
    /// Relative API path, resolved under the site base URL.
    pub path: String,
    /// JSON Pointer to the verified viewer's display identity.
    pub login_pointer: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderDescriptor {
    pub id: String,
    pub label: String,
    pub kinds: Vec<AuthKind>,
    pub verify: VerifyRequest,
}

static PROVIDERS: LazyLock<RwLock<BTreeMap<String, (String, ProviderDescriptor)>>> =
    LazyLock::new(|| RwLock::new(BTreeMap::new()));

/// Register a descriptor from a trusted core caller after manifest validation.
/// Non-core providers support tokens only; no OAuth machinery or arbitrary headers.
pub(crate) fn register_provider(owner: &str, descriptor: ProviderDescriptor) -> Result<(), String> {
    if owner.is_empty() || !valid_id(&descriptor.id) || descriptor.id == "github" {
        return Err("Invalid or reserved account provider".into());
    }
    if descriptor.label.trim().is_empty()
        || descriptor.label.len() > 256
        || descriptor.kinds.is_empty()
        || descriptor
            .kinds
            .iter()
            .any(|kind| !matches!(kind, AuthKind::Bearer | AuthKind::Basic))
        || !valid_path(&descriptor.verify.path)
        || !descriptor.verify.login_pointer.starts_with('/')
        || descriptor.verify.login_pointer.len() > 512
    {
        return Err("Invalid token-only provider descriptor".into());
    }
    let mut providers = PROVIDERS.write().unwrap_or_else(|e| e.into_inner());
    if let Some((registered_owner, existing)) = providers.get(&descriptor.id) {
        if registered_owner != owner || existing != &descriptor {
            return Err(
                "Account provider is already registered with different ownership or metadata"
                    .into(),
            );
        }
        return Ok(());
    }
    providers.insert(descriptor.id.clone(), (owner.to_string(), descriptor));
    Ok(())
}

/// Plugin unload removes only that owner's descriptors, never persisted accounts.
pub(crate) fn unregister_providers(owner: &str) {
    PROVIDERS
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, (registered_owner, _)| registered_owner != owner);
}

pub(crate) fn descriptor(id: &str) -> Result<ProviderDescriptor, String> {
    if id == "github" {
        return Ok(ProviderDescriptor {
            id: "github".into(),
            label: "GitHub".into(),
            kinds: vec![AuthKind::Bearer, AuthKind::OauthDevice, AuthKind::Ambient],
            verify: VerifyRequest {
                path: "/user".into(),
                login_pointer: "/login".into(),
            },
        });
    }
    PROVIDERS
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .map(|(_, descriptor)| descriptor.clone())
        .ok_or_else(|| "Account provider is unavailable; load its plugin first".into())
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn valid_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= 1024
        && !path.contains(['?', '#', '\\', '%'])
        && !path.split('/').any(|part| matches!(part, "." | ".."))
}

pub(crate) fn canonical_host(raw: &str) -> Result<String, String> {
    if raw.len() > 4096 {
        return Err("Site URL is too long".into());
    }
    let mut url = url::Url::parse(raw).map_err(|_| "Site requires an HTTP(S) base URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || raw.contains(['\\', '%'])
        || raw.split('/').any(|part| matches!(part, "." | ".."))
    {
        return Err(
            "Invalid site URL: credentials, query, fragment and traversal are forbidden".into(),
        );
    }
    if let Some(url::Host::Domain(domain)) = url.host() {
        let domain = domain.trim_end_matches('.').to_string();
        url.set_host(Some(&domain))
            .map_err(|_| "Invalid site hostname")?;
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}
