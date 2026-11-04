//! Disable tauri-build's reverse sidecar copy without changing the CLI's
//! packaging configuration. This module is also compiled by the lib tests.

use serde_json::{Map, Value};

/// Keep CLI overrides, but never copy staged sidecars into Cargo's target.
/// The process-local override does not change tauri.conf.json or the CLI env.
pub fn without_sidecar_copy(config: Option<&str>) -> Result<String, serde_json::Error> {
    let mut patch: Map<String, Value> = serde_json::from_str(config.unwrap_or("{}"))?;
    let mut bundle: Map<String, Value> = serde_json::from_value(
        patch
            .remove("bundle")
            .unwrap_or_else(|| serde_json::json!({})),
    )?;
    bundle.insert("externalBin".into(), serde_json::json!([]));
    patch.insert("bundle".into(), Value::Object(bundle));
    serde_json::to_string(&patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Catches: default Cargo builds copying real or placeholder sidecars back
    // over the freshly linked workspace executable.
    #[test]
    fn standalone_builds_never_copy_staged_sidecars_into_target() {
        let patch: Value = serde_json::from_str(&without_sidecar_copy(None).unwrap()).unwrap();
        assert_eq!(patch, serde_json::json!({"bundle": {"externalBin": []}}));
    }

    // Catches: an explicit Tauri CLI override bypassing the one-way policy,
    // or its unrelated bundle and application settings being discarded.
    #[test]
    fn cli_overrides_keep_packaging_settings_without_reverse_copy() {
        let config = r#"{"bundle":{"externalBin":["binaries/tuic-bridge"],"targets":["app"],"resources":["icons/32x32.png"]},"build":{"devUrl":"http://localhost:1420"},"identifier":"com.tuic.commander"}"#;
        let patch: Value =
            serde_json::from_str(&without_sidecar_copy(Some(config)).unwrap()).unwrap();
        assert_eq!(
            patch,
            serde_json::json!({
                "bundle": {"externalBin": [], "targets": ["app"], "resources": ["icons/32x32.png"]},
                "build": {"devUrl": "http://localhost:1420"},
                "identifier": "com.tuic.commander"
            })
        );
    }

    // Catches: malformed CLI configuration silently replaced by defaults.
    #[test]
    fn malformed_cli_overrides_fail_instead_of_being_discarded() {
        for config in ["{", "[]", r#"{"bundle":"invalid"}"#] {
            assert!(without_sidecar_copy(Some(config)).is_err(), "{config}");
        }
    }
}
