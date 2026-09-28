# Public Queue

**Your local models. Any frontend. No open ports.**

An outbound-only agent connects Ollama, LM Studio, llama.cpp, oMLX, vLLM and compatible inference servers to a persistent job API. A small browser SDK encrypts requests and retrieves results, even after the page is refreshed.

**Status: deployable SaaS implementation; public infrastructure and real payments not yet verified.** Includes a sales website, email-link accounts, customer dashboard, Free/Premium quotas, Stripe Checkout/portal/signed webhooks, downloadable SDK/agent and a durable encrypted SQLite queue. Premium is €29/year; encrypted progressive text and existing-chat fetch adapters are included. The npm packages are `@lucamattiazzi/public-queue-sdk` and `@lucamattiazzi/public-queue-agent`.

Source: [GitHub](https://github.com/lucamattiazzi/public-queue). See [publishing instructions](docs/PUBLISHING.md) for package validation and npm release requirements.

## macOS app

The standalone macOS app includes its runtime, runs the agent in the menu bar, and opens the local queue dashboard in your browser. See [installation and pairing](docs/README-MACOS.md). The current preview supports macOS 14+, Apple Silicon and Intel; it is ad-hoc signed and not notarized yet.

The Mac app also supports [multiple model destinations and execution profiles](docs/README-PROFILES.md): request `profile:fast` or `profile:quality` from your frontend, and choose the actual endpoint locally. Cloud destinations require explicit approval; there is no automatic fallback.

## Developer packages

```sh
# In your frontend project
pnpm add @lucamattiazzi/public-queue-sdk
# On the machine running your model (Node.js 24+)
npm install -g @lucamattiazzi/public-queue-agent
```

Pair the agent using your relay console before running `pq-agent start`.

## Accounts: Free, Premium and your private Owner exemption

- [Create your account and use it without commercial quotas](docs/README-ACCOUNT.md)
- [Connect Stripe, activate Premium and maintain renewals](docs/README-STRIPE.md)
- [Free / Premium / Owner limits](docs/README-PLANS.md)

Set `PQ_OWNER_EMAILS=your-email@example.com` in the server's private `.env`, recreate the container, then sign in with that verified email. Owner needs no subscription and bypasses commercial quotas; protocol safety limits remain. This also works for an existing account. Other users remain Free until a verified Stripe payment grants Premium.

## Deploy and sell on Hetzner

See [the deployment guide](docs/DEPLOYMENT.md) and [Stripe setup + monetization](docs/MONETIZATION.md). The site lives at `/`, customers register at `/login/` and manage devices/billing at `/app/`. Legacy owner-key access is at `/console/`.

```sh
node scripts/setup-env.mjs
# Complete .env: domain, legal identity, SMTP; Stripe is optional for a free-only launch.
node scripts/preflight.mjs
docker compose -f compose.hetzner.yaml up -d --build
```

Only Caddy publishes internet-facing ports. Keep the SQLite and Caddy volumes. Builds include `/downloads/agent.tgz`, `/downloads/sdk.tgz` and `/downloads/source.tgz`; publication to npm is not required. Docker, real SMTP/Stripe and real-runtime validation remain deployment acceptance steps, not claims established by local unit tests.

## Try it in two minutes

Prerequisites: Node.js **24+**, pnpm **11**.

```sh
pnpm install
pnpm build
pnpm demo
```

Open the printed URL with `/console/` appended. Paste its connection JSON into **Playground → Browser connection**, use model `demo-model`, and send a prompt. Refresh and open the saved job. The demo uses a **simulated inference server** and a temporary in-memory database; it is explicitly not evidence of real runtime compatibility.

## Use your own model

Start the durable server (SQLite on local disk):

```sh
export PQ_ADMIN_TOKEN="$(openssl rand -hex 32)"
pnpm dev
```

1. Open `http://127.0.0.1:8787/console/`. Under **Hosting this service yourself?**, use the administrator key to create a project. Save its owner key.
2. Choose a device name and runtime; create a pairing code.
3. Build and install the agent tarball, or run from this checkout:

```sh
pnpm agent connect --server http://127.0.0.1:8787 --code YOUR_CODE --runtime ollama
pnpm agent start
```

4. Copy the **device public key from the agent** into the console. Create a browser connection and save it privately.
5. Use **Open in playground**, enter the exact model ID selected during agent setup, and submit a job.
6. For background operation after installing the agent package: `pq-agent service install`. This installs a macOS LaunchAgent or Linux user service. No service is installed merely by installing the package.

Relay connections are outbound-only. The optional local dashboard listens only on a random loopback port; `start --headless` opens no listening port. `connect` checks `/v1/models`, asks which model to allow, and saves a mode-0600 configuration including its private key. Local runtime authentication uses `PQ_RUNTIME_KEY` at pairing time. The runtime URL and model allowlist are configured **on the device**, never by a queued request.

## Local dashboard and macOS menu bar

On macOS, `pq-agent start` opens a local browser dashboard and a menu bar icon.
See pending/running jobs and recent outcomes without exposing your computer.
The icon reopens the dashboard and can quit the agent. Use `start --no-open` to
keep the icon without opening a browser, or `start --headless` for worker-only mode.
`pq-agent gui` monitors an already-running agent without starting another worker.
The macOS login service runs with the icon but does not open a browser automatically.
See [local app setup and upgrades](docs/README-LOCAL-APP.md).

| Runtime preset | Default base URL |
|---|---|
| `ollama` | `http://127.0.0.1:11434/v1` |
| `lmstudio` | `http://127.0.0.1:1234/v1` |
| `llama.cpp` | `http://127.0.0.1:8080/v1` |
| `omlx` / `vllm` | `http://127.0.0.1:8000/v1` |

Ports are presets, not discovery guarantees. Override with `--runtime-url`. For SGLang, LocalAI, llamafile or other compatible servers use `--runtime custom --runtime-url URL`. Compatibility requires `GET /models` and non-streaming `POST /chat/completions` under the configured base, with text messages and `choices[].message.content`; streaming additionally requires OpenAI-compatible SSE deltas, a finish reason and `[DONE]`. Tool calls, vision, reasoning-specific formats and proprietary APIs are not promised.

Text requests can also carry `response_format` (`json_object` or `json_schema` with `name`, optional `strict`, and `schema`) and `chat_template_kwargs: { enable_thinking: false }`. Rebuild both SDK and agent to use these optional fields; the runtime must support them. Prompt Chess uses them with llama.cpp for bounded strategy compilation. The relay still transports opaque encrypted payloads: this does not turn the stock chat agent into a general Python/model job runner.

## Keep your existing chat SDK

Use `createOpenAIFetch(queue)` with the OpenAI JavaScript SDK, or `createUIMessageFetch(queue, { model })` with Vercel `DefaultChatTransport`. These adapters retain E2E encryption while presenting standard streaming responses to the existing UI. See [the complete integration and resume examples](docs/README-FRONTEND.md).

The relay transports persisted encrypted blocks through cursor polling; the adapters expose SSE-compatible streams locally. Support is intentionally limited to text Chat Completions and text UI messages. Responses API, tools and images are not supported.

## Add it to your frontend

Install the built SDK tarball in your frontend project, then:

```ts
import { PublicQueue } from '@lucamattiazzi/public-queue-sdk';

// Obtain this user's private connection from login or an explicit paste/pairing UI.
// Never hardcode a shared token into a publicly served bundle.
const connection = {
  server: 'https://queue.example.com',
  token: userProvidedClientToken,
  deviceId: deviceIdFromPairing,
  publicKey: publicKeyCopiedFromAgent,
};
const queue = new PublicQueue(connection);
const job = await queue.submit({
  model: 'your-installed-model',
  messages: [{ role: 'user', content: 'Explain durable queues.' }],
});
localStorage.setItem('last-job', job.id);
const result = await queue.wait(job.id, {
  onUpdate: job => console.log(job.status),
});
console.log(result.text);
```

After refresh, construct the client with the same connection and call `wait(savedJobId)` or `list()` and `result(job)`. The default browser key store uses IndexedDB and non-extractable Web Crypto keys. It survives refresh; clearing site data or switching browsers loses the decryption key. A new browser cannot decrypt previous results merely by knowing the token.

`submit` retries transient failures with the **same ciphertext and ID**. Calling `submit` again creates a new job; passing an already-used ID with newly encrypted contents returns an idempotency conflict. If acceptance is uncertain, use `get(id)` or `list()` before resubmitting. `wait` retries temporary network failures with bounded backoff; if it stops, the server job continues. `cancel(id)` cancels the queue item and signals the agent on its next heartbeat; provider-side cancellation is best effort.

No build tool? See [examples/static](examples/static). The service also serves the browser bundle as `/sdk.js`; self-host that reviewed file with your frontend for stronger separation from the queue operator.

## Installable packages

```sh
pnpm build
mkdir -p dist/tarballs
(cd dist/packages/agent && pnpm pack --pack-destination ../../tarballs)
(cd dist/packages/sdk && pnpm pack --pack-destination ../../tarballs)
# On the inference machine, after copying the tarball:
npm install -g ./public-queue-agent-0.1.0.tgz
pq-agent --help
```

The agent package bundles its JavaScript dependencies; it only requires Node 24+. The SDK provides ESM and TypeScript declarations. Package publication, registry name ownership and signed native installers have not been performed. The server runs from this repository or the included Dockerfile.

## What is durable?

- Jobs are committed to SQLite with WAL and synchronous FULL before acknowledgment.
- Offline jobs wait until their deadline (default 24 hours, maximum 7 days).
- One active inference per device. A 60-second lease is renewed while inference runs.
- Lease expiry requeues unfinished work, with a maximum of three attempts. Old attempts cannot complete a newer attempt.
- Completed ciphertext is retained for 1 day on Free and 7 days on Premium/legacy operator projects. Expired/cancelled request bodies are discarded; successful requests are replaced by encrypted results.
- A logical storage budget (16 MiB Free / 256 MiB Premium or legacy) reserves room for each pending result; body and job-count limits apply separately.
- Client revocation cancels its pending jobs. Device revocation cancels all of that device's pending jobs.
- At-least-once execution, **not exactly-once inference**. A disconnect after inference but before durable completion can run the model again. Repeated completion of the same attempt is idempotent.
- Single server with durable local disk. No horizontal scaling, database replication or host-loss protection without backups.

## Security and privacy

E2E encryption is enabled by default on the SDK, agent and newly created project. Payloads use Web Crypto ECDH P-256, HKDF-SHA256 and AES-256-GCM with per-job/direction derived keys. Job/device/direction are authenticated as associated data. Device keys must be pinned from the agent, not silently fetched and trusted from the relay.

The operator sees timing, sizes, identifiers, status and retry counts. It does not receive model names, prompts or results in plaintext for encrypted jobs. Server and runtime network errors are sanitized. The service can still deny, delay or replay work; encryption does not make the relay an availability authority you can distrust without consequences.

The console runs code served by the operator. A malicious operator who changes that code could steal plaintext before encryption. For that threat model, host a reviewed SDK and frontend separately and verify the device key out of band. This implementation has not received an independent cryptographic audit and does not claim forward secrecy or metadata privacy. See [security model](docs/SECURITY.md).

## Operate and contribute

- [Deployment, TLS, backups and agent services](docs/DEPLOYMENT.md)
- [API and architecture](docs/ARCHITECTURE.md)
- [Product scope](docs/PRODUCT.md)
- [Payments and monetization](docs/MONETIZATION.md)
- [Verification record and known limits](docs/VALIDATION.md)

Focused checks:

```sh
pnpm test:core
pnpm test:integration
pnpm exec tsc --noEmit
pnpm build
```

MIT licensed. There is no dependency on HiveCore/HiveNode and no code has been copied from them.
