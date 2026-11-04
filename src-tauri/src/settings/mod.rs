//! Rust-owned settings schemas and descriptors.
pub mod accounts;
pub mod agents;
pub mod catalogue;
pub mod changes;
pub mod circleci;
pub mod corrections;
pub mod ego;
mod ego_schema;
pub mod model;
pub mod policy;

#[cfg(test)]
mod layout_owner_tests;

pub(crate) mod app_choices;
#[cfg(test)]
mod app_choices_tests;
pub mod keybindings;
pub mod layout;

pub mod native;
pub mod notifications;
pub(crate) mod plugin_migrations;
pub mod plugin_schema;
pub mod plugins;
pub mod preferences;
pub mod registry;
pub mod remote;
pub mod repo_defaults;
pub mod repo_local;
pub mod repositories;
pub mod request;
pub mod service;
pub mod telegram;
pub mod transaction;
pub mod ui_owners;
pub mod upstreams;
#[cfg(feature = "dictation")]
pub mod voice;

mod config_file;
mod pointer;
mod validation;

#[cfg(test)]
mod collection_tests;
#[cfg(test)]
mod transaction_tests;

#[cfg(test)]
mod critic_tests;

#[cfg(test)]
mod validation_tests;

#[cfg(test)]
mod notifications_tests;

#[cfg(test)]
mod preferences_tests;

#[cfg(test)]
mod telegram_tests;

#[cfg(test)]
mod agents_tests;

#[cfg(test)]
mod repositories_tests;

#[cfg(test)]
mod remote_tests;

#[cfg(test)]
mod upstreams_tests;

#[cfg(all(test, feature = "dictation"))]
mod voice_tests;

#[cfg(test)]
mod config_file_tests;

#[cfg(test)]
mod repo_defaults_tests;

#[cfg(test)]
mod repo_local_tests;

#[cfg(test)]
mod accounts_tests;

#[cfg(test)]
mod accounts_safety_tests;

#[cfg(all(test, unix))]
mod ego_fixture;
#[cfg(all(test, unix))]
mod ego_tests;

#[cfg(test)]
mod policy_baseline_tests;

#[cfg(test)]
mod policy_tests;

#[cfg(test)]
mod policy_scope_tests;

#[cfg(test)]
mod policy_domain_tests;

#[cfg(test)]
mod policy_lifecycle_tests;

pub mod api;
mod prompts;

#[cfg(test)]
mod choice_tests;
pub mod registration;
#[cfg(test)]
mod registration_tests;

pub mod upstream_credentials;
#[cfg(test)]
mod upstream_credentials_tests;

#[cfg(test)]
mod api_tests;

#[cfg(test)]
mod startup_flow_tests;

#[cfg(test)]
mod circleci_tests;
#[cfg(feature = "desktop")]
pub(crate) mod legacy;

#[cfg(test)]
pub(crate) mod refresh_test_support;
