//! Error hints are schema facts, not echoes of rejected input.
use super::validation::validate;
use serde_json::json;

// Catches: malformed values return empty hints, or recovery text leaks rejected input.
#[test]
fn invalid_type_and_bounds_errors_describe_schema_without_echoing_input() {
    let cases = [
        (
            json!({"type":"integer","minimum":1,"maximum":65535}),
            json!("secret-input-canary"),
            "invalid_type",
            "integer",
            vec!["minimum: 1", "maximum: 65535"],
        ),
        (
            json!({"type":"integer","minimum":1}),
            json!(0),
            "out_of_range",
            "integer",
            vec!["minimum: 1"],
        ),
        (
            json!({"type":"string","enum":["on","off"]}),
            json!("secret-input-canary"),
            "out_of_range",
            "string",
            vec!["\"on\"", "\"off\""],
        ),
        (
            json!({"type":"number","exclusiveMinimum":0,"exclusiveMaximum":1}),
            json!(1),
            "out_of_range",
            "number",
            vec!["exclusiveMinimum: 0", "exclusiveMaximum: 1"],
        ),
        (
            json!({"type":"string","minLength":2}),
            json!("x"),
            "out_of_range",
            "string",
            vec!["minLength: 2"],
        ),
    ];
    for (schema, value, code, expected, allowed) in cases {
        let error = validate(&schema, &value, "app").unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.expected.as_deref(), Some(expected));
        assert_eq!(error.allowed, allowed);
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("secret-input-canary")
        );
    }
    for value in [json!(0), json!(1)] {
        assert!(
            validate(
                &json!({"type":"number","minimum":0,"maximum":1}),
                &value,
                "app"
            )
            .is_ok()
        );
        assert!(
            validate(
                &json!({"type":"number","exclusiveMinimum":0,"exclusiveMaximum":1}),
                &value,
                "app"
            )
            .is_err()
        );
    }
}
