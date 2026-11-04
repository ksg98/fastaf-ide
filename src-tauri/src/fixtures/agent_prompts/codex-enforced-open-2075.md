# Codex enforced approval with retained scrollback — 2075-aa2f

Recorded 2026-10-19 from installed `/opt/homebrew/bin/codex`, codex-cli 0.162.1, through a real macOS PTY with 41 rows and 128 columns. Capture source: `/Users/stefano.straus/Gits/.tmp/codex-2075-long-reality/approve.tcap`, recorded by `/Users/stefano.straus/Gits/.tmp/capture-2075.py`.

Launch used `--no-daemon --no-alt-screen --ask-for-approval on-request --sandbox workspace-write -m gpt-6.1-sol`. The initial prompt included 65 lines of inert audit context to populate scrollback, then requested only a harmless printf with `sandbox_permissions=require_escalated`. A delayed Escape dismissed the hook-review startup modal. The authentic command approval stayed open for 12 seconds without input. The recorder then sent one numeric `1`, without Enter. Codex confirmed approval, ran the printf once and returned to its ready composer. The recorder stopped only its own CLI after the bounded observation period.

Terminal replies and startup input are retained. TCAP v2 framing preserves original output chunks, monotonic timestamps, input and geometry; no output is synthesized. The three native choices are approve once, approve the prefix and refuse. This recording does **not** reproduce the reported unanswered awaiting-to-idle transition: the pre-fix production chunk/accumulator replay retains the three controls. Its native replay passed on pre-fix commit `282cd854e7e4aaa82ef0f3039178a2302c81c87a`; this is invariant evidence, not RED proof. The replay does not reproduce wall-clock timer execution or a live browser/store subscription.

The driver also attempted refusal in a separate process, but that attempt stopped at a folder-trust modal. It is not part of this fixture and is not claimed as refusal evidence.

SHA-256: `5ff85a0f55b13f8bd196e9d3b97f725a7684fa3938be033cc1d0d1e747954612`
