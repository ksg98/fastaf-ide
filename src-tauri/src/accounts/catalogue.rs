//! Logical Settings schema combines metadata and a write-only vault leaf.
//! These types have no deserialization/service path and never load real values.
use super::model::{Account, Site};
use schemars::JsonSchema;
use std::collections::BTreeMap;

#[expect(
    dead_code,
    reason = "schema-only: fields are read by the JsonSchema derive; story 1675-ccd4 reads them"
)]
#[derive(JsonSchema)]
struct AccountSettings {
    #[schemars(flatten)]
    account: Account,
    #[schemars(extend("writeOnly" = true, "x-setting" = {"sensitivity":"secret","apply":"live","effect":"Reads credential presence or replaces/clears the token through the account owner service.","operations":["get","set_secret","clear_secret"],"confirmationClass":"ordinary"}))]
    token: Option<String>,
}

#[expect(
    dead_code,
    reason = "schema-only: fields are read by the JsonSchema derive; story 1675-ccd4 reads them"
)]
#[derive(JsonSchema)]
struct AccountSettingsRegistry {
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Creates or removes accounts through the account owner service.","operations":["get","create","remove"],"confirmationClass":"ordinary"}))]
    accounts: BTreeMap<String, AccountSettings>,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Creates or removes provider sites through the account owner service.","operations":["get","create","remove"],"confirmationClass":"ordinary"}))]
    sites: BTreeMap<String, Site>,
}

/// Schema-only catalogue seam: no filesystem, credentials or provider requests.
pub(crate) fn catalogue_schema() -> serde_json::Value {
    let generator = schemars::generate::SchemaSettings::draft2020_12()
        .with(|settings| settings.inline_subschemas = true)
        .into_generator();
    serde_json::to_value(generator.into_root_schema_for::<AccountSettingsRegistry>())
        .expect("Account schema serializes as JSON")
}
