# Ego profile ceiling recording

`ego-profile-ceiling.json` is the unmodified `session/new` result recorded on
2026-10-06 from ego branch `feat/acp-ceiling-profile`, commit
`70ffc69c0668a058721e242ad83d671916d1ebf6`, using its existing debug binary.
The process ran in an isolated `EGO_HOME` and workspace under `~/Gits/.tmp`.
No model request, authentication or user configuration was used.

User configuration:

```toml
[profile.machine]
mode = "default"
sandbox = "workspace"
roots = []
[profile.wide]
mode = "yolo"
sandbox = "off"
roots = []
```

Launch: `ego acp --profile machine`. After `initialize` with protocol version 1,
send `session/new` with the workspace cwd, `mcpServers: []` and
`_meta.ego: {"profile":"wide","ceilingProfile":"machine"}`.
The fixture retains the returned session id and both authoritative warnings.
TUIC's scenario additionally checks its own MCP grant, independent of this
recorded ego response. Regenerate from ego; do not hand-edit the response.
