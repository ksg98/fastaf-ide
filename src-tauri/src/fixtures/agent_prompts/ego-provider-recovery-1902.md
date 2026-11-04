# Real ego provider-recovery capture

The recovery-clear regression also uses the unchanged recordings
`claude-quoted-ink-footer.tcap` and `claude-askuser-esc-20260929.tcap` through
`chunk_trace_matches_recorded_baseline` and
`replay_oracle_all_committed_tcap_preserves_chunk_decisions`. They contain no ego
recovery frame: their lifecycle markers must not emit recovery-clear events.
The real ego replay and `ego_recovery_rejects_foreign_agents_and_preserves_wire_order`
cover actual recovery, foreign-agent rejection and same-chunk lifecycle clears.

- Producer: ego branch `feat/1902-recovery-osc`, source commit `3c1bbfb3` (emitter `74d15271` plus interactive flush fix). Binary built on Linux rb from the same source bytes immediately before the flush-fix commit.
- Build evidence: `~/Gits/.tmp/feat-1902-ego-flush-green.log`, rb result `20261015T220537Z-27215`. Command: `cargo nextest run -p ego-cli -E "test(recovery_443) or test(surface_output) or test(live_output_pump)" && cargo clippy -p ego-cli --all-targets -- -D warnings && cargo build -p ego-cli --bin ego`, through `build-slot.sh --remote`.
- Recorder: companion `record.py`. Actual command on rb: `python3 /home/rb/Gits/.tmp/1902-record.py /home/rb/Gits/.tmp/1902-ego-capture-final /home/rb/src/ego-76ec1c81-slot0/target/debug/ego`.
- Producer argv: `ego -m anthropic/claude-opus-5-5 --thinking low --bare --sandbox off --no-tools 'Capture recovery.'`.
- Date: 2026-10-15 UTC. Geometry: 24 rows, 100 columns. `pty.openpty`, TIOCSWINSZ, real monotonic timestamps and real read chunks. TCAP v2 header `TUICCAP2\n`, little-endian geometry and `<BQI` records. No hand-written terminal output.
- Environment: isolated HOME/EGO_HOME and workspace below `/home/rb/Gits/.tmp/1902-ego-capture-final`; loopback Anthropic Messages stub, fixture key only; TERM=xterm-256color and TUIC_SOCKET=capture-host-marker select the TUIC OSC profile. No actual TUIC socket or desktop instance used.
- Provider double: first POST returns HTTP 529 overloaded_error with Retry-After 2; second POST streams Anthropic Messages text `Recovery capture complete.` and end_turn. The recorder writes `/retry\r` after it observes the real waiting OSC, and answers actual cursor-position queries.
- Observed timing: waiting at 283565 us, `/retry` input at 283602 us, retrying at 384392 us, clear at 484694 us. Thus `/retry` forces dispatch before the advertised 2-second wait.
- Capture SHA-256: `819c8841360d0732dfe4bbe2b40b6737afe81ae19c5aee68a03dbdba610c385c`.
- Cleanup: recorder terminates the idle interactive producer after clear; it required SIGKILL after a bounded SIGTERM wait (exit -9). The captured clear is a real successful provider-settlement signal, not a fabricated process-exit signal. All recorder-owned child/server processes stopped.
- Scope: Linux producer capture, not a macOS or live TUIC visual claim. Cancellation and give-up clear are covered by focused unit tests, not this successful-recovery capture.

Earlier capture attempts identified invalid argv (`--bare` with `--trust-workspace`), unsupported `off` reasoning for the selected model, and the pre-fix interactive buffering defect. Those attempts are not this final fixture.
