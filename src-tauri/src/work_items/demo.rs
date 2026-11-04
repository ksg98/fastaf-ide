//! Explicitly synthetic local data, shared by development UI adapters and tests.
use super::{fake::InMemoryWorkItemProvider, model::*, protocol::*};

pub(super) fn user() -> WorkItemUser {
    WorkItemUser {
        id: "demo-user".into(),
        name: "Demo User".into(),
        avatar_url: None,
        bot: false,
    }
}

pub(super) fn actions() -> Vec<WorkItemActionDescriptor> {
    [
        ("edit", "Edit field", WorkItemActionKind::EditField),
        ("closed", "Closed", WorkItemActionKind::Transition),
        ("open", "Open", WorkItemActionKind::Transition),
        ("comment", "Comment", WorkItemActionKind::Comment),
        ("start", "Start work", WorkItemActionKind::StartWork),
    ]
    .into_iter()
    .map(|(id, name, kind)| WorkItemActionDescriptor {
        id: id.into(),
        name: name.into(),
        kind,
        enabled: true,
        disabled_reason: None,
    })
    .collect()
}

/// No credentials, filesystem, network, clock or subprocesses are touched.
pub fn demo_provider() -> InMemoryWorkItemProvider {
    let snapshot: WorkItemProviderSnapshot = serde_json::from_str(include_str!("demo.json"))
        .expect("committed local demo fixture satisfies the shared contract");
    let mut provider =
        InMemoryWorkItemProvider::new(snapshot.provider_id, snapshot.account_id, snapshot.fields);
    provider.saved_filters = snapshot.saved_filters;
    provider.boards = snapshot.boards;
    for detail in snapshot.items {
        provider
            .items
            .insert(detail.item.reference.id.clone(), detail);
    }
    provider.next_id = 4;
    provider
}
