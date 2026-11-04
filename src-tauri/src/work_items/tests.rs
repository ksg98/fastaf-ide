use super::{demo::demo_provider, fake::WorkItemError, model::*, protocol::*};
use serde_json::json;

fn query(limit: u32) -> WorkItemQuery {
    WorkItemQuery {
        limit,
        ..Default::default()
    }
}
fn reference(id: &str) -> WorkItemRef {
    WorkItemRef {
        provider_id: "demo".into(),
        account_id: "local".into(),
        id: id.into(),
    }
}

// Catches: pagination skips/duplicates rows or reuses a cursor from a different search.
#[test]
fn list_pages_presets_search_and_sort_keep_query_boundaries() {
    let provider = demo_provider();
    let mut request = query(1);
    let first = provider.list(&request).unwrap();
    assert_eq!(first.items[0].key, "DEMO-1");
    request.cursor = first.next_cursor;
    let second = provider.list(&request).unwrap();
    assert_eq!(second.items[0].key, "DEMO-2");
    request.search = "transport".into();
    assert!(matches!(
        provider.list(&request),
        Err(WorkItemError::Query(_))
    ));
    request.cursor = None;
    assert_eq!(provider.list(&request).unwrap().items[0].key, "DEMO-3");
    request.search.clear();
    request.saved_filter_id = Some("high".into());
    request.limit = 50;
    assert_eq!(
        provider
            .list(&request)
            .unwrap()
            .items
            .iter()
            .map(|i| i.key.as_str())
            .collect::<Vec<_>>(),
        ["DEMO-1", "DEMO-3"]
    );
    request.saved_filter_id = None;
    request.sort = Some(WorkItemSort {
        field_id: "title".into(),
        descending: false,
    });
    assert_eq!(provider.list(&request).unwrap().items[0].key, "DEMO-2");
    for bad in [
        WorkItemQuery {
            limit: 0,
            ..query(1)
        },
        WorkItemQuery {
            cursor: Some("oops".into()),
            ..query(1)
        },
        WorkItemQuery {
            saved_filter_id: Some("missing".into()),
            ..query(1)
        },
    ] {
        assert!(matches!(provider.list(&bad), Err(WorkItemError::Query(_))));
    }
}

// Catches: identical external IDs cross account boundaries or failed edits alter stored data.
#[test]
fn scoped_identity_and_rejected_actions_preserve_detail() {
    let mut provider = demo_provider();
    let original = provider.detail(&reference("1")).unwrap();
    let mut foreign = reference("1");
    foreign.account_id = "another".into();
    assert_eq!(provider.detail(&foreign), Err(WorkItemError::NotFound));
    foreign = reference("1");
    foreign.provider_id = "another".into();
    assert_eq!(provider.detail(&foreign), Err(WorkItemError::NotFound));
    for action in [
        WorkItemAction::EditField(WorkItemEdit {
            field_id: "priority".into(),
            value: Some(WorkItemFieldValue::Text("high".into())),
        }),
        WorkItemAction::EditField(WorkItemEdit {
            field_id: "priority".into(),
            value: Some(WorkItemFieldValue::Enum("unknown".into())),
        }),
        WorkItemAction::EditField(WorkItemEdit {
            field_id: "priority".into(),
            value: None,
        }),
        WorkItemAction::Transition("missing".into()),
        WorkItemAction::Comment(" ".into()),
    ] {
        assert!(matches!(
            provider.act(Some(&reference("1")), action),
            Err(WorkItemError::Action(_))
        ));
        assert_eq!(provider.detail(&reference("1")).unwrap(), original);
    }
}

// Catches: board drop changes only the returned object or leaves a stale list page usable.
#[test]
fn board_actions_change_query_results_and_invalidate_old_cursor() {
    let mut provider = demo_provider();
    let page = provider.list(&query(1)).unwrap();
    let action = provider.boards[0].columns[1].action.clone().unwrap();
    provider.act(Some(&reference("1")), action).unwrap();
    let filtered = WorkItemQuery {
        saved_filter_id: Some("high".into()),
        ..query(50)
    };
    assert_eq!(
        provider
            .list(&filtered)
            .unwrap()
            .items
            .iter()
            .map(|i| i.key.as_str())
            .collect::<Vec<_>>(),
        ["DEMO-3"]
    );
    assert!(
        provider
            .list(&WorkItemQuery {
                cursor: page.next_cursor,
                ..query(1)
            })
            .is_err()
    );
    provider
        .act(
            Some(&reference("1")),
            WorkItemAction::Transition("closed".into()),
        )
        .unwrap();
    assert_eq!(
        provider.detail(&reference("1")).unwrap().item.state.id,
        "closed"
    );
}

// Catches: review threads lose resolution/SHA, or one comment source disappears on pagination.
#[test]
fn comments_paginate_all_sources_and_preserve_review_wire_shape() {
    let provider = demo_provider();
    let first = provider.comments(&reference("1"), None, 1).unwrap();
    assert!(matches!(first.entries[0], WorkItemCommentEntry::Normal(_)));
    let second = provider
        .comments(&reference("1"), first.next_cursor.as_deref(), 1)
        .unwrap();
    let wire = serde_json::to_value(&second.entries[0]).unwrap();
    assert_eq!(wire["kind"], "review_thread");
    assert_eq!(wire["value"]["resolved"], true);
    assert_eq!(wire["value"]["commitId"], "demo-sha");
    assert_eq!(
        serde_json::from_value::<WorkItemCommentEntry>(wire).unwrap(),
        second.entries[0]
    );
    let third = provider
        .comments(&reference("1"), second.next_cursor.as_deref(), 1)
        .unwrap();
    assert!(matches!(
        third.entries[0],
        WorkItemCommentEntry::ReviewSummary(_)
    ));
    assert_eq!(third.next_cursor, None);
    assert!(
        provider
            .comments(&reference("2"), first.next_cursor.as_deref(), 1)
            .is_err()
    );
}

// Catches: create bypasses required schema validation, or comments never persist.
#[test]
fn create_validates_required_fields_and_comment_persists() {
    let mut provider = demo_provider();
    let mut create = WorkItemCreate {
        title: "Local task".into(),
        body: "Body".into(),
        item_type: "issue".into(),
        fields: Default::default(),
    };
    assert!(
        provider
            .act(None, WorkItemAction::Create(create.clone()))
            .is_err()
    );
    create.fields.insert(
        "priority".into(),
        Some(WorkItemFieldValue::Enum("low".into())),
    );
    let WorkItemActionResult::Item(created) =
        provider.act(None, WorkItemAction::Create(create)).unwrap()
    else {
        panic!("expected created item")
    };
    assert_eq!(created.item.key, "DEMO-4");
    provider
        .act(
            Some(&created.item.reference),
            WorkItemAction::Comment("Saved **comment**".into()),
        )
        .unwrap();
    let comments = provider
        .comments(&created.item.reference, None, 10)
        .unwrap();
    let WorkItemCommentEntry::Normal(comment) = &comments.entries[0] else {
        panic!("expected normal comment")
    };
    assert_eq!(comment.body, "Saved **comment**");
}

// Catches: start-work mutates provider state or drops explicit draft delivery.
#[test]
fn start_work_returns_host_intent_without_mutating_item() {
    let mut provider = demo_provider();
    let original = provider.detail(&reference("1")).unwrap();
    let request = WorkItemStartWork {
        repo_path: "/demo/repo".into(),
        branch: "fix/demo-1".into(),
        base_ref: Some("main".into()),
        prompt: "Fix DEMO-1".into(),
        agent_type: Some("codex".into()),
        delivery: WorkItemDelivery::Draft,
    };
    let result = provider
        .act(Some(&reference("1")), WorkItemAction::StartWork(request))
        .unwrap();
    let wire = serde_json::to_value(result).unwrap();
    assert_eq!(wire["kind"], "start_work");
    assert_eq!(wire["value"]["delivery"], "draft");
    assert_eq!(provider.detail(&reference("1")).unwrap(), original);
}

// Catches: serde accepts unknown field kinds/extra fields or changes tagged values/casing.
#[test]
fn field_wire_contract_rejects_unknown_shapes_and_preserves_all_kinds() {
    for (kind, value) in [
        ("text", json!("title")),
        ("markdown", json!("**body**")),
        ("enum", json!("open")),
        ("user", json!([])),
        ("labels", json!([])),
        ("date", json!("2026-10-10")),
        ("number", json!(3.5)),
        ("link", json!("https://example.invalid")),
    ] {
        let wire = json!({"kind":kind,"value":value});
        let parsed: WorkItemFieldValue = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
    }
    assert!(
        serde_json::from_value::<WorkItemFieldValue>(json!({"kind":"secret","value":"x"})).is_err()
    );
    assert!(
        serde_json::from_value::<WorkItemRef>(
            json!({"providerId":"demo","accountId":"local","id":"1","token":"secret"})
        )
        .is_err()
    );
}

// Catches: the fake ignores the item type, so a create form built on it never meets the itemType contract.
#[test]
fn create_fields_lists_item_types_and_rejects_unknown_types() {
    let mut provider = demo_provider();
    let picker = provider.create_fields(None).unwrap();
    assert_eq!(picker.len(), 1);
    assert_eq!(picker[0].id, "itemType");
    assert_eq!(picker[0].kind, WorkItemFieldKind::Enum);
    assert_eq!(
        picker[0]
            .options
            .iter()
            .map(|o| o.id.as_str())
            .collect::<Vec<_>>(),
        ["issue"]
    );
    assert_eq!(
        provider.create_fields(Some("issue")).unwrap(),
        provider.fields
    );
    assert!(provider.create_fields(Some("epic")).is_err());
    let mut fields = std::collections::BTreeMap::new();
    fields.insert(
        "priority".to_string(),
        Some(WorkItemFieldValue::Enum("low".into())),
    );
    let create = |item_type: &str| {
        WorkItemAction::Create(WorkItemCreate {
            title: "Typed".into(),
            body: String::new(),
            item_type: item_type.into(),
            fields: fields.clone(),
        })
    };
    assert_eq!(
        provider.act(None, create("epic")).unwrap_err(),
        WorkItemError::Action("unknown item type".into())
    );
    assert!(provider.act(None, create("issue")).is_ok());
}

// Catches: the schema transport dropping display-only field query capabilities.
#[test]
fn field_schema_preserves_display_only_capabilities() {
    let mut value = serde_json::to_value(demo_provider().fields[0].clone()).unwrap();
    for capability in ["sortable", "groupable", "filterable"] {
        value[capability] = json!(false);
    }
    let field: WorkItemFieldSchema = serde_json::from_value(value).unwrap();
    let round_trip = serde_json::to_value(field).unwrap();
    for capability in ["sortable", "groupable", "filterable"] {
        assert_eq!(round_trip[capability], false);
    }
}

// Catches: adding a read-only reason rejects older provider boards or loses the reason on the wire.
#[test]
fn board_write_disabled_reason_is_optional_and_round_trips() {
    let board = json!({"id":"p", "name":"Project", "fieldId":"status", "columns":[]});
    let old: WorkItemBoard = serde_json::from_value(board.clone()).unwrap();
    assert!(old.write_disabled_reason.is_none());
    let mut readonly = board;
    readonly["writeDisabledReason"] = json!("Grant project write access");
    let parsed: WorkItemBoard = serde_json::from_value(readonly).unwrap();
    assert_eq!(
        serde_json::to_value(parsed).unwrap()["writeDisabledReason"],
        "Grant project write access"
    );
}
