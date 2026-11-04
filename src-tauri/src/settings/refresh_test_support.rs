//! Valid edits shared by legacy and HTTP refresh-publication contracts.
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;

pub(crate) fn edited<T: Serialize + DeserializeOwned>(section: &str, base: &T) -> T {
    let mut value = serde_json::to_value(base).unwrap();
    match section {
        "notifications" => value["enabled"] = json!(!value["enabled"].as_bool().unwrap()),
        "preferences" => value["sidebar_width"] = json!(321),
        "repositories" => {
            let entry = crate::config::RepoSettingsEntry {
                path: "/fixture".into(),
                ..Default::default()
            };
            value["repos"]["/fixture"] = serde_json::to_value(entry).unwrap();
        }
        "repo_defaults" => value["base_branch"] = json!("review-base"),
        "prompts" => {
            value["prompts"] = json!([{"id":"review-fixture","label":"Fixture","text":"Fixture text","pinned":false}])
        }
        "agents" => value["hibernate_idle_minutes"] = json!(37),
        "keybindings" => value = json!([{"action":"new-terminal","key":"Ctrl+Shift+C"}]),
        "pane_layout" => value = json!({"groups":{}}),
        _ => panic!("missing settings refresh fixture"),
    }
    serde_json::from_value(value).unwrap()
}
