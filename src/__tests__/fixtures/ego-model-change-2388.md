# Ego model change: unselected reasoning

Recorded on 2026-10-27 from the installed `ego 0.4.0` ACP stdio server.
The process used a task-local `EGO_HOME`, session directory and workspace,
with adaptive confinement and one read-write workspace root.
No prompt or inference request was sent.

`ego-model-change-2388.json` contains two unmodified `configOptions` arrays:

- `before`: the first asynchronous `session/update` configuration offer after
  `session/new`, with `openai-codex/gpt-6.1-sol` selected.
- `after`: the `session/set_config_option` response after setting `model` to
  `ollama/gemma4:12b-mlx`.

The response publishes the reasoning value `__ego_unselected__` with the display
name `Choose a value`. The composer must render the display name, as it already
does for model and mode choices, rather than expose the opaque protocol value.

Full request/response recording retained for this task:
`~/Gits/.tmp/tuic-2388-visual/ego-model-change.json`.
