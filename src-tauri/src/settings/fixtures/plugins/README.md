# Plugin settings defaults

Captured on 2026-10-14 with `node src-tauri/src/settings/fixtures/plugins/capture-defaults.mjs`.
The script evaluates only the configuration declarations from the actual source;
it does not load the plugin runtime, start timers, or contact providers.

Source: plugins submodule commit `016e64059592d315523f648bfbafea35c4d22317`,
plus the Telegram notifier in `examples/plugins/telegram-notifier/main.js` at
core commit `d043d08a98`. The separate checkout named in the assignment was absent.
The submodule has the same `sstraus/tuicommander-plugins` origin and stays read-only.

These captured defaults are the migration/readback oracle. Statistics, runtime
session counters, source-code constants, previewed documents, MDKB's external
configuration and the native agent-usage feature are not private plugin settings.

## Tasks provider manifests

`tasks-provider-*.manifest.json` were written for FastAF's tests; they are not
copied from any plugin. They cover the manifest shapes a work-item provider
uses in `plugin_registration_tests.rs`: one core account provider with no
settings, and two declared token providers whose settings schema holds a
`projectId` or a `project`.
