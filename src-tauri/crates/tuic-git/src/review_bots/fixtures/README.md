# Review-bot comment fixtures

`comments.json` holds subsets of public pull-request review comments, recorded on
2026-10-13 with read-only `gh api -X GET repos/{owner}/{repo}/pulls/{n}/comments`
(REST v3). Each entry keeps `id`, `user`, `path`, `line`, `original_line`,
`html_url` and the verbatim `body`. The tests in `../tests.rs` and
`work_items/finding_tests.rs` read it.

| Key | Pull request | Comments | Format |
|---|---|---|---|
| cr1 | mozilla-ai/any-llm#1475 | 4259407445 | CodeRabbit |
| cr2 | xpadev-net/discord-transcript#272 | 4259399098, 4259399111 | Codex |
| cp4 | microsoft/vscode#341276 | 4256900488 | Copilot (REST login `Copilot`) |
| gem-366 | Roklion/Project_Tabula_Rasa#366 | 4251826677 | Gemini, no suggestion |
| gem-6137 | openconfig/featureprofiles#6137 | 4207429326 | Gemini with ```` ```suggestion ```` |
| cur-2833 | PrimeIntellect-ai/verifiers#2833 | 4251485369 | Cursor Bugbot |
| src-390 | yandex/ch-backup#390 | 4251395814 | Sourcery (`~~~` prompt) |
| grp-2162 | morluto/rea#2162 | 4258565013 | Greptile P1 |
| grp-58 | KaiStats/billtap#58 | 4252315759 | Greptile five-backtick prompt with inner ```` ``` ```` |
| qodo-1635 | fullsend-ai/agents#1635 | 4217076580 | Qodo |
| cdt-417 | mcuteangel/hesabyaar#417 | 4241463577 / 4241467129 / 4241700054 | CodeAnt / cubic / Kilo (generic) |
| gra-969 | Genesis-Embodied-AI/quadrants#969 | 4250949125 | Graphite |
| gas-264 | PromptExecution/ledgrrr#264 | 4240887334, 4240887337 | code scanning alerts 436, 437 |
| gem-13837 | google/site-kit-wp#13837 | 4255947792 | human with a suggestion (CRLF body) |

## Redactions

- Cursor deep links (`cursor.com/open?…`) are replaced by `REDACTED`: they embed per-PR keys.
- `prompt_id=` and `chatWithGeneratedComment=` query values are removed.
- The Qodo finding UUID stays: it is the public id in the Dismiss/View link and the test reads it.
- A secret scan (tokens, keys, `ghp_`/`gho_`/`sk-` prefixes) found nothing.
