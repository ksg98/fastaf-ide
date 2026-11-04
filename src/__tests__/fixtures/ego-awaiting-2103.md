# Pending ego restore row

Source: the `d00720ae-f711-470f-b114-05d3f1c31bb7` session row in the live
2021-30cd parity audit response, captured on 2026-10-21:
`~/Gits/.tmp/results/desk-2021b/ego-desktop-chat-p-unavailable.json`.

The JSON fixture is that row, extracted without field changes. The session was
waiting on the native `Allow run printf PARITY_EGO_P2_OK?` permission prompt.
Desktop Chat was disabled; mobile Chat opened the transcript. The browser had
no registered repositories, so no repository-owned saved terminal binding was
available during re-adoption.

Fixture SHA-256:
`1f5c032055d01ad89fb2b40962d56ecb3ed710d3cf046e44211fc8533bb083f5`.

This fixture tests frontend re-adoption, not the ego lease or transcript protocol.
The backend must still validate the live process and held lease before exporting.
