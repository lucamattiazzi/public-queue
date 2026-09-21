# Deploy Public Queue on Hetzner

This is a single-host deployment: Fastify + SQLite on a persistent volume, with Caddy for HTTPS. Only the relay is public. Home agents make outbound HTTPS requests; they never need port forwarding. Do not run multiple queue replicas or place SQLite on NFS.

## 1. Prepare the host and domain

Use an Ubuntu/Debian Hetzner server with Docker Engine and the Compose plugin installed using the [official Docker instructions](https://docs.docker.com/engine/install/ubuntu/). Choose a hostname such as `queue.your-domain.tld` and point its A record to this server **at your existing DNS provider**. Set AAAA only if IPv6 is configured correctly. Allow inbound 80/443 (and your existing SSH access); do not expose 8787 or model-server ports.

Copy this repository to the server, or extract `dist/web/downloads/source.tgz`. The source archive contains no `.env`, database, dependencies or credentials. No npm publication is needed. Docker builds the application and downloadable agent/SDK from source.

## 2. Configure

With Node 24+ installed on the host:

```sh
node scripts/setup-env.mjs
# Edit .env using your editor; the script refuses to replace an existing file.
node scripts/preflight.mjs
```

If the host has Docker but no Node, run those two scripts through:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work node:24-bookworm-slim node scripts/setup-env.mjs
# Edit .env, then:
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work node:24-bookworm-slim node scripts/preflight.mjs
```

Set:

- `PQ_DOMAIN` and `PQ_PUBLIC_URL` (HTTPS origin, no path/trailing slash).
- Operator's actual legal name, address, tax identifier/status and support email. `PQ_PROVIDER_DISCLOSURE` describes the actual Hetzner region, SMTP provider, Stripe, transfer arrangements and backup retention. The privacy page displays it as text. Review the supplied terms/privacy before public launch; they are templates, not a legal compliance certification.
- Authenticated SMTP on port 587 (STARTTLS required) or 465. Set `PQ_EMAIL_FROM` to a verified sender and configure SPF/DKIM/DMARC at your provider. Emails are required for self-service login and recovery.
- Stripe variables as described in [MONETIZATION.md](MONETIZATION.md). Leave **all three** empty for a free-only launch. Partially configured billing fails startup.
- `PQ_ORIGINS=*` permits user-owned frontends to use bearer-authenticated SDK calls. Account cookies never authorize cross-origin mutations. For restricted deployments, list allowed origins separated by commas.
- Initial signup cap is 100 accounts and 500 login emails/day across the deployment; change after measuring capacity. These are operational launch caps, not an anti-Sybil guarantee.

Keep `.env` mode 0600 and out of source control. Dollar signs and special characters in values must be quoted correctly for Docker Compose env files. Never print `docker compose config` in public logs: it can expand secrets.

For your own unlimited commercial-quota exemption, set `PQ_OWNER_EMAILS` to your exact verified login email. See [README-ACCOUNT.md](README-ACCOUNT.md). Other accounts still use Free/Premium quotas; Owner does not need Stripe. Its terminal results are not removed by age, so account for their disk usage in operations and your privacy disclosure.

## 3. Start HTTPS

Standalone server, with no existing listener on 80/443:

```sh
docker compose -f compose.hetzner.yaml up -d --build
docker compose -f compose.hetzner.yaml ps
curl --fail https://queue.your-domain.tld/health
```

Caddy obtains and renews the certificate. Its named data/config volumes must persist. The internal network is `172.29.83.0/24`; if it conflicts with an existing network, change both its subnet and Caddy's fixed address, plus `PQ_TRUST_PROXY`. The backend trusts only that reverse-proxy address.

**Existing reverse proxy:** use `docker compose up -d --build` instead. It publishes only `127.0.0.1:8787`. Configure your host Caddy/nginx to forward to it, using [Caddyfile](../Caddyfile) as a template. Set `PQ_TRUST_PROXY` to the actual proxy source IP as seen by the container. Do not run both compose variants simultaneously against the same data.

Never use `down -v` for an upgrade: it deletes the named volumes. Before upgrading, make and test a backup, then repeat `up -d --build`. Schema v1/v2 is migrated to v3 on startup without removing existing projects or owner keys. Back up before migrating; an older binary intentionally refuses a v3 database.

## 4. Verify the customer journey

1. Visit `/`, then `/login/`; request a real email and open the link in the **same browser**. Mail scanners cannot consume it just by fetching a URL. The URL fragment contains a one-use token and is removed by the login page.
2. In `/app/`, create a device. Install the agent on the model machine (Node 24+):

   ```sh
   npm install -g https://queue.your-domain.tld/downloads/agent.tgz
   # Run the pairing command copied from the dashboard.
   pq-agent doctor
   pq-agent start
   ```

3. Run `pq-agent key` locally and paste its public key into the dashboard. Create a client connection and try the playground. The server cannot recover lost E2E private keys.
4. For a frontend project: `npm install https://queue.your-domain.tld/downloads/sdk.tgz`. Use the example in `examples/static/`. Users supply their own connection; never hardcode a shared private client token in public JavaScript.
5. Stop the agent; submit a job; close the browser; restart the relay; start the agent; recover the same job ID/result. Test a real runtime, not only the synthetic integration fixture.
6. Complete Stripe's **test-mode** purchase/cancellation/failure journey before enabling live keys. Check that a return from Checkout alone cannot activate Premium.

The `/console/` route retains administrator/owner-key provisioning for self-hosted installations and migration. Legacy projects have the original operator quotas; customer accounts receive the Free/Premium plan. No customer-facing owner credential is needed for cookie-authenticated account management.

## 5. Run the agent in the background

After installing the actual built package, run `pq-agent service install` on macOS/Linux; `service uninstall` removes only its managed service. macOS starts at user login. Linux user services may need `loginctl enable-linger USER` to run while logged out. These commands do not install/start model servers or wake sleeping computers. Windows can run `pq-agent start` in a terminal or Task Scheduler; there is no Windows GUI installer.

Agent configuration/private keys are stored in `~/.config/public-queue/agent.json`, mode 0600. Optional `PQ_RUNTIME_KEY` is stored locally during pairing, not sent to the relay. Back up local private keys separately if recovery matters.

## Backups and restore

Use `VACUUM INTO`, not a raw copy of the live database without its WAL. Example for standalone Compose:

```sh
# Use a unique filename each time; existing destinations are rejected.
docker compose -f compose.hetzner.yaml exec -T queue node scripts/backup.mjs /data/queue.sqlite /data/backup-2026-09-20.sqlite
docker compose -f compose.hetzner.yaml cp queue:/data/backup-2026-09-20.sqlite ./backup-2026-09-20.sqlite
chmod 600 ./backup-2026-09-20.sqlite
```

Encrypt and copy the backup off-host using your established backup system, verify the copy, then remove the temporary plaintext copies. Automate daily backups, keep them at most 30 days (or change the published disclosure to your actual policy), and monitor backup failures. Encryption of backups, scheduling and remote retention are operator responsibilities; this repository does not invent a destination or credentials.

Restore with the queue service stopped. Preserve current DB/WAL/SHM together, replace the configured database with the backup, remove old WAL/SHM from the restored location, ensure owner `node` (UID 1000) and mode 0600, then restart. First perform a drill in an isolated copy: restored sessions and client credentials are live secrets. Server backups contain ciphertext and metadata, not browser/agent private keys.

## Operations and limits

Monitor HTTPS `/health`, disk availability, container restarts, memory, backup age, failed SMTP delivery and Stripe webhook delivery failures. Configure alerts outside the service. Inspect `docker compose ... logs --tail=100`; application request bodies and credentials are not logged. Caddy access logging is disabled by default. At-least-once execution means compute may repeat after an interruption.

Free: 1 device, 3 clients, 500 accepted jobs/month UTC, 50/day, 8 pending, 16 MiB logical payload budget, 1-day maximum deadline/terminal retention. Premium: 3 devices, 20 clients, 10,000/month, 1,000/day, 100 pending, 256 MiB, 7 days. Pending jobs reserve 2 MB each, or 4 MB for streaming (encrypted blocks plus final result). Monthly counters survive result deletion. Expired paid access uses Free quotas; existing devices/clients are retained so keys are not destroyed. The earliest active devices/clients within the Free limits remain usable; additional ones are paused for new work and resume on upgrade. Revoke older connections to change which fit the plan. Already running work can finish, and retained results remain readable. Extra connections must be revoked to create new ones. HTTP payload limit 1.5 MB; inference response limit 1 MB. Default deadline 24 hours.

The logical payload budget does not bound all SQLite/WAL/index space or network traffic. Capacity caps and alerts are still necessary. This version has one process, no HA, no attachment/tool execution and no inferred guarantee of compatibility with every runtime extension.

## Local SaaS preview without sending emails

```sh
pnpm install --frozen-lockfile
pnpm build
PQ_ADMIN_TOKEN=local-development-secret-at-least-32-characters PQ_PUBLIC_URL=http://127.0.0.1:8787 PQ_DEV_MAIL_DIR=.data/mail PQ_OPERATOR_NAME=Development PQ_OPERATOR_ADDRESS=Local PQ_OPERATOR_TAX_ID=Development PQ_SUPPORT_EMAIL=dev@example.invalid pnpm dev
```

Visit `http://127.0.0.1:8787/`. Login emails are saved to private `.data/mail/*.txt` files instead of being sent. Open the link from the newest file in the same browser. This mode rejects non-loopback URLs and production environments. It does not simulate a paid Stripe transaction.

## Streaming upgrade

Back up the database, deploy the rebuilt relay, then reinstall the current agent tarball on each inference machine. Schema v3 adds stream metadata and durable encrypted blocks. Older binaries refuse this newer database. See [README-FRONTEND.md](README-FRONTEND.md) for SDK adapters, stream limits and explicit resume. A direct downgrade requires restoring the pre-upgrade backup, losing subsequent writes.
