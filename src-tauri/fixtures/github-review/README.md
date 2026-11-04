# GitHub review API fixtures

Recorded read-only from GitHub on 2026-10-10 with authenticated `gh api`.
No mutation was sent to any repository.

- `threads-recorded.json`: GraphQL `repository(owner:"microsoft", name:"vscode")` → `pullRequests(last:10, states:MERGED)`, selecting `number`, `headRefOid`, and `reviewThreads(first:10)`. Thread selection: id, path, line, originalLine, diffSide, isResolved, isOutdated, comments(first:100) with pageInfo and id/databaseId/body/url/author.login/createdAt. Text and author handles are scrubbed. Includes outdated threads with null current lines.
- `reviews-recorded.json`: REST `GET repos/microsoft/vscode/pulls/340803/reviews`. Only id, html_url, state, commit_id are retained.
- `schema-recorded.json`, `reply-schema-recorded.json`: GraphQL introspection of thread/reply/queue fields and input types. The reply review id is optional; thread id and body are required.

Tests run against a local API stub. Read responses use these recorded values. Mutation response envelopes are the documented GitHub GraphQL payload shapes, containing recorded nodes modified by the local stub; these are not recordings of live mutations. Local write capture verifies REST coordinates and GraphQL input without external writes.

Contracts: [review creation](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request), [pull request GraphQL reference](https://docs.github.com/en/graphql/reference/pull-requests).

## PR action fixtures

Recorded read-only on 2026-10-11:

- `actions-pr-recorded.json`: GraphQL `github/docs` → `pullRequests(last:1, states:OPEN)` selecting number/id/headRefOid/baseRefName/state/isDraft/isMergeQueueEnabled/autoMergeRequest/mergeQueueEntry.
- `actions-run-recorded.json`: REST `GET repos/github/docs/actions/runs?status=failure&per_page=1`, retaining id/status/conclusion/run_attempt/head_sha/html_url.
- `actions-schema-recorded.json`: introspection of PullRequest fields and EnablePullRequestAutoMergeInput (including expectedHeadOid).
- `queue-payload-schema-recorded.json`: enqueue/dequeue payload fields. Both return mergeQueueEntry.
- `queue-entries-recorded.json`: current `github/docs` main merge queue was empty at recording time.
- `merge-documented.json`: exact success example from [GitHub's merge endpoint](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request).

Mutation stub ids and timestamps describe local stub effects only. They are not live GitHub recordings. Merge queue policy is the PR field `isMergeQueueEnabled` (covers rulesets and classic branch protection); failed reruns use [rerun failed jobs](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run), which includes dependent jobs. No live write was performed.

## Review-bot fixtures

Recorded read-only on 2026-10-13 by the bot-review analysis (`gh api graphql` query, no mutation):

- `bot-threads-cur-2833.json`: https://github.com/PrimeIntellect-ai/verifiers/pull/2833 → `reviews` and `reviewThreads` selecting isResolved, isOutdated, line, originalLine, path and the first comment's `author { __typename login }`, lastEditedAt, createdAt. GraphQL bot logins carry no `[bot]` suffix (`cursor`, `macroscopeapp`); thread index 2 is outdated (`line: null`, `originalLine: 148`). No body, id or URL was selected.
