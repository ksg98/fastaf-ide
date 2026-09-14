# Preserve OAuth Credential Generations Across 401 Recovery

## Problem

An MCP request can receive a 401 while a concurrent OAuth authorization flow is
persisting a replacement credential. The request knows which bearer the server
rejected, but the existing forced-refresh path discards that identity: it
re-reads the latest stored credential, marks that credential expired, and sends
its refresh token to the authorization server. A credential written between the
request and recovery is therefore rotated immediately instead of being tried.

## Decision

Every 401 recovery path passes the exact rejected bearer into forced refresh.
The token manager uses that bearer as the rejected credential generation while
retaining the latest stored OAuth metadata. Under the existing per-client
refresh lock it re-reads storage: a different, valid access token is treated as
a concurrent replacement and returned without contacting the token endpoint;
only the still-rejected or an invalid generation is refreshed.

Pre-request expiry refresh remains unchanged. It has no server rejection to
identify and continues to use the stored token set as its current generation.

## Why Existing Mechanisms Are Insufficient

Re-reading the credential before forced refresh is necessary but not sufficient.
Without carrying the rejected bearer, the freshly read credential becomes the
one deliberately marked expired, so the token manager cannot distinguish a
concurrent authorization exchange from the credential that produced the 401.
Expiry timestamps cannot provide that identity because server-side revocation
may happen before the advertised expiry.

## Alternatives Considered

- Compare the stored credential with a client-side sequence number. This would
  require a new persisted or process-local generation mechanism and migration,
  while the access token already provides the required opaque generation
  identity.
- Retry the latest stored credential before entering forced refresh. This leaves
  a check-then-refresh race outside the existing refresh lock and duplicates the
  token manager's double-check behavior.
- Always refresh after a 401. This preserves the current bug by rotating a
  concurrently authorized credential and can invalidate its refresh token.

## Trade-offs

Access-token equality is used only as generation identity; token contents remain
opaque and are not logged. The recovery API must carry the bearer that was put
on the rejected request, but no wire or persistence format changes. A different
stored token whose expiry is invalid is still refreshed rather than retried.

## Failure Semantics

If the stored credential is absent or is not OAuth, forced refresh remains a
no-op and the original 401 classification is returned. If the stored generation
is still the rejected one, or the replacement is invalid, refresh failures keep
their existing classification. A different valid generation is retried exactly
once through the existing request retry path.

## Lifecycle and Ownership

`HttpMcpClient` owns the rejected request bearer and passes it to
`TokenManager`. `TokenManager` owns generation comparison, refresh
serialization, token-endpoint interaction, and credential persistence. The
authorization callback remains the sole owner of authorization-code exchange;
401 recovery never rewrites a newly exchanged credential unless that credential
is itself invalid and requires refresh.
