# Deploy — tester-huester

Production target: Oracle VPS **hermes** (`84.235.175.42`, ARM64, 24 GB) — already has Docker, PM2 and a
running Cloudflare tunnel named **erental** (`~/.cloudflared/config.yml`). We add the web dashboard/collector
as a Docker Compose service on `127.0.0.1:4319` and expose it publicly as **qa.ihor.work** through that same
tunnel (the `*.ihor.work` Universal SSL cert already covers it).

Architecture recap:

- **web** (`@th/web`, this image) — Next.js. Serves the collector API (`/api/ingest`, `/api/asset/*`) and the
  triage dashboard. The only thing that runs in Docker.
- **DB** — Node 24 built-in `node:sqlite`, a single file on a persistent volume. No Postgres.
- **MCP** (`@th/mcp`) — stdio server, **not** in Docker. It runs beside the agent/chat that consumes the
  reports and reads the same SQLite file. See step D.
- **extension** — a Chrome extension built locally and loaded unpacked. See step C.

Requirements on the image: **Node 24** (for `node:sqlite`). The Dockerfile pins `node:24-slim` and
`pnpm@10.33.0`.

---

## A. Build & run the web service on hermes (Docker Compose)

Follow the erental deploy rules: **one deploy at a time**, keep the SSH session alive, don't hammer SSH with a
loop, and move the code with a single `tar`-over-ssh rather than `git` on the box.

1. **Ship the repo to hermes** (from your workstation, repo root). `.dockerignore` already keeps `node_modules`,
   `.next`, `.data`, `th.db*` and `.git` out — but `tar` reads the working tree, so exclude the heavy dirs
   explicitly to keep the tarball small:

   ```bash
   tar --exclude=node_modules --exclude=.next --exclude=.turbo --exclude=.wxt \
       --exclude=.data --exclude='th.db*' --exclude=.git \
       -czf - . | ssh ubuntu@84.235.175.42 'mkdir -p ~/tester-huester && tar -xzf - -C ~/tester-huester'
   ```

2. **Set the dashboard password** (compose refuses to start without it). On hermes:

   ```bash
   cd ~/tester-huester
   printf 'DASH_PASSWORD=%s\n' 'pick-a-strong-value' > .env   # not committed; compose reads it
   ```

3. **Build and start** (single run, then detach — don't loop):

   ```bash
   docker compose up -d --build
   docker compose logs -f web   # watch until "ready", then Ctrl-C (container keeps running)
   ```

   The service now listens on `127.0.0.1:4319` only. The named volume `th-data` holds `/data/th.db` and
   `/data/uploads`, so **redeploys (`docker compose up -d --build`) never wipe the DB or blobs.**

4. **Seed a project** the first time (creates the "Demo" project + ingest key inside the volume's DB):

   ```bash
   docker compose exec web pnpm --filter @th/db seed
   # → seed: project "Demo" (id=..., ingestKey=th_demo_key_0001)
   ```

   Note that `ingestKey` — it is the project key used in steps C and D.

---

## B. Expose qa.ihor.work through the Cloudflare tunnel

The tunnel service is `cloudflared-erental`. Edit `~/.cloudflared/config.yml` and add an ingress rule for the
new hostname **above** the catch-all `http_status:404` rule (order matters — first match wins):

```yaml
ingress:
  # ... existing erental rules ...
  - hostname: qa.ihor.work
    service: http://localhost:4319
  # keep this LAST:
  - service: http_status:404
```

Then add the DNS route (once) and restart the tunnel:

```bash
cloudflared tunnel route dns erental qa.ihor.work   # idempotent; skip if the CNAME already exists
sudo systemctl restart cloudflared-erental
```

Verify: `curl -I https://qa.ihor.work` should return a Next.js response, not a 404 from Cloudflare.

---

## C. Build the extension with the prod collector URL

The extension lives in `apps/extension` (WXT). At runtime it reads the collector URL from its popup config
(default `http://localhost:4319`), so the fastest path is: **build, load unpacked, then set the URL + ingest
key in the popup.**

```bash
cd apps/extension
pnpm install
VITE_TH_COLLECTOR=https://qa.ihor.work pnpm build   # env is reserved for a future build-time default
```

- Output: `apps/extension/.output/chrome-mv3/`.
- Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick that folder.
- Open the extension popup and set:
  - **Collector URL** = `https://qa.ihor.work`
  - **Ingest key** = the project's `ingestKey` from step A.4 (e.g. `th_demo_key_0001`)

> `VITE_TH_COLLECTOR` is not yet wired into the WXT build (the popup value wins today). It is documented here
> and in `apps/web/.env.example` as the intended build-time default; until it's wired, set the URL in the popup.

---

## D. Connect the MCP server to your project chat

The MCP is stdio and runs wherever the agent runs — **not** on hermes. Point it at the same SQLite file the web
service writes. Two setups:

- **Local (dev):** the MCP defaults to the repo-root `th.db`, so no `SQLITE_FILE` is needed if you run it from
  the repo.
- **Against the prod DB:** copy the DB file down from the volume, or run the MCP on hermes with
  `SQLITE_FILE=/var/lib/docker/volumes/tester-huester_th-data/_data/th.db` (path may vary — confirm with
  `docker volume inspect tester-huester_th-data`).

Drop a `.mcp.json` in the consuming project (an example lives beside it as `.mcp.example.json` once you create
one — the shape is):

```json
{
  "mcpServers": {
    "tester-huester": {
      "command": "pnpm",
      "args": ["--filter", "@th/mcp", "start"],
      "cwd": "/absolute/path/to/tester-huester",
      "env": {
        "SQLITE_FILE": "/absolute/path/to/th.db",
        "TH_PROJECT_KEY": "th_demo_key_0001"
      }
    }
  }
}
```

- `SQLITE_FILE` — the DB the web service writes (must match, or the MCP sees no reports).
- `TH_PROJECT_KEY` — the project's key. **Today this is the project's `ingestKey`** (there is no separate
  read-only key yet); the MCP reads the shared DB directly. The env var is reserved for per-project scoping.

The MCP exposes `list_reports`, `get_report`, `set_status`, and `get_repro_steps` — the agent pulls captured QA
reports, reads screenshot URL + note + repro steps, and triages status.

---

## E. Where the secrets/keys come from

- **`DASH_PASSWORD`** — you choose it; set it in `~/tester-huester/.env` on hermes (step A.2). It gates the
  dashboard. Rotate by editing `.env` and `docker compose up -d` (no rebuild needed).
- **Project key (`ingestKey`)** — created by the seed (step A.4). `ensureProject` is idempotent, so just
  re-run the seed at any time to re-print the key:

  ```bash
  docker compose exec web pnpm --filter @th/db seed
  # → seed: project "Demo" (id=..., ingestKey=th_demo_key_0001)
  ```

  This one value is the ingest key for the extension (step C) and the `TH_PROJECT_KEY` for the MCP (step D).

---

## Redeploy checklist

1. `tar … | ssh …` the updated tree (step A.1).
2. `docker compose up -d --build` on hermes.
3. Volume `th-data` persists → DB + blobs survive.
4. No cloudflared change needed unless the hostname/port changed.
