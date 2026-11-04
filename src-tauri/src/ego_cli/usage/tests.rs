use super::*;

fn recorded() -> Value {
    serde_json::from_str(include_str!("../../fixtures/ego-usage-v3.json")).unwrap()
}

// Catches: subscription equivalents labelled as money spent, selecting another
// session's occupancy, and incomplete prices being rendered as zero.
#[test]
fn ego_usage_recorded_report_keeps_session_and_cost_semantics() {
    let report = recorded();
    assert_eq!(
        project(&report, "01a158f3-2878-7373-a912-83cdca86822d")
            .unwrap()
            .text
            .as_deref(),
        Some("ctx: 63151 · API eq: USD 1.261548")
    );
    assert_eq!(
        project(&report, "d2c92a03-27ea-574a-ad3b-f482ef41491a")
            .unwrap()
            .text
            .as_deref(),
        Some("ctx: 137126")
    );
    assert_eq!(project(&report, "not-this-session").unwrap().text, None);
}

// Catches: future report versions, absent observations, and invalid decimal
// amounts gaining a plausible-looking usage display.
#[test]
fn ego_usage_missing_or_invalid_fields_never_invent_usage() {
    let mut report = recorded();
    report["v"] = 5.into();
    assert!(project(&report, "not-this-session").is_err());
    report["v"] = 3.into();
    let id = report["sessions"][0]["session"]
        .as_str()
        .unwrap()
        .to_owned();
    report["sessions"][0]["context"] = Value::Null;
    report["sessions"][0]["lines"]["total"]["cost"] = Value::Null;
    assert_eq!(project(&report, &id).unwrap().text, None);
    for amount in ["NaN", "-1", "1.2.3", "", "1e1000"] {
        report["sessions"][0]["lines"]["total"]["cost"] = serde_json::json!({
            "unknown": [], "known": [{"currency": "USD", "amount": amount}],
            "subscription_equivalent": [], "subscription_unknown": []
        });
        assert_eq!(project(&report, &id).unwrap().text, None, "{amount}");
    }
}

// Catches: suppressing real exact monetary totals or treating known zero as missing.
#[test]
fn ego_usage_known_monetary_total_preserves_exact_decimal() {
    let mut report = recorded();
    let id = report["sessions"][0]["session"]
        .as_str()
        .unwrap()
        .to_owned();
    for amount in ["1.261548", "0"] {
        report["sessions"][0]["context"] = Value::Null;
        report["sessions"][0]["lines"]["total"]["cost"] = serde_json::json!({
            "unknown": [], "known": [{"currency": "USD", "amount": amount}],
            "subscription_equivalent": [], "subscription_unknown": []
        });
        assert_eq!(
            project(&report, &id).unwrap().text,
            Some(format!("USD {amount}"))
        );
    }
}

// Catches: choosing subscription equivalents instead of independent known spend.
#[test]
fn ego_usage_mixed_cost_keeps_spend_and_equivalent_independent() {
    let mut report = recorded();
    let session = "01a1780d-ae67-74ff-a371-4c6bf003946d";
    report["sessions"][1]["context"] = Value::Null;
    assert_eq!(
        project(&report, session).unwrap().text.as_deref(),
        Some("USD 0 · API eq: USD 3.1727124")
    );
    report["sessions"][1]["lines"]["total"]["cost"]["subscription_unknown"] =
        serde_json::json!([{"reason": "no_pricing_quote"}]);
    assert_eq!(
        project(&report, session).unwrap().text.as_deref(),
        Some("USD 0")
    );
    report["sessions"][1]["lines"]["total"]["cost"]["subscription_unknown"] = serde_json::json!([]);
    report["sessions"][1]["lines"]["total"]["cost"]["unknown"] =
        serde_json::json!([{"reason": "no_pricing_quote"}]);
    assert_eq!(
        project(&report, session).unwrap().text.as_deref(),
        Some("API eq: USD 3.1727124")
    );
}

fn recorded_v4() -> Value {
    serde_json::from_str(include_str!("../../fixtures/ego-usage-v4.json")).unwrap()
}

// Catches: root current-key balances leaking into unrelated provider sessions,
// or incomplete/invalid observations becoming fabricated remaining balances.
#[test]
fn ego_usage_v4_limits_fail_closed_without_matching_identity_and_observation() {
    let recorded = recorded_v4();
    let id = "0198c7f4-9c1f-7a2b-8c3d-4e5f60718293";
    for (field, value) in [
        ("provider", serde_json::json!("anthropic")),
        ("observed_at", Value::Null),
        ("model", serde_json::json!("openrouter/another-model")),
        ("limits", Value::Null),
    ] {
        let mut report = recorded.clone();
        report["provider_limits"][0][field] = value;
        assert_eq!(
            project(&report, id).unwrap().text.as_deref(),
            Some("ctx: 14/128000"),
            "{field}"
        );
    }
    for (field, value) in [
        ("remaining", Value::Null),
        ("remaining", serde_json::json!("-1")),
        ("remaining", serde_json::json!("NaN")),
        ("kind", serde_json::json!("unknown")),
        ("source", Value::Null),
    ] {
        let mut report = recorded.clone();
        report["provider_limits"][0]["limits"][0][field] = value;
        assert_eq!(
            project(&report, id).unwrap().text.as_deref(),
            Some("ctx: 14/128000"),
            "{field}"
        );
    }
    let mut report = recorded;
    report["sessions"][0]["model"] = serde_json::json!("openai-codex/gpt-6.1-sol");
    assert_eq!(
        project(&report, id).unwrap().text.as_deref(),
        Some("ctx: 14/128000")
    );
}

// Catches: treating session observations as an array, losing typed units or real
// zero balances, or calculating remaining from limit-used instead of preserving it.
#[test]
fn ego_usage_v4_session_limits_preserve_typed_exact_balances() {
    let mut report = recorded_v4();
    let id = "0198c7f4-9c1f-7a2b-8c3d-4e5f60718293";
    let mut observation = report["provider_limits"][0].clone();
    observation["model"] = report["sessions"][0]["model"].clone();
    report["provider_limits"] = Value::Null;
    report["sessions"][0]["provider_limits"] = observation;
    for (kind, remaining, expected) in [
        ("usd", "195.970819484", "USD 195.970819484"),
        ("requests", "0", "0 requests"),
        ("tokens", "900", "900 tokens"),
        ("input_tokens", "800", "800 input tokens"),
        ("output_tokens", "100", "100 output tokens"),
    ] {
        report["sessions"][0]["provider_limits"]["limits"][0]["kind"] = serde_json::json!(kind);
        report["sessions"][0]["provider_limits"]["limits"][0]["remaining"] =
            serde_json::json!(remaining);
        assert_eq!(
            project(&report, id).unwrap().text,
            Some(format!(
                "ctx: 14/128000 · openrouter/openai/gpt-4o: {expected} left"
            ))
        );
    }
    report["sessions"][0]["provider_limits"]["model"] = serde_json::json!("openrouter/sibling");
    assert_eq!(
        project(&report, id).unwrap().text.as_deref(),
        Some("ctx: 14/128000")
    );
    report["sessions"][0]["context"] = Value::Null;
    assert_eq!(project(&report, id).unwrap().text, None);
}
