//! App choices reuse bundled font options, the theme owner and explicit host IDE discovery.
use super::{catalogue::Catalogue, model::*, request::*};
use serde_json::{Value, json};
use std::path::Path;

pub(super) fn options() -> Value {
    serde_json::from_str(include_str!("app_choice_options.json")).expect("checked app options")
}

pub(super) fn register(cat: &mut Catalogue) {
    cat.fields
        .get_mut("app.font_family")
        .expect("font field")
        .choices = Some(Choices::Static {
        values: options()["fonts"]
            .as_object()
            .expect("font options")
            .keys()
            .map(|s| json!(s))
            .collect(),
    });
    for (id, resolver) in [("app.theme", "themes"), ("app.ide", "installed_ides")] {
        cat.fields.get_mut(id).expect("app choice field").choices = Some(Choices::Dynamic {
            resolver: resolver.into(),
            availability: Availability::Available,
            values: None,
        });
    }
}

pub(super) fn theme_choices(dir: &Path) -> Result<Vec<Value>, Failure> {
    // Missing or unreadable owner is unavailable, not a successful empty catalogue.
    std::fs::read_dir(dir).map_err(|_| Error::new("app", "unavailable"))?;
    Ok(crate::themes::load_themes(dir)
        .into_iter()
        .map(|theme| json!({"value":theme.key,"label":theme.name}))
        .collect())
}

pub(crate) async fn refresh(resolver: &str) -> Result<Vec<Value>, Failure> {
    match resolver {
        "themes" => tokio::task::spawn_blocking(|| {
            theme_choices(&crate::config::config_dir().join("themes"))
        })
        .await
        .map_err(|_| Error::new("app", "unavailable"))?,
        "installed_ides" => tokio::task::spawn_blocking(|| {
            let options = options();
            crate::agent::detect_installed_ides()
                .into_iter()
                .filter_map(|id| {
                    options["ides"]
                        .get(&id)
                        .map(|label| json!({"value":id,"label":label}))
                })
                .collect()
        })
        .await
        .map_err(|_| Error::new("app", "unavailable")),
        _ => Err(Error::new("app", "unavailable")),
    }
}

pub(crate) fn validate(value: &Value) -> Result<(), Failure> {
    let options = options();
    for (key, choices) in [("font_family", "fonts"), ("ide", "ides")] {
        let selected = value[key]
            .as_str()
            .ok_or_else(|| Error::new("app", "invalid_type"))?;
        // Empty IDE is the existing default; selecting it retains the UI fallback.
        if key == "ide" && selected.is_empty() {
            continue;
        }
        if options[choices].get(selected).is_none() {
            return Err(Error::new("app", "out_of_range"));
        }
    }
    let theme = value["theme"]
        .as_str()
        .ok_or_else(|| Error::new("app", "invalid_type"))?;
    if theme.is_empty()
        || theme.len() > 256
        || theme.contains(['/', '\\'])
        || matches!(theme, "." | "..")
    {
        return Err(Error::new("app", "out_of_range"));
    }
    Ok(())
}
