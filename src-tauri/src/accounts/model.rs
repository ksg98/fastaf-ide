//! Account metadata is serializable; credentials never belong in these records.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AuthKind {
    Bearer,
    Basic,
    OauthDevice,
    Ambient,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub(crate) struct Account {
    #[schemars(extend("x-not-setting" = "Stable account identity issued by core or preserved by migration."))]
    pub id: String,
    #[schemars(extend("x-not-setting" = "Provider identity fixed when the account is created."))]
    pub provider: String,
    #[schemars(extend("x-not-setting" = "Site identity fixed when the account is created."))]
    pub site_id: String,
    #[schemars(extend("x-not-setting" = "Canonical site URL derived from the owning site."))]
    pub host: String,
    #[schemars(extend("x-not-setting" = "Authentication kind fixed when the account is created."))]
    pub kind: AuthKind,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates the account display label.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub label: String,
    #[schemars(extend("x-not-setting" = "Viewer identity resolved by credential verification."))]
    pub login: Option<String>,
    #[serde(default)]
    #[schemars(extend("x-not-setting" = "Basic authentication username supplied during account creation."))]
    pub username: Option<String>,
    #[schemars(extend("x-not-setting" = "Creation timestamp issued by core; zero denotes migrated legacy metadata."))]
    pub created_at: u64,
    #[serde(default)]
    #[schemars(extend("x-not-setting" = "Legacy GitHub authentication provenance retained by migration."))]
    pub auth_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub(crate) struct Site {
    #[schemars(extend("x-not-setting" = "Stable site identity issued by core."))]
    pub id: String,
    #[schemars(extend("x-not-setting" = "Provider identity fixed when the site is created."))]
    pub provider: String,
    #[schemars(extend("x-not-setting" = "Canonical site URL fixed when the site is created."))]
    pub host: String,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates the site display label.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub(crate) struct Registry {
    #[serde(default)]
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Creates or removes accounts through the account owner service.","operations":["get","create","remove"],"confirmationClass":"ordinary"}))]
    pub accounts: BTreeMap<String, Account>,
    #[serde(default)]
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Creates or removes provider sites through the account owner service.","operations":["get","create","remove"],"confirmationClass":"ordinary"}))]
    pub sites: BTreeMap<String, Site>,
    #[serde(default)]
    #[schemars(extend("x-not-setting" = "One-time legacy GitHub registry migration marker."))]
    pub github_migrated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SecretStatus {
    Set,
    Unset,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SecretPresence {
    pub status: SecretStatus,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AccountView {
    #[serde(flatten)]
    pub account: Account,
    pub secret: SecretPresence,
}

#[derive(Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct NewAccount {
    pub provider: String,
    pub host: String,
    pub kind: AuthKind,
    pub label: String,
    #[serde(default)]
    pub username: Option<String>,
}

// Deliberately no Debug or Serialize: input tokens must not become replies/logs.
#[derive(Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum AccountAction {
    List {
        #[serde(default)]
        provider: Option<String>,
    },
    Add {
        account: NewAccount,
        #[schemars(extend("x-setting" = {"sensitivity":"secret","apply":"live","effect":"Stores a write-only account token.","operations":["set_secret"],"confirmationClass":"ordinary"}))]
        token: String,
    },
    SetSecret {
        id: String,
        token: String,
    },
    ClearSecret {
        id: String,
    },
    SetLabel {
        id: String,
        label: String,
    },
    SetSiteLabel {
        id: String,
        label: String,
    },
    Test {
        id: String,
    },
    Remove {
        id: String,
    },
    ListSites {
        #[serde(default)]
        provider: Option<String>,
    },
    AddSite {
        provider: String,
        host: String,
        label: String,
    },
    RemoveSite {
        id: String,
    },
}
