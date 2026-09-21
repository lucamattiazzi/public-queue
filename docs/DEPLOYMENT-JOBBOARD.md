# Personal deployment: jobboard.grokked.it

Deployment prepared on 2026-09-21 at `deploy@91.99.154.254`.

## Layout

- Sources: `/home/deploy/apps/public-queue`
- Compose: `/home/deploy/apps/public-queue-compose.yml`
- Container: `apps-public-queue-1`
- Database volume: `apps_public-queue-data`
- Shared Docker network: `apps_web`
- Shared proxy: `/home/deploy/apps/caddy/Caddyfile`
- Caddy backups: `/home/deploy/apps/public-queue-deploy-backups`

Only Caddy publishes host ports. The queue listens on port 8787 inside Docker.
The compose template is in `deploy/hetzner/public-queue-compose.yml` and assumes
installation in `/home/deploy/apps`, next to the other compose files.

## DNS and first access

The A record `jobboard.grokked.it` points to `91.99.154.254` and Caddy has
obtained a valid public certificate. Public HTTPS was verified using curl with
`--resolve jobboard.grokked.it:443:91.99.154.254` and certificate validation enabled.
Some local resolvers still cache the earlier NXDOMAIN until their negative TTL
expires. Once your resolver updates, verify normally:

```sh
curl --fail https://jobboard.grokked.it/health
```

Open `https://jobboard.grokked.it/console/`. The root redirects there.
A project named `Personal` has already been provisioned with mandatory encryption.
Its private owner token is in `.data/personal-access.json` on the server, mode 0600.
Copy the token into the console's **Owner key** field. On your Mac:

```sh
ssh deploy@91.99.154.254 \
  'python3 -c '\''import json; print(json.load(open("/home/deploy/apps/public-queue/.data/personal-access.json"))["ownerToken"])'\''' \
  | pbcopy
```

This copies the token to your clipboard without printing it in the terminal.
Do not share it or include it in frontend source. The separate administrator
secret is in the server's private `.env`; routine use needs only the project token.

If DNS is still pending, a temporary SSH tunnel permits local access. Obtain the
container IP (Docker service names are not resolved by the SSH host):

```sh
queue_ip=$(ssh deploy@91.99.154.254 \
  'docker inspect apps-public-queue-1 --format '\''{{(index .NetworkSettings.Networks "apps_web").IPAddress}}'\''')
ssh -N -L "18791:$queue_ip:8787" deploy@91.99.154.254
```

Then open `http://localhost:18791/console/`. This is a temporary local origin;
browser keys and credentials do not transfer automatically to the HTTPS domain.
Prefer waiting for HTTPS before pairing your permanent client.

## Connect a local model

On the inference machine, with Node 24+ and your runtime already running:

```sh
npm install -g https://jobboard.grokked.it/downloads/agent.tgz
# Create a device in the console and run its pairing command.
pq-agent doctor
pq-agent start
```

Verify the public key from `pq-agent key` in the console, create a client connection,
and test the playground with the exact local model ID. No real inference machine
has been paired as part of this deployment.

## Current mode and limits

This uses the existing personal project/owner-token mode, not an email-verified
SaaS Owner account. `PQ_PUBLIC_URL` is deliberately unset, so SaaS routes, email
registration and Stripe billing are disabled. No operator identity or SMTP
credentials have been invented. The proxy redirects the landing page to the console
and rejects account pages while this mode is active.

Legacy project limits apply: 1,000 jobs/day, 100 pending, 256 MiB logical payload
budget, 10 devices, 100 clients and seven-day terminal retention. Streaming reserves
4 MB per pending job. This is **not** the unlimited commercial-quota Owner plan.
To enable that plan, configure SaaS operator/SMTP settings and your verified email
in `PQ_OWNER_EMAILS`, then use the account dashboard. Existing project credentials
are not automatically migrated into an email account.

The container has a 384 MiB memory limit and half a CPU, with rotated Docker logs.
These are initial resource caps, not a load-tested capacity promise. `PQ_TRUST_PROXY`
currently trusts Caddy's observed IP `172.18.0.2`; review it if Caddy is recreated
with a different network address.

## Operations

```sh
cd /home/deploy/apps
docker compose -p apps -f public-queue-compose.yml ps
docker compose -p apps -f public-queue-compose.yml logs --tail=100 public-queue
docker compose -p apps -f public-queue-compose.yml up -d --build public-queue
```

Compose may list the other sites as orphans because they share project `apps`.
Never use `--remove-orphans`, and never use `down -v`.

Before upgrades, follow the SQLite online backup procedure in `DEPLOYMENT.md`,
using this compose filename and the `public-queue` service. No scheduled or off-host
backup has been configured. The deployment check created a temporary backup,
verified its SQLite integrity and project record, then removed that test backup.

## Verified

- Docker build and container health check.
- Public HTTPS certificate, health, console and Plausible script/CSP integration.
- Console, browser SDK and downloadable agent/SDK return HTTP 200 internally.
- Unauthenticated project API returns HTTP 401.
- Project and owner-token access survive a container restart.
- Online database backup integrity.
- Shared Caddy configuration validates and reloads.
- Existing Sommelier, analytics and After the Bubble sites still return HTTP 200.

Pending: real local-model inference, browser visual checks, Plausible dashboard
event delivery, SMTP, Stripe and automated off-host backups.

Plausible page-view tracking uses the requested `jobboard.grokked.it` snippet
served by `https://check.grokked.it/js/script.js`. No custom job/prompt events
are configured. Register this domain in Plausible if it is not already present.
