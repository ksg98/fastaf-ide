# Untrusted Host response

Captured on 2026-10-28 from the running mac-mint daemon:

```sh
curl -sS --max-time 5 -D untrusted.headers -o untrusted-host.body http://mac-mint.tail911da.ts.net:9877/health
```

The response was HTTP 403 with `content-type: text/plain; charset=utf-8`
and `content-length: 14`. The body is preserved without a final newline.
SHA-256: `e1dc449d9731d0dec38e42ba2d7da0cc043427380bfdb36111e527f348dcfea5`.

The same listener returned HTTP 200 via `100.105.155.2:9877` and with
`Host: mac-mint:9877`, but HTTP 403 with the full MagicDNS Host header.
The health response reported version `1.8.0`, target
`x86_64-unknown-linux-gnu`, and build SHA-256
`75bb1c7c36ebc0515dc8417fc5c2f07e4c8fcf9886e7d74895ca5085c576ff1b`.
SSH `sha256sum /usr/local/bin/tuic-remote` confirmed that digest.
The daemon process started on 2026-10-12. The installed binary timestamp was
2026-10-05. Tailscale currently reports Running with Self DNS name
`mac-mint.tail911da.ts.net.`. This does not prove what the daemon detected at
startup; no Tailscale entries were available in its service journal.

The current Host guard trusts the full name only when its own stored Tailscale
state is Running with a matching name. The older daemon's exact stored state
and startup failure are not observable from these public probes. No daemon
configuration, service, binary or trust policy was changed for this investigation.
