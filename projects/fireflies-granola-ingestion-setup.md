---
type: project
status: active
updated: 2026-03-18
---

# Fireflies / Granola ingestion setup

Verification and setup for the AI Note Router that ingests meeting notes from Fireflies and Granola into the Second Brain (and optionally Linear).

## Verification (2026-03-18)


| Check                             | Status                                                           |
| --------------------------------- | ---------------------------------------------------------------- |
| Fireflies MCP (Cursor)            | ✅ Working — recent transcripts returned                          |
| AI Note Router build              | ✅ `npm run build` succeeds                                       |
| Webhook server                    | ✅ `npm run serve` starts; `GET /health` returns `{ "ok": true }` |
| Sample Fireflies dry-run          | ✅ Routes to team/project, vault summary, Linear create plan      |
| Config: fireflies/granola enabled | ✅ Both `enabled: true` in `config/authority.yaml`                |
| Config: connected                 | ✅ At least one source should be `connected: true` to enable inbox processing |


## Processing requirement

The **inbox watcher only runs** when at least one of Fireflies or Granola has `connected: true` in `integrations/ai-note-router/config/authority.yaml`.

- If both are `connected: false`, the server still accepts `POST /ingest/fireflies` and `POST /ingest/granola` and **queues** payloads to `integrations/ai-note-router/inbox/`.
- Processing (vault writes / Linear sync) starts once you:
  - Set `sources.fireflies.connected: true` or `sources.granola.connected: true` and run `npm run serve`, or
  - Run `npm run replay` for one-shot processing.

## To finish setup

### Fireflies

1. **Expose the router** so Fireflies (or Zapier) can reach it: run `npm run serve` and use a public URL (e.g. `ngrok http 3333`). Ingest URL: `https://<your-host>/ingest/fireflies`.
2. **Connect Fireflies → router** (choose one):
  - **Zapier:** Trigger = Fireflies “Transcription complete”. Action = Webhooks by Zapier POST to your ingest URL with body `id`, `url`, `title`, `body` (and optional `client`, `project`, `team`). Add header `x-router-token` if you set `FIREFLIES_WEBHOOK_SECRET`.
  - **Direct webhook:** Fireflies [Settings → Developer](https://app.fireflies.ai/settings) → Webhooks. Your endpoint must receive Fireflies’ POST, fetch transcript/summary via API, then POST to your router (see README Option B).
3. In **authority.yaml**, set `sources.fireflies.connected: true` and restart the server.

### Granola

1. **Expose the router** (same as above). Ingest URL: `https://<your-host>/ingest/granola`.
2. **Connect Granola → router:** Granola has no built-in webhook; use **Zapier** (Granola → “Note shared to Zapier” or “Note added to Granola folder” → Webhooks POST), or with **Granola Enterprise** use their API + a local poller that POSTs to `http://localhost:3333/ingest/granola`.
3. In **authority.yaml**, set `sources.granola.connected: true` and restart.

### Optional env

- `LINEAR_API_KEY` — for dedupe and creating/updating Linear issues (in `.env`).
- `ROUTER_PORT` — default `3333` (in `.env`).
- `FIREFLIES_WEBHOOK_SECRET` / `GRANOLA_WEBHOOK_SECRET` — see **Webhook secrets** below.

## Webhook secrets (optional)

If you want to lock down the ingest endpoints so only callers that know a shared secret can POST, set these in your **`.env`** file and send the same value in the **`x-router-token`** header from Zapier (or your webhook caller).

### 1. Generate a secret

Use a long random value. From the terminal:

```bash
openssl rand -hex 24
```

Use one secret per source (Fireflies and Granola can share a value or use different ones).

### 2. Add to `.env`

In the repo root `.env` file, add (uncomment if present):

```env
FIREFLIES_WEBHOOK_SECRET=your_generated_secret_here
GRANOLA_WEBHOOK_SECRET=your_generated_secret_here
```

Restart the router (`npm run serve`) after changing `.env`.

### 3. Send the header from the caller

- **Zapier (Fireflies):** In the Webhooks by Zapier “POST” action, add a header:
  - **Key:** `x-router-token`
  - **Value:** the same string you set for `FIREFLIES_WEBHOOK_SECRET`
- **Zapier (Granola):** Same for the Granola → Webhooks POST action:
  - **Key:** `x-router-token`
  - **Value:** the same string you set for `GRANOLA_WEBHOOK_SECRET`

If the header is missing or wrong, the router returns **401 Unauthorized** (or **403** if no secret is configured at all) and does not queue the payload.

## Run at login (macOS)

To start the router automatically when your Mac boots: see [AI Note Router README — Run at login](../integrations/ai-note-router/README.md). Run `integrations/ai-note-router/scripts/install-launchd.sh router` (it substitutes your vault path and username into the plist, then registers the job).

## Quick commands

- **Serve (webhook + watcher):** `npm run serve`
- **Process all queued inbox files:** `npm run replay`
- **Dry-run one file:** `node integrations/ai-note-router/dist/index.js --input <path> --dry-run`
- **Health check:** `curl http://localhost:3333/health`

## References

- [AI Note Router README](../integrations/ai-note-router/README.md) — full docs, webhook payload shape, Zapier mapping.
- Config: `integrations/ai-note-router/config/authority.yaml`.

## Granola enhancements (2026-07-17)

Reviewed against Granola's updated MCP (hosted OAuth at `mcp.granola.ai/mcp`) and added:

- **Folder-based routing.** The API poller now reads each note's `folder_membership` and routes via `routing.folder_routes` in `authority.yaml` (folder name → Linear team/project), falling back to a match-gated folder-name hint. Granola folders map ~1:1 to clients/engagements, so this is a stronger signal than fuzzy title matching. **To activate: paste the seeded `folder_routes` block from the [README Config section](../integrations/ai-note-router/README.md) into `authority.yaml` and verify the mappings.**
- **`/granola` recall skill.** On-demand natural-language queries across meetings via the Granola MCP (with citations, and access to private "My Notes" the REST poller can't see). Interactive-session only. See `.claude/skills/granola/SKILL.md`.
- **Self-attribution.** Commitments the note-taker speaks (Granola labels their audio `Microphone`) now bucket under Mine instead of the parking lot.

Not built: private "My Notes" in the headless poller — the REST `v1/notes` object exposes no private-notes field (summary + transcript only), so that content is reachable only via the `/granola` MCP skill.

<!-- ai-note-router:project-tasks:start -->
## Tasks by Status

> [!todo]+ In Progress
> ```dataview
> LIST file.link FROM "tasks"
> WHERE contains(file.tags, this.tags[0]) AND status = "in-progress"
> SORT file.name ASC
> ```

> [!abstract]+ Pending
> ```dataview
> LIST file.link FROM "tasks"
> WHERE contains(file.tags, this.tags[0]) AND status = "pending"
> SORT file.name ASC
> ```

> [!success]- Complete
> ```dataview
> LIST file.link FROM "tasks"
> WHERE contains(file.tags, this.tags[0]) AND status = "complete"
> SORT file.name ASC
> ```

> [!failure]- Cancelled
> ```dataview
> LIST file.link FROM "tasks"
> WHERE contains(file.tags, this.tags[0]) AND status = "cancelled"
> SORT file.name ASC
> ```
<!-- ai-note-router:project-tasks:end -->

> **Security note:** ingest **fails closed**: with no `FIREFLIES_WEBHOOK_SECRET` / `GRANOLA_WEBHOOK_SECRET` / `MANUAL_WEBHOOK_SECRET` set, requests get a 403 (set `ROUTER_ALLOW_UNAUTHENTICATED=1` for local testing only). The server binds to 127.0.0.1; use `ROUTER_HOST` to change that, or a tunnel (Cloudflare Tunnel etc.) for webhooks. Requests carrying proxy headers are never treated as local, so the local Granola form and calendar endpoint stay off the tunnel.
