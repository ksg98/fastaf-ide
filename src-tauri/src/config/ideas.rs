//! One locked writer for UI deltas and planner Ideas. Never replace a stale notes array.
use super::{ConfigFile, NOTES_FILE, apply_typed_json_merge_delta, json_merge_delta};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Ideas carry the registered UI key, not the filesystem's canonical spelling.
/// Keep filesystem identity separate so existing canonical rows and symlink aliases
/// resolve to that same key without changing Progress or story database ownership.
struct RepositoryIdentities(HashMap<String, String>);

impl RepositoryIdentities {
    fn load() -> Self {
        let repositories = super::load_repositories();
        let mut identities = HashMap::new();
        if let Some(repos) = repositories.get("repos").and_then(Value::as_object) {
            for registered in repos.keys() {
                identities.insert(Self::filesystem_key(registered), registered.clone());
            }
        }
        Self(identities)
    }

    fn filesystem_key(path: &str) -> String {
        let canonical = std::fs::canonicalize(path);
        let spelling = canonical
            .as_ref()
            .map(|path| path.to_string_lossy())
            .unwrap_or_else(|_| std::borrow::Cow::Borrowed(path));
        tuic_core::path_spelling::portable_spelling(&spelling)
    }

    fn resolve(&self, path: &str) -> String {
        self.0
            .get(&Self::filesystem_key(path))
            .cloned()
            .unwrap_or_else(|| path.to_owned())
    }

    fn normalize_row(&self, row: &mut Value) {
        if let Some(path) = row.get("repoPath").and_then(Value::as_str) {
            row["repoPath"] = self.resolve(path).into();
        }
    }
}

pub(super) fn load_notes() -> Result<Value, String> {
    let mut document: Value = super::load_json_config_strict(NOTES_FILE)?;
    let identities = RepositoryIdentities::load();
    if let Some(rows) = document.get_mut("notes").and_then(Value::as_array_mut) {
        for row in rows {
            identities.normalize_row(row);
        }
    }
    Ok(document)
}

fn notes(document: &Value) -> Result<Vec<Value>, String> {
    let rows = match document.get("notes") {
        None => return Ok(vec![]),
        Some(Value::Array(rows)) => rows.clone(),
        _ => return Err("invalid ideas document: notes must be an array".into()),
    };
    let mut ids = std::collections::HashSet::new();
    for row in &rows {
        let id = row["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("invalid idea: missing id")?;
        if !ids.insert(id.to_owned()) {
            return Err("invalid idea: duplicate id".into());
        }
    }
    Ok(rows)
}

fn set_notes(document: &mut Value, rows: Vec<Value>) -> Result<(), String> {
    if document.is_null() {
        *document = json!({});
    }
    let object = document
        .as_object_mut()
        .ok_or("invalid ideas document: expected object")?;
    object.insert("notes".into(), Value::Array(rows));
    Ok(())
}

pub(super) fn save_notes(base: Value, desired: Value) -> Result<(), String> {
    let before = notes(&base)?;
    let after = notes(&desired)?;
    // Other legacy document fields retain their existing merge-patch semantics.
    let mut old_metadata = base.clone();
    let mut new_metadata = desired.clone();
    if let Some(object) = old_metadata.as_object_mut() {
        object.remove("notes");
    }
    if let Some(object) = new_metadata.as_object_mut() {
        object.remove("notes");
    }
    let metadata_delta = json_merge_delta(&old_metadata, &new_metadata);
    ConfigFile::<Value>::new(NOTES_FILE).update_with_strict(|latest| {
        let original = latest.clone();
        if base.get("notes") != desired.get("notes") {
            let mut rows = notes(latest)?;
            // Absence in a stale snapshot is not a delete. Only remove ids this client saw.
            rows.retain(|row| {
                !before.iter().any(|old| old["id"] == row["id"])
                    || after.iter().any(|new| new["id"] == row["id"])
            });
            let mut additions = vec![];
            for new in &after {
                if let Some(old) = before.iter().find(|old| old["id"] == new["id"]) {
                    if let Some(current) = rows.iter_mut().find(|row| row["id"] == new["id"])
                        && let Some(delta) = json_merge_delta(old, new)
                    {
                        apply_typed_json_merge_delta(current, &delta)?;
                    }
                    // A remote deletion wins over an edit; never resurrect its assets.
                } else if let Some(current) = rows.iter().find(|row| row["id"] == new["id"]) {
                    if current != new {
                        return Err("invalid idea: id already exists".into());
                    }
                } else {
                    additions.push(new.clone());
                }
            }
            additions.extend(rows);
            set_notes(latest, additions)?;
        }
        if let Some(delta) = &metadata_delta {
            apply_typed_json_merge_delta(latest, delta)?;
        }
        Ok(((), *latest != original))
    })
}

fn text(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 16000 {
        return Err("invalid idea: text must contain 1 to 16000 characters".into());
    }
    Ok(value)
}

pub(crate) fn add_idea(project: &str, content: &str, source: &str) -> Result<Value, String> {
    let content = text(content)?;
    let source = source.trim();
    if source.is_empty() || source.chars().count() > 256 {
        return Err("invalid idea: source must contain 1 to 256 characters".into());
    }
    let project = RepositoryIdentities::load().resolve(project);
    let idea = json!({
        "id": format!("note-{}", uuid::Uuid::new_v4()),
        "text": content, "createdAt": chrono::Utc::now().timestamp_millis(),
        "repoPath": project,
        "repoDisplayName": std::path::Path::new(&project).file_name().map(|s| s.to_string_lossy().into_owned()),
        "usedAt": null, "images": [], "source": source,
    });
    ConfigFile::<Value>::new(NOTES_FILE).update_with_strict(|document| {
        let mut rows = notes(document)?;
        rows.insert(0, idea.clone());
        set_notes(document, rows)?;
        Ok((idea, true))
    })
}

pub(crate) fn list_ideas(project: &str) -> Result<Vec<Value>, String> {
    let project = RepositoryIdentities::load().resolve(project);
    Ok(notes(&super::load_notes()?)?
        .into_iter()
        .filter(|row| row["repoPath"].is_null() || row["repoPath"] == project)
        .collect())
}

pub(crate) fn update_idea(project: &str, id: &str, content: &str) -> Result<Value, String> {
    let content = text(content)?;
    let identities = RepositoryIdentities::load();
    let project = identities.resolve(project);
    ConfigFile::<Value>::new(NOTES_FILE).update_with_strict(|document| {
        let mut rows = notes(document)?;
        let row = rows
            .iter_mut()
            .find(|row| row["id"] == id)
            .ok_or("invalid idea: id not found")?;
        identities.normalize_row(row);
        if row["repoPath"] != project {
            return Err("invalid idea: does not belong to project".into());
        }
        let changed = row["text"] != content;
        row["text"] = content.into();
        let result = row.clone();
        set_notes(document, rows)?;
        Ok((result, changed))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stories::{StoryAction, StoryReply, story_action};

    fn call(project: &str, value: Value) -> StoryReply {
        story_action(
            project,
            serde_json::from_value(value).unwrap(),
            Some("agent-session"),
        )
        .unwrap()
    }

    /// Catches: canonical and registered aliases split agent and panel Ideas.
    #[test]
    fn agent_and_ui_ideas_share_registered_repo_identity() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = super::super::set_config_dir_override(dir.path().into());
        let repo = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let other = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        #[cfg(unix)]
        let registered = {
            let alias = dir.path().join("registered-alias");
            std::os::unix::fs::symlink(repo.path(), &alias).unwrap();
            alias.to_string_lossy().into_owned()
        };
        #[cfg(not(unix))]
        let registered =
            tuic_core::path_spelling::portable_spelling(&repo.path().to_string_lossy());
        let canonical = repo
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let workspace = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        super::super::replace_repositories_for_test(json!({"repos": {
            &registered: {"workspaces": {"worker": {
                "worktreePath": workspace.path(), "parentRepoPath": registered
            }}}
        }}))
        .unwrap();
        // Existing UI and older canonical rows must both reach the exact panel filter.
        super::super::save_notes(
            json!({}),
            json!({"notes": [
                {"id":"ui", "repoPath":registered, "text":"UI idea", "images":["asset"]},
                {"id":"legacy", "repoPath":canonical, "text":"Older agent idea"},
                {"id":"global", "repoPath":null, "text":"Global"},
                {"id":"other", "repoPath":other.path(), "text":"Other"}
            ]}),
        )
        .unwrap();
        let StoryReply::Idea(added) =
            call(&canonical, json!({"action":"add_idea","text":"Agent idea"}))
        else {
            panic!("idea")
        };
        assert_eq!(
            added["repoPath"], registered,
            "agent addition must reach the registered panel"
        );
        let loaded = super::super::load_notes().unwrap();
        let panel_ids: Vec<_> = loaded["notes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["repoPath"].is_null() || row["repoPath"] == registered)
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            panel_ids,
            vec![added["id"].as_str().unwrap(), "ui", "legacy", "global"]
        );
        for project in [
            registered.as_str(),
            canonical.as_str(),
            workspace.path().to_str().unwrap(),
        ] {
            let StoryReply::Ideas(listed) = call(project, json!({"action":"list_ideas"})) else {
                panic!("ideas")
            };
            assert_eq!(listed.len(), 4);
            for id in ["ui", "legacy"] {
                let StoryReply::Idea(updated) = call(
                    project,
                    json!({"action":"update_idea","idea_id":id,"text":"Edited"}),
                ) else {
                    panic!("idea")
                };
                assert_eq!(updated["text"], "Edited");
                assert_eq!(updated["repoPath"], registered);
                if id == "ui" {
                    assert_eq!(updated["images"], json!(["asset"]));
                }
            }
        }
        for id in ["ui", "legacy", "global"] {
            assert!(
                story_action(
                    other.path().to_str().unwrap(),
                    StoryAction::UpdateIdea {
                        idea_id: id.into(),
                        text: "Wrong project".into()
                    },
                    None
                )
                .is_err()
            );
        }
        assert!(
            story_action(
                &registered,
                StoryAction::UpdateIdea {
                    idea_id: "global".into(),
                    text: "Cannot edit global".into()
                },
                None
            )
            .is_err()
        );
    }

    /// Catches: a stale panel's array save erases an agent addition or text update.
    #[test]
    fn planner_ideas_survive_stale_panel_save() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = super::super::set_config_dir_override(dir.path().into());
        let repo = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let project = repo.path().to_str().unwrap();
        let StoryReply::Idea(original) =
            call(project, json!({"action":"add_idea","text":"Original"}))
        else {
            panic!("idea")
        };
        let base = super::super::load_notes().unwrap();
        let StoryReply::Idea(added) = call(
            project,
            json!({"action":"add_idea","text":"Agent addition","source":"planner"}),
        ) else {
            panic!("idea")
        };
        call(
            project,
            json!({"action":"update_idea","idea_id":original["id"],"text":"Agent edit"}),
        );
        let mut stale = base.clone();
        stale["notes"][0]["usedAt"] = 123.into();
        super::super::save_notes(base.clone(), stale).unwrap();
        let persisted = super::super::load_notes().unwrap();
        assert_eq!(persisted["notes"][0], added);
        assert_eq!(persisted["notes"][1]["text"], "Agent edit");
        assert_eq!(persisted["notes"][1]["usedAt"], 123);
        assert_eq!(persisted["notes"][1]["source"], "agent-session");
        // A stale explicit removal deletes only the id it knew, not the added idea.
        super::super::save_notes(base, json!({"notes":[]})).unwrap();
        assert_eq!(super::super::load_notes().unwrap()["notes"], json!([added]));
    }

    /// Catches: planner scoping or a text update losing source, metadata or global visibility.
    #[test]
    fn planner_ideas_are_scoped_and_validate_before_writing() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = super::super::set_config_dir_override(dir.path().into());
        let repo = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let other = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let project = repo.path().to_str().unwrap();
        let StoryReply::Idea(idea) = call(
            project,
            json!({"action":"add_idea","text":"  Repo idea  ","source":"ego"}),
        ) else {
            panic!("idea")
        };
        assert_eq!(idea["text"], "Repo idea");
        assert_eq!(
            idea["repoPath"],
            crate::progress::resolve_owning_project(Some(project))
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(idea["source"], "ego");
        assert!(idea["id"].as_str().unwrap().starts_with("note-"));
        assert!(idea["createdAt"].as_i64().unwrap() > 0);
        let baseline = super::super::load_notes().unwrap();
        for value in [
            json!({"action":"add_idea","text":" "}),
            json!({"action":"add_idea","text":"x","source":" "}),
            json!({"action":"update_idea","idea_id":"missing","text":"x"}),
        ] {
            let action: StoryAction = serde_json::from_value(value).unwrap();
            assert!(story_action(project, action, None).is_err());
        }
        assert!(
            story_action(
                other.path().to_str().unwrap(),
                serde_json::from_value(
                    json!({"action":"update_idea","idea_id":idea["id"],"text":"wrong"})
                )
                .unwrap(),
                None
            )
            .is_err()
        );
        assert_eq!(super::super::load_notes().unwrap(), baseline);
        let mut with_global = baseline.clone();
        with_global["notes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"global","repoPath":null,"text":"Global"}));
        super::super::save_notes(baseline, with_global).unwrap();
        let StoryReply::Ideas(visible) = call(
            other.path().to_str().unwrap(),
            json!({"action":"list_ideas"}),
        ) else {
            panic!("ideas")
        };
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0]["id"], "global");
        let StoryReply::Idea(updated) = call(
            project,
            json!({"action":"update_idea","idea_id":idea["id"],"text":"Changed"}),
        ) else {
            panic!("idea")
        };
        let mut expected = idea;
        expected["text"] = "Changed".into();
        assert_eq!(updated, expected);
    }
}
