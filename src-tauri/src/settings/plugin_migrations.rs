//! Host-owned migrations let existing plugins keep their current config readers.
use super::plugin_schema::Definition;
use schemars::JsonSchema;
use serde::Serialize;

#[path = "plugin_automation_schema.rs"]
mod automation;
#[path = "plugin_private_schema.rs"]
mod private;

fn definition<T: Default + Serialize + JsonSchema>() -> Definition {
    Definition {
        schema: super::catalogue::schema::<T>(),
        defaults: serde_json::to_value(T::default()).expect("typed plugin defaults serialize"),
    }
}

pub(crate) fn for_plugin(id: &str) -> Option<Definition> {
    match id {
        "at-capacity-retry" => Some(definition::<automation::Capacity>()),
        "cache-keepalive" => Some(definition::<automation::Keepalive>()),
        "claude-wakeup" => Some(definition::<automation::Wakeup>()),
        "build-cleaner" => Some(definition::<private::BuildCleaner>()),
        "telegram-notifier" => Some(definition::<private::TelegramNotifier>()),
        _ => None,
    }
}
