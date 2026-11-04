# FastAF Relay Prototype

This independent Rust service is a starting point for remote access through a
WebSocket intermediary. **It is not a complete remote-access product. There is
no deployed FastAF relay service.** The default hostname in Settings is
not an available hosted service.

## Current scope

The server forwards frames between peers in a room. It includes SQLite token,
session and push-subscription storage, registration limiting, peer-status
messages, an idle reaper, and optional VAPID Web Push delivery.

The desktop client connects, sends push hints and forwards selected application
events when another peer is present. It decrypts incoming commands but does not
yet dispatch them. The mobile PWA uses direct HTTP, WebSocket and SSE access;
relay transport and relay QR pairing are not implemented. The server does not
serve the PWA assets. Enabling the relay alone cannot provide usable mobile
remote access.

Direct LAN, Tailscale and VPN access remain separate from this prototype.

## Encryption and trust

**The current desktop protocol is not end-to-end encrypted.** Its AES-256-GCM
key is derived with HKDF from the bearer token, which the desktop sends to the
relay for authentication. The relay operator can derive that key and read the
traffic. Use only a trusted relay operator and TLS for non-loopback connections.

The relay stores token hashes in SQLite, but also caches plaintext bearer tokens
in process memory. It sees room identifiers, connection metadata and plaintext
push hints, including the reason and session identifier.

True E2E requires an encryption secret independent of authentication, delivered
out-of-band and never sent to the relay. A QR URL fragment can carry that secret,
but JavaScript served by the page's origin can read it. Protection against an
actively malicious relay operator also requires an independently trusted client
distribution origin or signed client. That design is not implemented here.

Do not expose this prototype as a public service: reliable recovery and the
complete mobile transport still need validation and completion. Room admission
requires a valid first-frame bearer, binds both peers to the same token and
enforces room capacity and per-token room limits atomically. Existing test source is not evidence of production readiness.

## Local development

Build this standalone package with the repository's required Rust build tooling
and scheduler. Run the resulting `tuic-relay` binary with an explicit loopback
bind and a database in an isolated scratch directory:

```sh
./target/debug/tuic-relay --bind 127.0.0.1:8080 --db-path ./relay.db
```

The binary path depends on the build tooling's target directory. Do not connect
a production FastAF instance to a development relay.

### Implemented configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `RELAY_BIND` | `0.0.0.0:8080` | Listen address; override with loopback for local work |
| `RELAY_DB_PATH` | `./relay.db` | SQLite database |
| `RELAY_VAPID_PRIVATE_KEY` | unset | Optional base64url, unpadded raw ES256 private scalar (32 bytes) |
| `RELAY_VAPID_SUBJECT` | `mailto:admin@tuicommander.com` | VAPID contact URI; set your own for push |
| `RELAY_SESSION_TIMEOUT_SECS` | `3600` | Idle-room timeout |
| `RELAY_RATE_LIMIT_PER_HOUR` | `10` | Registrations per source IP per hour; zero disables limit |
| `RELAY_MAX_SESSIONS_PER_TOKEN` | `5` | Concurrent rooms per token; zero disables limit |

Push is disabled without a VAPID key. The key parser expects raw scalar bytes,
not a PEM file or a DER-encoded EC key. The CLI has no `generate-vapid`
subcommand, admin-key option or global-stats endpoint. A reproducible key
provisioning flow and public-key discovery remain part of future onboarding.

### Implemented routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Returns `ok` |
| POST | `/register` | Rate-limited token registration |
| GET | `/stats` | Bearer-authenticated token statistics |
| WS | `/ws/{session_id}` | Peer room; desktop sends `Bearer <token>` as first text frame |
| POST | `/push/subscribe` | Bearer-authenticated push subscription |
| DELETE | `/push/subscribe` | Bearer-authenticated subscription removal |

These are the implemented surfaces, not a claim that admission and accounting
meet the intended service contract. In particular, HTTP token lookup uses an in-memory cache, and forwarding does
not accumulate byte statistics correctly. Anonymous peers and peers with a
different room-owner token are rejected with close code 4003. A full room uses
4001; creation beyond the token room limit uses 4002. Joining an existing room
does not consume another room allowance. Idle eviction terminates both socket
directions. Forwarding and cleanup check the admitted channel identity, so an
expired socket cannot access or remove peers in a recreated room.

## Desktop configuration

The Cloud Relay section in Remote Access settings supports enable/disable, URL,
a pasted registration token, room ID regeneration and relay connection status.
The backend supervisor applies connection-setting changes live; the current UI
restart warning is stale. A connected indicator means the relay handshake
completed, not that the mobile transport is available. Registration is not
performed by the settings UI, and the direct-access QR is not relay pairing.

## Packaging and self-hosting status

`Dockerfile`, `docker-compose.yml` and `Caddyfile` are prototype packaging inputs,
not a validated production recipe. The Caddy example names the public relay
domain: do not run it unchanged, request certificates for that domain or deploy
it without explicit hosting approval. The relay binds plain TCP; a non-local
service needs separately configured TLS termination and operational policy.

No image-size, startup-time, memory or concurrent-user performance guarantee is
established. A complete self-host reference must include trusted PWA delivery,
authentication/admission verification, independent E2E pairing, key provisioning,
reconnect recovery and push integration before it can promise phone access.

## Source map

- `src/main.rs`: CLI and startup
- `src/routes.rs`: HTTP and WebSocket routes
- `src/relay.rs`: admission, rooms, forwarding and idle cleanup
- `src/auth.rs`: token generation and hashing
- `src/db.rs`: SQLite storage and statistics
- `src/push.rs`: VAPID and push delivery
- `src/types.rs`: wire metadata and subscription types
- `tests/relay_core.rs`, `tests/auth_db.rs`: existing integration tests

## License

MIT — same as FastAF.
