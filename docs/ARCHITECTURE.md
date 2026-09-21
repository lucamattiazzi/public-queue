# Architecture and HTTP contract

```text
Static frontend + SDK ── HTTPS ──> Public Queue API ──> SQLite WAL
                                      ↑
Local agent ───────────── HTTPS ───────┘
    └── loopback HTTP ──> inference server
```

A single TypeScript server owns authentication, durable queue state and quotas. SQLite transactions atomically claim work; no broker is exposed. One active job is allowed per device. All client and agent traffic is ordinary outbound HTTP. The agent polls every 2.5 seconds when idle with bounded exponential reconnect backoff; browser wait polls every 2 seconds. Polling is deliberate in this first version; long polling or notifications can reduce idle request volume later without changing job semantics.

## Source layout

- `packages/protocol`: validated text-chat schema, job types, Web Crypto envelopes.
- `packages/server`: Fastify HTTP API and SQLite transactional store.
- `packages/agent`: portable CLI, pairing, runtime discovery, lease renewal, model calls, local services.
- `packages/sdk`: browser-safe client with durable job handles and IndexedDB identity storage.
- `apps/web`: framework-free owner console and playground.
- `examples/static`: a separately hosted HTML/JS consumer.

There is no frontend framework dependency, model-specific SDK, Redis or NATS service to install. The compatibility boundary is text chat over `/v1/chat/completions`, not “every feature of the OpenAI API”.

## HTTP routes

Every authenticated route accepts `Authorization: Bearer TOKEN`. No cookie authentication, credentials in URLs or wildcard resource authorization.

| Route | Credential | Purpose |
|---|---|---|
| `GET /health` | None | Liveness |
| `POST /v1/projects` | Operator | `{name, requireEncryption?}` → project ID and owner token |
| `GET /v1/project` | Owner | Project, device status and client list; no secrets |
| `POST /v1/devices` | Owner | `{name}` → device ID and one-time pairing code |
| `DELETE /v1/devices/:id` | Owner | Revoke device and cancel unfinished jobs |
| `POST /v1/clients` | Owner | `{name, deviceId}` → scoped client token |
| `DELETE /v1/clients/:id` | Owner | Revoke client and cancel unfinished jobs |
| `POST /v1/pair` | One-time code | `{code, publicKey}` → device credential |
| `POST /v1/jobs` | Client | `{id, payload, ttlSeconds?}` → 202 and durable job |
| `GET /v1/jobs` | Client | Latest 100 jobs belonging to this client |
| `GET /v1/jobs/:id` | Client | State and encrypted result, if complete |
| `DELETE /v1/jobs/:id` | Client | Cancel a queued/running job |
| `POST /v1/agent/claim` | Device | `{}` → `{job: Assignment | null}` |
| `POST /v1/agent/jobs/:id/heartbeat` | Device | `{attemptId}` → extend valid lease |
| `POST /v1/agent/jobs/:id/finish` | Device | `{attemptId, result, success}` → durable completion |

An encrypted payload is `{mode:"encrypted", data:{version:1, publicKey, iv, ciphertext}}`. A plaintext payload is `{mode:"plain", data:...}`. Cleartext chat supports `model`, text `messages`, optional `temperature`, `max_tokens` and `stream`. Responses are `{text, finishReason}`. Tool execution, embeddings and multimodal payloads are not implemented.

Errors use `{error: CODE}` with HTTP 400/401/404/409/413/429 as appropriate. A stale attempt receives `409 lease_lost`. Job IDs are client-generated UUIDs. Duplicate IDs with the same submitted payload/TTL return the existing job; conflicting payloads are rejected. Retention deletion also ends that ID's idempotency window.

## State machine

`queued → running → succeeded|failed`; missing lease returns work to `queued` until three attempts have been made. Deadline moves queued/running jobs to `expired`. Explicit cancellation moves them to `cancelled`. Terminal jobs never return to running. Polling expired or retained data also triggers housekeeping, and a periodic sweep runs every 30 seconds.

Infrastructure interruption uses bounded redelivery. Explicit provider errors finish the job as failed, with an encrypted sanitized error, rather than repeatedly executing known-invalid requests. Max inference time is ten minutes per attempt; accepted jobs may wait offline for their separately configured TTL.

## Scaling boundary

The SQLite deployment requires local persistent storage and one service instance. Backups protect host failure; WAL does not replace backups or replication. For multiple servers, migrate the store to a transactional shared database with atomic claim/lease fencing. Keep the SDK and agent protocol stable. Do not mount the SQLite database on NFS or assume a Docker restart recovers a deleted volume.

## Customer accounts and subscriptions

Schema v2 adds accounts, hashed sessions, browser-bound email links, billing event deduplication and email send counters on the same SQLite connection. Existing v1 owner-key projects keep their original quotas. A verified new account creates one encrypted project; customer management routes accept an HttpOnly session with strict same-origin mutation checks. Legacy bearer routes remain supported.

`accounts.ts` owns identity, entitlements and account cleanup. `billing.ts` owns Stripe Checkout, portal and signature verification. Per-account in-process serialization plus durable checkout generations/idempotency keys prevent duplicate purchase creation on this single-process server. A lost checkout response is recovered from Stripe's open sessions. Webhooks fetch current subscriptions rather than applying arrival-ordered snapshots. Paid access has a local deadline; unpaid renewal never extends it. Configure alerts and retry failed webhook deliveries.

Plan definitions live in `packages/protocol/src/plans.ts`; the API supplies them to the sales site. Store submission enforces daily/monthly/pending/storage limits, and account creation enforces device/client counts. Downgrades pause extra devices/clients for new work without destroying keys; existing results remain readable within current retention. No plaintext prompt/model inspection is used for metering.

Public routes: `/v1/public`, `/v1/auth/request`, `/v1/auth/complete`, and Stripe-signature-only `/v1/billing/webhook`. Customer routes: `/v1/me`, `/v1/auth/logout`, `/v1/auth/revoke-sessions`, `/v1/account/export`, `DELETE /v1/account`, `/v1/billing/checkout`, `/v1/billing/portal`. Secrets are not returned by account export. `/` is marketing; `/login/` is email login; `/app/` is the customer dashboard; `/console/` retains legacy owner/admin access.


## Persistent encrypted text streams (schema v3)

Streaming submissions include public `stream: true` metadata plus the same flag inside the encrypted request; the agent checks agreement. `job_blocks` stores ciphertext by `(job_id, attempt_id, sequence)` with a cascading job foreign key. Append checks lease/deadline, stream mode, sender identity, strict contiguous sequence, idempotency and per-attempt byte/count bounds. A new claim discards previous-attempt blocks; cancelled/expired jobs discard their blocks; successful/failed blocks follow terminal job retention.

`POST /v1/agent/jobs/:id/blocks` appends; `GET /v1/jobs/:id/events?attemptId=UUID&after=N` returns the current attempt, at most 64 blocks, a job snapshot and `hasMore`. The authenticated client must own the job. A different current attempt restarts the cursor from zero. This endpoint uses short HTTP polling; it is not a server-side SSE connection.

The runtime emits SSE. The agent batches text, encrypts each block with attempt+sequence in the authenticated key context, and commits the ordinary encrypted final result separately. Incomplete runtime streams fail. The SDK `stream()` yields reset/delta/done updates and can resume from a cursor. The final result is canonical. Adapters implement OpenAI Chat Completions and Vercel UI Message SSE for existing frontend libraries; retry after already-emitted text causes an explicit error, not concatenation of attempts. No provider SDK dependency is added to the published runtime package.
