# Validation record — 20 September 2026

## Verified locally

- TypeScript package declaration build and bundled server, browser SDK, agent, sales site, login, legal page and customer dashboard.
- Targeted type checking of changed frontend modules and new account/billing/site/migration tests.
- 24 targeted non-browser tests across account authentication, consent, one-use browser-bound links, expiry, logout/deletion, monthly quotas across retention, downgrade/upgrade, additive v1 migration, signed Stripe webhooks, raw HTTP body verification, duplicate/stale events, concurrent checkout and recovery of a remote checkout session.
- Existing impacted queue/store, online backup and HTTP integration tests pass: persistence across restart, encryption boundary, client/device isolation, redelivery and lease fencing, bounded retries, cancellation/revocation and storage reservation.
- HTTP serving checks for `/`, `/login/`, `/app/`, `/console/`, `/legal/`, browser assets and downloadable archives; `.env` is not publicly served. Missing SMTP/billing configuration disables those features.
- Real TCP HTTP smoke against the compiled preview: login email saved to a local private file, token redemption with cookies, Free account, device creation, account deletion and session revocation. **No external email sent.**
- The downloadable `agent.tgz` and `sdk.tgz` installed in an isolated consumer with npm. SDK import/types and agent CLI execution passed. These are the actual archives served by the site, not only workspace imports.
- Both Compose YAML documents parsed successfully. This is syntax validation, not a Docker deployment test.

The queue integration test uses a deterministic OpenAI-compatible **test runtime**. It validates transport and lifecycle, not a real model's compatibility, quality or performance. Billing tests use real Stripe SDK signature primitives with synthetic events and mocked outbound API methods, not purchases in a Stripe account.

## Not verified externally

- Docker is unavailable here: image build, container volume permissions, Caddy certificate issuance and a real Hetzner deployment remain to be verified on the target host.
- No production domain, SMTP delivery, Stripe account credentials, Checkout test purchase, portal configuration, tax settings or live payment were provided. These are configured and accepted using [DEPLOYMENT.md](DEPLOYMENT.md) and [MONETIZATION.md](MONETIZATION.md).
- Real Ollama, LM Studio, llama.cpp, oMLX and vLLM inference has not been established by this work. Presets are configurable; verify each advertised runtime using the checklist below.
- No new browser/visual QA was run for the sales site and account UI. Prior console browser tests have been retargeted to `/console/` but were not rerun in this turn. HTTP route checks and frontend compilation do not certify layout or interactive browser behavior.
- No load test, independent security/cryptographic audit, host-loss/power-loss recovery drill, disk-full failure test or multi-host failover.
- Background service installers were not run against this machine's service manager. No npm publication, registry name reservation or signed native GUI installer.
- Model downloads/management, tool execution, multimodal jobs, Windows GUI service installation and E2E key recovery are not implemented.

## Focused commands

```sh
pnpm exec tsx --test tests/accounts.test.ts tests/billing.test.ts tests/saas.test.ts tests/site.test.ts tests/migration.test.ts
pnpm exec tsx --test tests/store.test.ts tests/integration.test.ts tests/backup.test.ts
pnpm build
pnpm smoke:packages
```

Build before the site test. Existing browser checks can be run when browser QA is requested; they require Chromium. Do not treat them as executed evidence for this release.

## Real-runtime and payment acceptance

1. Start a supported text model on a loopback-only inference server; pair the agent and run `pq-agent doctor`.
2. Submit while the agent is stopped, close the browser, restart the relay, start the agent and retrieve the original job ID/result.
3. Interrupt inference and verify redelivery and stale-attempt fencing. Revoke a client/device and verify access is denied.
4. Sign up through actual SMTP. Purchase Personal in Stripe test mode; confirm quotas change only after verified payment. Replay events; cancel renewal; test failed payment and expiration.
5. Verify HTTPS, off-host backup and isolated restore. Monitor disk, email delivery and failed webhooks before inviting paying users.

## Free / Premium / Owner refinement

The public paid plan is now displayed as Premium; its API ID remains `personal`. Additional focused checks cover the private `PQ_OWNER_EMAILS` exemption, more than the legacy device/client/pending quotas, retained Owner job records, rejection of Owner checkout, hidden private allowlist, strict rejection of a forged signup plan, email validation, and granting/revoking Owner on an existing account across server restarts. A Stripe lifecycle test covers first payment, renewal, scheduled cancellation, failed renewal and local expiry. These use synthetic Stripe events/API responses, not a real payment.

Changed frontend and test modules passed targeted TypeScript checking; package build and source/download archives were regenerated. Configure your actual verified email in `.env` to activate Owner. No personal email was guessed or account precreated.


## Encrypted progressive streams and existing-chat adapters

New focused tests verify durable block persistence across SQLite reopen, sequence and idempotency checks, client isolation, lease fencing, retry/reset behavior, payload reservation/bounds, and authenticated attempt+sequence encryption. The bounded SSE parser is tested with byte-split UTF-8, CRLF, comments, multiline events and truncation.

Real HTTP integration uses a deliberately synthetic runtime plus the actual OpenAI JS 7.19.0 and AI SDK 7.0.107 packages. A gate holds inference open so the test proves a decrypted delta is delivered while the job is still running. Tests cover cursor continuation without duplicated blocks, ciphertext-only relay data, normal JSON completion, replay without another runtime call, valid Vercel UI events, unsupported request rejection, retry-attempt separation, observation abort without job cancellation, truncated runtime failure and HTTP authorization error propagation.

These results do not validate a real Ollama/oMLX/LM Studio/vLLM installation, browser React rendering, or every SDK feature/version. Relay-to-browser delivery uses cursor polling; SSE compatibility is supplied by the frontend adapter. DefaultChatTransport's automatic GET reconnect is not implemented; explicit job replay/native cursor resume is documented. Streaming uses schema v3; update both relay and agent after backing up.
