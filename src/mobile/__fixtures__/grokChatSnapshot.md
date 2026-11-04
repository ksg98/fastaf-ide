# Real Grok Chat snapshot

Recorded on 2026-10-19 through `GET /sessions/220f540f-cb19-49c1-b5ba-918347de8a78/chat-view?from_seq=0` from the running backend. The response was HTTP 200 for a disposable, live Grok 1.0.62 PTY. The request was: `Reply with exactly MOBILE_CHAT_REALITY_OK. Do not use tools or change files.`

`grokChatSnapshot.json` is the unmodified snapshot response. It is not an invented transcript. The backend owns the native PID-to-registry binding. The regression mounts the real mobile Chat host and shared transcript renderer; it does not claim that a component test validates the registry.

Full backend/session capture and worktree Vite DOM evidence: `~/Gits/.tmp/results/feat-2076-2077-evidence/`.

SHA-256 of the formatted JSON fixture: `5e8fd0a7354cf1983b1fd3482e27f3c48ac6431475e4979f9ba234c50f6a6bda`. Formatting changes indentation only; the parsed response is unchanged.
