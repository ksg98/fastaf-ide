# Jira workflow contract evidence

`synthetic-cloud.json` holds Jira Cloud REST API v3 responses written for FastAF
from the public reference, with synthetic values. It is **not a recording** of a
Jira site.

- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/

Upstream's tests replay `plugins/jira/fixtures/cloud.json`, a recording kept in
its plugins repository. FastAF does not vendor that repository, so
`neutral_jira_fixture.rs` reads this file instead. It carries the keys those
tests use: `issue`, `create`, `createmeta`, `transitions`, `searchPages` and
`commentPages`.

The values the tests rely on: issue `10004` in project `10001`, issue type
`10006`, transition `31` to status `10005`, two search pages of one issue (the
second is the last) and two comment pages of one comment each.

These responses prove response shape and the identity, pagination and read-back
checks. They are not evidence of how a real Jira site behaves.
