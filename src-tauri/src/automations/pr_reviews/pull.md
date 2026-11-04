# Recorded GitHub PR metadata

Recorded on 2026-10-28 with this read-only command:

```sh
gh api repos/cli/cli/pulls/14846 --jq '{number,state,draft,html_url,head:{sha:.head.sha},base:{sha:.base.sha}}'
```

`pull.json` retains only the fields used by the review executor. Tests change the head to simulate a push, or state/draft to simulate loss of eligibility. No GitHub writes were made.
