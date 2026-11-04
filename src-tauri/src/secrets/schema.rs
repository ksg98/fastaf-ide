//! Request schema contains metadata only, never values.
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FieldKind {
    Username,
    Password,
    Otp,
    Sso,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Field {
    pub name: String,
    pub kind: FieldKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
}

#[derive(Clone, Serialize)]
pub(crate) struct Form {
    pub id: String,
    pub nonce: String,
    pub reason: String,
    pub fields: Vec<Field>,
    pub argv: Option<Vec<String>>,
    pub mobile_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mobile_unavailable: Option<String>,
    pub cwd: Option<String>,
}

impl Form {
    pub(crate) fn request(fields: Vec<Field>, reason: String) -> Result<Self, String> {
        if fields.is_empty() || fields.len() > 16 || reason.len() > 4096 {
            return Err("Invalid secret field schema".into());
        }
        let mut names = std::collections::BTreeSet::new();
        for field in &fields {
            if !valid_name(&field.name) || !names.insert(field.name.clone()) {
                return Err("Secret names must be unique environment variable names".into());
            }
            if field.kind == FieldKind::Sso {
                if !field.display.as_ref().is_some_and(|v| {
                    (v.starts_with("https://") || v.starts_with("http://")) && v.len() <= 8192
                }) {
                    return Err("SSO requires an HTTP(S) link to display".into());
                }
            } else if field.display.is_some() {
                return Err("Only SSO fields accept display content".into());
            }
        }
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            nonce: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            reason,
            fields,
            argv: None,
            mobile_url: None,
            mobile_unavailable: None,
            cwd: None,
        })
    }
}

pub(super) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
}
