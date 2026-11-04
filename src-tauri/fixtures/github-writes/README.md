# GitHub write response fields

Recorded read-only on 2026-10-11 with `gh api`:

- `pr-recorded.json`: `GET repos/github/docs/pulls?per_page=1`, first item, retaining number, html_url, title.
- `issue-recorded.json`: `GET repos/microsoft/vscode/issues?per_page=20`, first non-PR item, retaining number, html_url, title.

These read responses supply the fields consumed from PR/issue creation responses.
Review tests reuse `github-review/reviews-recorded.json`. Request-body assertions
verify the local write boundary without performing writes against GitHub.
