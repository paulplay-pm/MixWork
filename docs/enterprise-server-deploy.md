# Enterprise Server — Production Deployment

## Prerequisites
- Linux host (Ubuntu 22.04+ or RHEL 9+).
- Docker Engine ≥24 and docker compose plugin installed.
- An external PostgreSQL 14+ reachable from the host.
- Outbound HTTPS to a registry (only if pulling a pre-built image).

## Step 1 — Build (or pull) the image
Either `./scripts/package-enterprise-server.sh --tag v2026.10.19` on a build host,
or pull from your internal registry.

## Step 2 — Prepare `.env`
Copy `enterprise_server/.env.example` to `.env`. Fill in `DATABASE_URL`,
`JWT_SECRET` (`openssl rand -hex 32`), `MIXCWORK_VAULT_MASTER_KEY`
(`openssl rand -base64 32`), `IMAGE_TAG`, and `POSTGRES_SUPERUSER_URL`
(used by `init` only — remove the line after init).

## Step 3 — `mixcwork-server init`
On the production host, with `.env` in the cwd:
`mixcwork-server init` (or `node enterprise_server/dist/cli/index.js init`).

This:
- Validates docker / root.
- Connects to `POSTGRES_SUPERUSER_URL` and creates the application role + DB.
- Writes `/etc/mixcwork/{compose.yml, caddyfile.example, current-version}`.
- Installs `/usr/local/bin/mixcwork-server` symlink.

## Step 4 — Start
`docker compose -f /etc/mixcwork/compose.yml up -d` (or `mixcwork-server start`).
Wait for `docker compose ps` to show `Up (healthy)`.

## Step 5 — First-run setup
Open `https://<host>/setup` and create the org + super-admin.

## Step 6 — Reverse proxy
Edit `/etc/mixcwork/caddyfile.example` (or your own nginx config) and reload
the proxy. Confirm `https://<host>/api/health` returns 200.

## Step 7 — Upgrade later
`mixcwork-server upgrade --to v2026.11.1`. The CLI pulls, dry-runs the
migrations, swaps the image, restarts, and rolls back on healthcheck
failure (the database is not rolled back).

## Step 8 — Backup
`mixcwork-server backup` writes `mixcwork-backup-<date>.tar.gz` to cwd.

## Step 9 — Restore
Stop the server first, then `mixcwork-server restore --from <archive>`.
With `--force`, the "service is up" guard is bypassed (not recommended).

## Monitoring
- `mixcwork-server status` — health, version, exit 0/1/2.
- `mixcwork-server logs` — `docker compose logs` passthrough.
- Container logs also live at `/var/lib/docker/containers/.../<id>-json.log`
  (or the customer's logging driver).

## Troubleshooting
- **`init` says "Docker is not on PATH".** Install Docker Engine.
- **`init` says "same role" for POSTGRES_SUPERUSER_URL and DATABASE_URL.**
  Create the app role manually with `CREATE ROLE` and rerun
  `init --no-db-bootstrap`.
- **Container restart loop after `upgrade`.** Check `docker logs`; the
  upgrade already rolled the image back, so the running container is the
  previous version. Investigate why the new version failed.
- **`/health` returns 200 but UI is blank.** The reverse proxy is not
  forwarding `/` correctly. Check `proxy_read_timeout` (Caddy: 120s).
