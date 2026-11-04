//! Process-local, sanitized activity readback. Never persisted with Telegram setup/status.
use serde::Serialize;
use std::{collections::VecDeque, sync::LazyLock};

#[derive(Clone, Serialize)]
pub(crate) struct Event {
    id: u64,
    time: u64,
    direction: &'static str,
    kind: &'static str,
    outcome: String,
    preview: String,
}

#[derive(Default)]
pub(crate) struct Recent {
    sequence: u64,
    events: VecDeque<Event>,
}

static CREDENTIAL: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"[0-9]+:[A-Za-z0-9_-]+|[A-Fa-f0-9]{6}").unwrap());

impl Recent {
    pub(super) fn record(
        &mut self,
        direction: &'static str,
        kind: &'static str,
        outcome: impl Into<String>,
        text: Option<&str>,
    ) {
        // Redact before truncation: cutting a credential first could hide its signature.
        let preview = text
            .map(|text| {
                let safe = crate::redaction::redact_secrets(text);
                CREDENTIAL
                    .replace_all(&safe, "[redacted]")
                    .chars()
                    .take(60)
                    .collect()
            })
            .unwrap_or_else(|| "[redacted]".into());
        self.sequence += 1;
        if self.events.len() == 20 {
            self.events.pop_back();
        }
        self.events.push_front(Event {
            id: self.sequence,
            time: super::settings::now_ms(),
            direction,
            kind,
            outcome: outcome.into(),
            preview,
        });
    }

    pub(super) fn snapshot(&self) -> Vec<Event> {
        self.events.iter().cloned().collect()
    }
}
