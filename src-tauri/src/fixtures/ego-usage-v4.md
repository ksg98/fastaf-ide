# ego usage v4 CLI recording

Recorded on 2026-10-27 with the native `ego` built through mbx and build-slot from
master `39ae34bb9fe2f298ec32156774b363952327603c`. The checkout had pre-existing
proxy implementation changes; the usage report implementation was unchanged.
No installed executable was replaced.

The JSON file is the exact stdout of `ego usage --json -C <isolated workspace>`.
SHA-256: `4b8fa6a0881a4ec626bcda6a20ecf680bfb2220741d99c5d7fc9f64014df5f01`.
Full local capture, seed stdout/stderr, and reproduction script:
`~/Gits/.tmp/2386-v4/`; capture log: `~/Gits/.tmp/2386-v4-capture-isolated.log`.

The real CLI first created a durable session through an owned loopback server.
It replayed ego's existing CLI SSE seed (`tests/support::text`), its recorded
OpenRouter model catalogue, and the recorded OpenRouter key response from
`crates/ego-ai/tests/fixtures/usage_limits/openrouter-key.json`. The key fixture
was captured from the provider by ego story 662; remaining is explicitly stated
and differs from limit minus usage. No live paid generation occurred. The
context occupancy and capacity are observations from this controlled CLI run,
not measurements of a live provider account.

The session has no historical provider-limit observation. Its root array is a
current-credential lookup and must not become session spend. Tests that move
that observation into a session or alter its typed kind are explicitly derived
boundary cases, not additional provider recordings.

An earlier attempt to read the complete daily store timed out after 90 seconds.
The isolated capture avoids that unrelated historical-store size and retains
no prompts, tokens, credentials, or real session content.
