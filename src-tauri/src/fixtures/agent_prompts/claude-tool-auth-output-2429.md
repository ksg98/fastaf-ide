# Recorded Claude tool diagnostics — 2429-a18d

Captured on 2026-10-28 from installed Claude Code 2.1.311 in a real Python
`openpty` at 41 rows by 128 columns. SHA-256:
`12227ffd43ba4b2a9aa4d2613e5d4b3e50d8e241f14c352a14ee1c1454a248fd`.

Recorder: `~/Gits/.tmp/2429/capture.py`. The installed CLI uses private HOME,
CLAUDE_CONFIG_DIR, cwd and TMPDIR under that directory, a dummy key, and a
loopback Anthropic SSE server. No paid provider, real credential, or TUIC desktop
instance is used. The loopback response requests a real Bash printf tool call
with archived authentication and connection diagnostics. The CLI executes it
successfully, reports the tool result back to the server, and renders a healthy
final answer. Ctrl+O opens the native detailed transcript, exposing the actual
receipt and indented continuation rows. These terminal bytes are recorded, not
hand-written. TUICCAP2 retains read boundaries, input, timing and geometry.
The recorder stops only its owned CLI and loopback server.

The regression replays output through ChunkProcessor, the event bus and the
SessionState accumulator. It models an established session by settling startup
grace: otherwise startup suppresses every API error and makes this assertion
vacuous. It requires the real diagnostic to reach the terminal grid and rejects
an error at every observed chunk, not only after the healthy final response.
The pre-fix native replay latched `     API Error: Connection refused` twice.

The 40-column native failure fixture from 2335 remains the positive narrow-layout
oracle. This capture proves a negative tool-result case, not a native provider
outage or every past Claude version's rendering.
