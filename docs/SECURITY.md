# Security model

## Boundaries

There are four credentials: operator bootstrap key, project owner key, device bearer token, and client bearer token. Operator and owner keys never belong in a published frontend. Tokens are random 256-bit values; the service stores SHA-256 hashes. Pairing codes expire after ten minutes and are consumed transactionally once. Authorization is checked at every route; job reads are scoped to the creating client, not simply to anyone in the project.

A client capability authorizes the holder to submit work to one device and read its own jobs. A static frontend cannot keep a shared credential secret. The pilot accepts a user-supplied connection; embedding it into public source grants visitors that capability. Applications with their own users should provision a distinct client token per user/device through a trusted backend or login service. That login integration is not part of this preview.

The agent authenticates only outbound to the public service. Inference endpoints are fixed by local configuration, with an explicit model allowlist; payloads cannot set URLs, paths, headers, credentials or tool execution. HTTP redirects are refused. Keep the model server listening on loopback where possible. The CLI permits an explicitly configured LAN endpoint but never discovers or scans the LAN.

## End-to-end encryption

Both sides use P-256 ECDH identities. Shared key material is passed through HKDF-SHA256, salted by job ID, with version/device/job/direction in its context (plus attempt and sequence for stream blocks), to derive an AES-256-GCM key. Request and response use different derived keys and random 96-bit IVs. Context is also authenticated as GCM additional data. Public keys are raw uncompressed P-256 points encoded as unpadded base64url.

The request contains the browser public key, IV and ciphertext; the response contains the device public key, IV and ciphertext. SDK responses must match the pinned device identity. A changed job ID, direction, device or ciphertext fails authentication. Browser private keys are non-extractable CryptoKeys in IndexedDB; agent keys are stored in a mode-0600 local configuration, inside a directory created with mode 0700. Agent keys are exportable at creation to persist them, then reimported non-extractable for execution.

The browser public key is supplied through the relay, so the agent does not gain independent cryptographic proof of the end user's identity. A malicious relay can create its own requests to the agent. E2E here protects contents from passive observation and response forgery for an honest client's pinned key; it is not authorization against a malicious control plane. Limits and model allowlists reduce what such requests can do. Signed, out-of-band-authorized client identities would be required to exclude a malicious relay from using compute.

Device keys are copied from `pq-agent key` through a trusted channel. Silently fetching the key from the relay would let that relay substitute a key. The console checks equality against the registered key for usability, but its trust comes from the user copying/verifying the local value.

There is no forward secrecy: compromise of a device private key can reveal retained ciphertext addressed to that key. Browser storage loss makes previous results unreadable. There is no automatic key escrow or cross-browser recovery. Pair a new device to rotate its key; queued jobs for the old device must be cancelled/recreated explicitly.

A compromised browser origin can access plaintext and use its CryptoKeys even though keys cannot be exported. Host reviewed frontend code and the SDK independently of the queue operator if the operator is in the threat model. Changing a remotely loaded SDK defeats that separation. HTTPS remains required for authentication, metadata, and code integrity.

## What the service sees

Job/client/device/project identifiers, timestamps, status, attempt count, sizes, IP addresses at the network edge, public encryption keys and generic error codes. Model ID, messages and final response are inside the ciphertext. Do not log full request/response bodies at a reverse proxy or APM layer. The included API logger is disabled and errors do not echo validation input.

Plaintext is an explicit opt-in: create the project with `requireEncryption:false`, initialize the SDK with `encrypted:false`, and pair the agent with `--allow-plaintext`. All three policies must permit it. The web console creates encrypted projects only. Deleting plaintext jobs is not secure erasure of SQLite/WAL/backups; for confidentiality use E2E from the outset.

## Reliability and abuse

At-least-once inference can duplicate computation after a lost completion. Leases and attempt IDs prevent stale completion from replacing a newer result; cancellation reaches a running agent through its heartbeat and aborts its HTTP request, but the runtime might keep computing. There is no remote management or shell execution.

The single-server pilot has per-project daily/pending quotas and plan-specific logical payload budgets (2 MB reserved per pending completion, or 4 MB for streaming), body-size limits, bounded response reads, deadlines and an IP rate limit. It has no automatic signup, preventing arbitrary tenant creation. The service is not ready for open anonymous signup or unrestricted paid plans: add billable egress metering, fleet/global capacity limits, audited auth and operational monitoring first.

No independent penetration test or cryptographic audit has been performed. This is a documented implementation, not a certified security claim.

The logical payload budget is not a filesystem size cap: SQLite metadata, WAL, free pages, backups and multiple projects consume additional disk space. Monitor disk capacity and checkpoint/backup behavior operationally.

## SaaS identity and payments

Login links use random 256-bit secrets hashed at rest, expire in 15 minutes and require the requesting browser's HttpOnly challenge cookie. Redemption is a same-origin POST, not a link-fetch action; the token is carried in a fragment and removed from browser history by the login page. Sessions are hashed at rest, expire after 30 days and use Secure, HttpOnly, SameSite=Lax host cookies on HTTPS. All cookie-authorized mutations validate the exact configured Origin. Browser-held client tokens remain bearer credentials: do not embed shared tokens in public frontend bundles.

Verified email and per-email/IP/global limits reduce signup abuse but do not prove a person is unique. Default account capacity is intentionally bounded for launch. SMTP and Stripe are external dependencies; availability of the queue does not imply their availability. Production configuration requires operator identity and provider disclosure.

Checkout amounts and price IDs are server-controlled. Stripe webhook signature verification uses the unmodified raw body; duplicate events are durable, and the server retrieves current subscription state to handle reordered notifications. The Checkout success URL never grants access. Refunds and disputes require operational handling; refunding a payment alone does not cancel its subscription. No card data is handled by the application.

Deleting an account closes open checkouts and cancels subscriptions before erasing local data. Existing backups and provider financial records follow their stated retention policies. This implementation does not configure a backup destination, tax registrations or legal compliance for the operator.

Progressive stream blocks have independent random IVs and authenticated attempt/sequence context. Job identity, attempts, ordering, ciphertext sizes and timing remain visible to the relay. Stream storage is bounded and charged to the project budget; observing a job and cancelling it are separate actions.
