//! Typed pane geometry; tab membership and focus remain session restoration state.
use super::{catalogue::Catalogue, model::*, request::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_SPLIT_DEPTH: usize = 3;
pub const MIN_PANE_RATIO: f64 = 0.05;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum PaneNode {
    Leaf {
        id: String,
    },
    Branch {
        direction: Direction,
        children: Vec<PaneNode>,
        ratios: Vec<f64>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Horizontal,
    Vertical,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TabType {
    Terminal,
    Markdown,
    Diff,
    Editor,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PaneTab {
    pub id: String,
    pub r#type: TabType,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaneGroup {
    pub id: String,
    pub tabs: Vec<PaneTab>,
    pub active_tab_id: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct PaneLayout {
    pub root: Option<PaneNode>,
    pub groups: BTreeMap<String, PaneGroup>,
    pub active_group_id: Option<String>,
}

impl PaneLayout {
    pub fn validate(&self) -> Result<(), Failure> {
        let fail = || Error::new("pane_layout", "out_of_range");
        fn walk(node: &PaneNode, depth: usize, ids: &mut BTreeSet<String>) -> Result<(), Failure> {
            let fail = || Error::new("pane_layout", "out_of_range");
            if depth > MAX_SPLIT_DEPTH {
                return Err(fail());
            }
            match node {
                PaneNode::Leaf { id } => {
                    super::pointer::valid_key(id, "pane_layout")?;
                    if !ids.insert(id.clone()) {
                        return Err(fail());
                    }
                }
                PaneNode::Branch {
                    children, ratios, ..
                } => {
                    if !(2..=20).contains(&children.len())
                        || children.len() != ratios.len()
                        || ratios
                            .iter()
                            .any(|r| !r.is_finite() || *r < MIN_PANE_RATIO - f64::EPSILON)
                        || (ratios.iter().sum::<f64>() - 1.0).abs() > 0.000001
                    {
                        return Err(fail());
                    }
                    for child in children {
                        walk(child, depth + 1, ids)?;
                    }
                }
            }
            Ok(())
        }
        let mut ids = BTreeSet::new();
        if let Some(root) = &self.root {
            walk(root, 0, &mut ids)?;
        }
        if ids.len() != self.groups.len()
            || ids.iter().any(|id| !self.groups.contains_key(id))
            || self
                .active_group_id
                .as_ref()
                .is_some_and(|id| !ids.contains(id))
        {
            return Err(fail());
        }
        for (id, group) in &self.groups {
            if id != &group.id || group.tabs.len() > 1024 {
                return Err(fail());
            }
            let mut tabs = BTreeSet::new();
            for tab in &group.tabs {
                super::pointer::valid_key(&tab.id, "pane_layout")?;
                if !tabs.insert(&tab.id) {
                    return Err(fail());
                }
            }
            if group
                .active_tab_id
                .as_ref()
                .is_some_and(|id| !tabs.contains(id))
            {
                return Err(fail());
            }
        }
        Ok(())
    }
}

/// An atomic, structured geometry leaf: bounded expansion avoids recursive $ref handling.
fn node_schema(depth: usize) -> Value {
    let leaf = json!({"type":"object","additionalProperties":false,"required":["type","id"],"properties":{"type":{"const":"leaf"},"id":{"type":"string","minLength":1,"maxLength":256}}});
    if depth == MAX_SPLIT_DEPTH {
        return leaf;
    }
    json!({"oneOf":[leaf,{"type":"object","additionalProperties":false,"required":["type","direction","children","ratios"],"properties":{"type":{"const":"branch"},"direction":{"enum":["horizontal","vertical"]},"children":{"type":"array","minItems":2,"maxItems":20,"items":node_schema(depth+1)},"ratios":{"type":"array","minItems":2,"maxItems":20,"items":{"type":"number","minimum":MIN_PANE_RATIO,"maximum":1}}}}]})
}

pub(super) fn register(cat: &mut Catalogue) {
    let id = "pane_layout.root".to_owned();
    cat.fields.insert(
        id.clone(),
        Field {
            id: id.clone(),
            store: "pane_layout".into(),
            owner: "instance".into(),
            area: "pane_layout".into(),
            group: "geometry".into(),
            order: 0,
            path: "/root".into(),
            label_key: format!("settings.catalogue.{id}.label"),
            help_key: format!("settings.catalogue.{id}.help"),
            label: "Pane geometry".into(),
            schema: json!({"anyOf":[node_schema(0),{"type":"null"}]}),
            nullable: true,
            default: Some(Value::Null),
            availability: Availability::Available,
            choices: None,
            annotation: Annotation {
                sensitivity: Sensitivity::Public,
                apply: ApplyMode::Live,
                effect: "Updates pane geometry without changing tab membership or focus.".into(),
                operations: vec![Operation::Get, Operation::Set],
                confirmation_class: "ordinary".into(),
            },
        },
    );
    for (path, reason) in [
        (
            "/groups/{id}/id",
            "Session restoration identity referenced by geometry; not a user preference.",
        ),
        (
            "/groups/{id}/tabs",
            "Runtime terminal/editor/diff/markdown tab identities; remapped when sessions restore.",
        ),
        (
            "/groups/{id}/activeTabId",
            "Runtime selected tab, restored with session membership.",
        ),
        (
            "/activeGroupId",
            "Runtime focused group, updated by focus and navigation, not a user preference.",
        ),
    ] {
        cat.exclusions.push(Exclusion {
            store: "pane_layout".into(),
            path: path.into(),
            reason: reason.into(),
        });
    }
}
