`app-defaults.json` is the `.app` member of the recorded `GET /config/defaults`
response from the to-test-1014 run on 2026-10-14, copied from
`~/Gits/.tmp/results/to-test-1014/config-defaults-recorded.json`.

The independently hydrated production settings stores reproduced the stale
overwrite in `config-windows-browser2.log` and `config-windows-proof.json` in that
same evidence directory. The test replaces transport IO with an owned in-memory
document and inspects real `settingsStore` / `updateAppConfig` save packets;
it does not claim native-window or cross-process disk verification.
