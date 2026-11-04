# Codex enforced command approval — 2026-9178

Captured 2026-10-18 from codex-cli 0.162.1 in real TUIC session `48b06afa-ecd8-40c6-98b0-57a55006d807`, initial geometry 32 × 100, cwd `~/Gits/.tmp/fix-parity`. The TUIC tap was filtered to this session before launch, preserving original TCAP v2 input/output/timestamps.

Launch: `codex --ask-for-approval on-request --sandbox read-only` (not YOLO). The prompt requested `exec_command` for `printf TUIC_APPROVAL_PROBE` with `sandbox_permissions=require_escalated`. The CLI enforced its native command approval, not a model question. It displayed Environment, Reason, the command and Yes/allow-prefix/No options. A single numeric `3` canceled immediately, without Enter; Codex confirmed cancellation and `(no output)`. No command was approved or executed. Workspace trust was accepted only for the owned throwaway directory. Existing hook exit-127 noise is retained.

Capture source: `/Users/stefano.straus/Library/Application Support/com.tuic.commander/captures/48b06afa-ecd8-40c6-98b0-57a55006d807.tcap`.

SHA-256: `82e3c0486f355a54d0654b36648307591bf11260b0255901838985de21e08fd0`
