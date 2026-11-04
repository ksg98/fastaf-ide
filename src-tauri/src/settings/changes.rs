//! Value-free invalidation cursor. CAS revisions remain owned by each store.
#[derive(Clone, Debug, serde::Serialize)]
pub struct SettingsChanged {
    pub section: String,
    pub generation: u64,
    pub persisted: bool,
    pub applied: bool,
}

/// Host-scoped invalidation authority for background owners. No global registry
/// and no strong cycle back from an upstream client to its AppState.
#[derive(Clone, Default)]
pub(crate) struct Publisher(std::sync::Weak<crate::AppState>);
impl Publisher {
    pub(crate) fn new(state: &std::sync::Arc<crate::AppState>) -> Self {
        Self(std::sync::Arc::downgrade(state))
    }
    pub(crate) fn publish(&self, section: &str, applied: bool) {
        if let Some(state) = self.0.upgrade() {
            super::api::publish_change(&state, section, applied);
        }
    }
}

#[cfg(test)]
mod tests {
    // Catches: facade and legacy owner notices fail to invalidate the MCP catalogue.
    #[test]
    fn conditional_owner_settings_changes_notify_tools() {
        let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
        let mut notices = state.mcp.tools_changed.subscribe();
        for section in ["voice", "telegram"] {
            super::Publisher::new(&state).publish(section, true);
            assert!(notices.try_recv().is_ok(), "{section}");
        }
        super::Publisher::new(&state).publish("appearance", true);
        assert!(notices.try_recv().is_err());
    }

    // Catches: background invalidation authority retaining the host or bypassing its shared publisher.
    #[test]
    fn background_publishers_use_host_generation_without_retaining_host() {
        let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
        state.wire_event_bus();
        let mut events = state.event_bus.subscribe();
        state
            .mcp
            .oauth_flow_manager
            .settings_publisher
            .read()
            .publish("upstreams", true);
        state
            .mcp
            .upstream_registry
            .settings_publisher
            .read()
            .publish("upstreams", false);
        let notices: Vec<_> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                crate::state::AppEvent::SettingsChanged(notice) => Some(notice),
                _ => None,
            })
            .collect();
        assert_eq!(notices.len(), 2);
        assert!(notices[0].generation < notices[1].generation);
        assert!(
            notices
                .iter()
                .all(|notice| notice.section == "upstreams" && notice.persisted)
        );
        assert!(notices[0].applied);
        assert!(!notices[1].applied);
        let publisher = state
            .mcp
            .oauth_flow_manager
            .settings_publisher
            .read()
            .clone();
        let weak = std::sync::Arc::downgrade(&state);
        drop(state);
        assert!(
            weak.upgrade().is_none(),
            "background publisher must not retain AppState"
        );
        publisher.publish("upstreams", true);
    }
}
