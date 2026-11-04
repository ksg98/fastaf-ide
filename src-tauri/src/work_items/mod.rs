//! Shared Tasks contract. Provider registration and transport wiring are separate steps.
pub mod demo;
pub mod fake;
#[cfg(test)]
mod filter_tests;
#[cfg(test)]
mod finding_tests;
mod listing;
pub(crate) mod local_query;
pub mod model;
pub(crate) mod notices;
mod projections;
pub mod protocol;
#[cfg(test)]
mod tests;
mod validation;

pub(crate) mod provider_bridge;
pub(crate) mod start_work_prompt;
