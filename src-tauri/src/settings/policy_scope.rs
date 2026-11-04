//! Boss-approved host policy. Catalogue annotations cannot expand confirmation authority.
use super::super::model::Field;
use serde_json::Value;

pub(super) fn requires_confirmation(fields: &[&Field], latest: &Value, next: &Value) -> bool {
    fields
        .iter()
        .any(|field| match (field.store.as_str(), field.path.as_str()) {
            (
                "app",
                "/ego_executable"
                | "/ai_chat_launches/{key}/executable"
                | "/custom_launchers/{id}/executable"
                | "/custom_launchers/{id}/args"
                | "/custom_launchers/{id}/enabled",
            ) => true,
            ("app", path) => [
                "/services/server/",
                "/services/auth/",
                "/services/tls/",
                "/services/relay/",
            ]
            .iter()
            .any(|prefix| path.starts_with(prefix)),
            (
                "tunnels",
                "/profiles/{id}/port" | "/profiles/{id}/auto_connect" | "/profiles/{id}/forwards",
            ) => true,
            (
                "upstreams",
                "/servers/{id}/enabled"
                | "/servers/{id}/transport/type"
                | "/servers/{id}/transport/command"
                | "/servers/{id}/transport/args"
                | "/servers/{id}/transport/cwd"
                | "/servers/{id}/transport/env/{key}",
            ) => stdio_changed(latest, next),
            _ => false,
        })
}

fn stdio_changed(latest: &Value, next: &Value) -> bool {
    fn rows(value: &Value) -> &[Value] {
        value["servers"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
    let paths = [
        "/enabled",
        "/transport/type",
        "/transport/command",
        "/transport/args",
        "/transport/cwd",
        "/transport/env",
    ];
    rows(latest).iter().chain(rows(next)).any(|record| {
        if record.pointer("/transport/type").and_then(Value::as_str) != Some("stdio") {
            return false;
        }
        let find = |value: &Value| {
            rows(value)
                .iter()
                .find(|row| row["id"] == record["id"])
                .cloned()
        };
        let before = find(latest);
        let after = find(next);
        paths.iter().any(|path| {
            before.as_ref().and_then(|row| row.pointer(path))
                != after.as_ref().and_then(|row| row.pointer(path))
        })
    })
}
