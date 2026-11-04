# Real ego single-choice question

Captured 2026-10-12 from installed ego 0.1.0 using Python pty.fork, 35 rows by 120 columns, OpenRouter openai/gpt-4.1-mini, isolated HOME/EGO_HOME/workspace/session store under ~/Gits/.tmp/ui-1759-capture. Only ask_question was enabled. The provider generated the actual tool call; no terminal bytes were fabricated. The question was left unanswered and the capture process was stopped.

SHA-256: `45348f39e5c706fa9519caf8a0300a3596481b3fe538c5b9e975f0fc856748bd`. Original read boundaries and elapsed times are retained in TUICCAP2 framing. Input records contain terminal DSR replies only. No credentials are included.

The old ego binary did not emit OSC awaiting for this human question. The TUIC regression must recover the visible selector as an authoritative choice prompt. The separate ego regression checks the missing native awaiting signal.

Prompt:

Call ask_question now, mode single, free_text false. Ask: Does Boss authorize editing the orchestrator registry to integrate the finished mobile question fix? Provide exactly two options with ids approve and decline: Yes, authorize registry integration and keep the complete question visible on mobile; No, leave the orchestrator registry unchanged and report the remaining work. Do not answer the question yourself. Wait for the human.
