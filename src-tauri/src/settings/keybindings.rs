//! Stable action/key records retain the existing keybindings.json array format.
use super::{catalogue::Catalogue, model::*, request::*};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Keybinding {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Identifies a built-in or plugin shortcut action.","operations":["get"],"confirmationClass":"ordinary"}))]
    pub action: String,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates the shortcut override; null disables the action.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    #[schemars(length(max = 128))]
    pub key: Option<String>,
}
#[derive(Default, Serialize, schemars::JsonSchema)]
pub(super) struct Bindings {
    #[schemars(extend("x-collection-key" = "action"))]
    pub bindings: Vec<Keybinding>,
}

pub fn actions() -> Vec<String> {
    serde_json::from_str(include_str!("keybinding_actions.json")).expect("checked action inventory")
}

pub fn validate(bindings: &[Keybinding]) -> Result<(), Failure> {
    let fail = || Error::new("keybindings", "out_of_range");
    let mut seen = BTreeSet::new();
    if bindings.len() > 4096 {
        return Err(fail());
    }
    for binding in bindings {
        super::pointer::valid_key(&binding.action, "keybindings")?;
        if !seen.insert(&binding.action) {
            return Err(fail());
        }
        if let Some(key) = &binding.key {
            if key.len() > 128 || key.chars().any(char::is_control) {
                return Err(fail());
            }
            if key.is_empty() {
                continue;
            }
            let mut parts: Vec<_> = key.split('+').collect();
            let key = parts.pop().unwrap_or_default();
            if key.is_empty() && parts.last() == Some(&"") {
                parts.pop();
            }
            let mut modifiers = BTreeSet::new();
            for modifier in parts {
                let modifier = modifier.to_ascii_lowercase();
                if !["cmd", "ctrl", "shift", "alt", "meta"].contains(&modifier.as_str())
                    || !modifiers.insert(modifier)
                {
                    return Err(fail());
                }
            }
            // A trailing '+' is the plus key (Cmd++); modifier-free text is also valid.
            if key.is_empty() && !binding.key.as_ref().is_some_and(|key| key.ends_with("++")) {
                return Err(fail());
            }
        }
    }
    Ok(())
}

pub(super) fn register(cat: &mut Catalogue) -> Result<(), CatalogueError> {
    cat.register(
        "keybindings",
        "instance",
        Some(&Bindings::default()),
        Availability::Available,
    )?;
    cat.fields
        .get_mut("keybindings.bindings.{action}.action")
        .expect("action descriptor")
        .choices = Some(Choices::Dynamic {
        resolver: "keybinding_actions".into(),
        values: None,
        availability: Availability::Unavailable {
            reason: "no frontend has published its registered plugin actions".into(),
        },
    });
    Ok(())
}
