//! Source-specific parsing; all adapters emit the same ACP updates.

use serde_json::Value;

use super::Agent;
use super::claude::{AdapterStats, ClaudeAdapter};
use super::codex::CodexAdapter;
use super::ego::EgoAdapter;
use super::grok::GrokAdapter;

pub(super) enum TranscriptAdapter {
    Claude(ClaudeAdapter),
    Codex(CodexAdapter),
    Grok(GrokAdapter),
    Ego(EgoAdapter),
}

impl TranscriptAdapter {
    pub(super) fn for_agent(agent: Agent) -> Self {
        match agent {
            Agent::Codex => Self::Codex(CodexAdapter::default()),
            Agent::Claude => Self::Claude(ClaudeAdapter::default()),
            Agent::Grok => Self::Grok(GrokAdapter::default()),
            Agent::Ego => Self::Ego(EgoAdapter::default()),
        }
    }

    pub(super) fn absorb(&mut self, line: &str) -> Vec<Value> {
        match self {
            Self::Claude(adapter) => adapter.absorb(line),
            Self::Codex(adapter) => adapter.absorb(line),
            Self::Grok(adapter) => adapter.absorb(line),
            Self::Ego(adapter) => adapter.absorb(line),
        }
    }

    pub(super) fn stats(&self) -> AdapterStats {
        match self {
            Self::Claude(adapter) => adapter.stats,
            Self::Codex(adapter) => adapter.stats,
            Self::Grok(adapter) => adapter.stats,
            Self::Ego(adapter) => adapter.stats,
        }
    }
}
