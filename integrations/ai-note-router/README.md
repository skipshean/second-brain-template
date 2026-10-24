# AI Note Router

Ingests meeting notes from Fireflies and Granola, deduplicates against Linear and Second Brain context, and routes them into the right team/project with optional Linear issue create/update and Second Brain project note upserts. For **two-way sync** of existing vault tasks/projects with Linear (e.g. status and description changes flowing back into Obsidian), use [Linear ↔ Vault sync](../linear-vault-sync/README.md) instead.

## Commands

From the repo root (`second-brain`):

Quick path:
- Setup: [Config](#config) + [Environment](#environment) + [Connecting Fireflies](#connecting-fireflies) / [Connecting Granola](#connecting-granola)
- Run: [Commands](#commands) + [Run at login (macOS)](#run-at-login-macos)
- Architecture: [Meeting ingestion lifecycle](../../docs/ai-note-router/meeting-ingestion-lifecycle.md) + [Linear ↔ Vault sync](../linear-vault-sync/README.md)

## Slack notifications quickstart

1. Add `SLACK_WEBHOOK_URL` to root `.env`.
2. Enable `notifications.enabled: true` in `integrations/ai-note-router/config/authority.yaml`.
3. Set filters and cadence (`include_sources`, `include_systems`, `cadence`) in the same `notifications` block.
4. Restart router: `npm run serve`.
5. Test:
   - realtime transcript notifications via a manual/provider ingest
   - on-demand report: `npm run task-report`
   - Slack-post report: `npm run task-report-daily`

Full setup details: [Slack setup (router + reports)](#slack-setup-router--reports)

## Daily check (quick sanity)

Run these after login (or any time ingest seems down):

```bash
# 1) All expected processes should exist (router, adapter, tunnel)
ps aux | rg -i "cloudflared tunnel|dist/adapter/index.js|dist/index.js --serve"

# 2) Adapter health (tunnel target)
curl -sSf http://localhost:3000/

# 3) Router health (ingest API)
curl -sSf http://localhost:3333/health

# 4) One-shot full health summary
npm run router-health
```

Expected responses for checks 2 and 3:

```json
{ "ok": true }
```

If any check fails, run:

```bash
pkill -f "integrations/ai-note-router/dist/adapter/index.js" || true; pkill -f "integrations/ai-note-router/dist/index.js --serve" || true; pkill -f "cloudflared tunnel" || true; launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.router.plist || true; launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.router.plist; launchctl enable "gui/$(id -u)/com.secondbrain.router"
```

### Processes are up but notes stop landing (Linear rate-limit starvation)

Symptom: all three processes run and payloads keep arriving in `inbox/`, but `meetings/` gets nothing new and
`outputs/ai-note-router/processed-state.json` stops changing. The log is full of
`"Failed to process inbox payload" ... "Rate limit exceeded. Only 2500 requests are allowed per 1 hour"`.
Linear's hourly budget is being spent on payloads that can never succeed, so real notes queue behind them.

```bash
# 5) Rate-limit lines in the current log (anything above a handful per hour is starvation)
grep -c "Rate limit exceeded" ~/Library/Logs/SecondBrain-Router.log

# 6) Inbox size: should be roughly one file per meeting, not thousands
ls integrations/ai-note-router/inbox | wc -l

# 7) Which payloads are failing, and why
grep '"Failed to process inbox payload"' ~/Library/Logs/SecondBrain-Router.log | tail -20 | cut -c1-300

# 8) Payloads the watcher gave up on permanently (e.g. a retired Linear team)
python3 -c "import json;print(json.load(open('outputs/ai-note-router/processed-state.json')).get('skippedFingerprints'))"
```

How the watcher now protects itself (no action needed in the normal case):

- A Linear `Rate limit exceeded` response pauses all inbox scans until Linear's reset time (or the next clock hour); the log shows one `pausing inbox scans` line and one `resuming` line.
- `Entity is retired` (team retired in Linear) is terminal: the fingerprint is recorded under `skippedFingerprints` in `processed-state.json` and never retried. The vault meeting note is still written; only the Linear write is skipped.
- Any other failure is retried with exponential backoff per payload (5 min, 10 min, ... up to 6 h), not on every 5-second scan.
- Ingest (webhooks and the Fireflies backfill) refuses to re-queue a payload that is already processed, skipped, or waiting in the inbox, so the backfill no longer multiplies files.

If the inbox has still accumulated duplicate copies (same `<source>-<id>` with different timestamps), quarantine them outside the repo rather than deleting:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.router.plist
mkdir -p ~/.config/second-brain-archive/ai-note-router-quarantine/duplicates
# keep only the newest file per <source>-<id>; move the rest
cd integrations/ai-note-router/inbox && ls *.json | sed -E 's/^[0-9T:.Z-]+Z-//' | sort | uniq -d | while read key; do ls -1 *"-$key" | sort | sed '$d' | xargs -I{} mv {} ~/.config/second-brain-archive/ai-note-router-quarantine/duplicates/; done; cd -
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.router.plist
```

To make the watcher retry a permanently skipped payload (e.g. after un-retiring a team), remove its entry from `skippedFingerprints` and restart.

- **`npm run serve`** — Start the webhook server and inbox watcher. Listens for `POST /ingest/fireflies` and `POST /ingest/granola`, queues payloads to `integrations/ai-note-router/inbox/`, and processes them when the watcher is active (see Config).
  - Also watches `uploads/` for new `.txt`/`.md` files and processes them automatically.
  - Also refreshes local Linear routing index files under `integrations/linear-vault-sync/router-index/` when `LINEAR_API_KEY` is set.
- **`npm run serve-fireflies-adapter`** — Start the Fireflies webhook adapter (port `3000`). Verifies optional webhook signatures, fetches the transcript via Fireflies API, and forwards to your router on `/ingest/fireflies` with `x-router-token`.
  - Adapter now includes Fireflies `summary.action_items` and sentence-level `ai_filters.task` as structured `tasks` when available.
- **`npm run fireflies-backfill -- --lookback-hours <n>`** — Reconcile missed Fireflies deliveries by listing recent transcripts from Fireflies and replaying them through the same adapter→router path.
  - Useful after tunnel/webhook outages.
  - Example: `npm run fireflies-backfill -- --lookback-hours 72 --max-meetings 50`
  - Optional flags: `--from <ISO-8601>`, `--to <ISO-8601>`, `--limit <1-50>`, `--max-meetings <n>`, `--dry-run`, `--force`.
  - Meetings the router already processed, permanently skipped, or still has queued in `inbox/` are reported as `skippedAlreadyKnown` and not re-fetched or re-queued; `--force` overrides that.
  - For unattended recovery, set `FIREFLIES_BACKFILL_INTERVAL_MINUTES` in `.env` (see Environment).
- **`npm run granola-poll`** — One-shot pull from Granola API and queue new/updated notes into `integrations/ai-note-router/inbox/` as `source: granola`.
  - Requires `GRANOLA_API_KEY`.
  - Uses `outputs/ai-note-router/granola-api-state.json` to continue from the last successful poll.
- **`npm run task-report`** — On-demand rolling 24h task delta report (Obsidian + Linear), printed to terminal.
- **`npm run task-report-daily`** — Daily report mode (24h window) and Slack post via webhook.
- **`npm run serve` + `GRANOLA_API_KEY` set** — Runs one startup Granola API poll automatically.
  - To run continuously, set `GRANOLA_API_POLL_INTERVAL_MINUTES` (for example `15`).
- **`npm run ingest-manual`** — Read a transcript from `stdin`, queue it into `integrations/ai-note-router/inbox/`, then process it immediately.
  - Includes a safety guard: very short/command-like stdin (e.g. `pbpaste`) is rejected unless you pass `--force`.
  - If `--people` is not provided, it auto-detects participants from transcript header lines like `Meeting participants: ...`, `Participants: ...`, or `Attendees: ...`.
  - Use `--source granola` when ingesting a Granola transcript file.
- **`npm run replay`** — One-shot process of all unprocessed JSON files in the inbox (fallback when the watcher wasn’t running).
- **`npm start`** — Same as replay: single batch over the default inbox.
- **`npm run linear-sync-index`** — Refresh `integrations/linear-vault-sync/router-index/index.json`, `teams.md`, and `projects.md` from Linear.
- **`npm run router-health`** — One-shot health summary (router endpoint, Linear index freshness, latest upload result).
- **`node integrations/ai-note-router/dist/index.js --input <path>`** — Process a single JSON file (e.g. a sample payload).

Options:

- `--dry-run` — No writes to disk or Linear; plan and audit only.
- `--serve` — Run webhook server (used by `npm run serve`).
- `--port <number>` — Webhook port (default: `3333`, or `ROUTER_PORT`).
- `--inbox <dir>` — Override inbox directory for batch/replay.
- `--force` — With `--ingest-manual`, bypasses the safety guard that blocks very short or command-like stdin content.
- `--source <fireflies|granola>` — With `--ingest-manual`, sets the source label used for normalization/routing (default: `fireflies`).
- `--route-linear-unassigned` — Run the Linear unassigned-issues router once (or with `--serve`, run it on an interval). Fetches open issues with no assignee, infers team/project from content and vault project notes, then updates each issue (team, project, state, assignee, labels) and adds a comment. Use `config/linear-route-overrides.json` to force specific issue IDs to a team/project.
- `--linear-unassigned-interval-ms <number>` — Interval in ms for unassigned runs when used with `--serve` (default: 300000).
- `--linear-unassigned-limit <number>` — Max open unassigned issues to process per run (default: 50).
- `--sync-linear-index` — One-shot refresh of `integrations/linear-vault-sync/router-index/index.json` + generated reference files from Linear.

## Reviewing unassigned issues

**Where to review:** In **Linear**. The unassigned router only writes to Linear (move/assign + comment). Open unassigned issues in Linear, set the correct **Team** and **Project** (and assignee if you want). Use **Cmd+Shift+M** to move an issue to another team.

**Building rules so the router learns:** After you fix an issue in Linear, add rules so the *next* run routes similar issues correctly:

- **Obsidian** — In `projects/`, ensure the target project note has a Route block the router can read (e.g. `<!-- ai-note-router:start -->` … `Route: TeamName / ProjectName` … `<!-- ai-note-router:end -->`), or a `Team:` line. The router matches issue title/description text to project titles and uses that Route. In `people/`, add `projects:` or `teams:` in frontmatter so participant names in issue text can infer team/project.
- **Overrides** — For one-off fixes, add the issue identifier to `config/linear-route-overrides.json` (e.g. `"16W-1234": { "team": "Delta Corp", "project": "Delta Corp" }`).

**Do you have to run a command?** Yes, for two different things:

1. **Unassigned router** (re-route unassigned issues): run when you want to process remaining or new unassigned issues:
   ```bash
   npx tsx integrations/ai-note-router/src/index.ts --route-linear-unassigned --linear-unassigned-limit 50
   ```
   To run on a schedule (e.g. every 5 min), start the server with: `npm run serve -- --route-linear-unassigned`. The LaunchAgent does not include this flag by default; add it to the plist’s `ProgramArguments` if you want it at login.

2. **Linear ↔ Vault two-way sync** (keep Obsidian tasks/projects and Linear aligned): separate integration. Run when you want status, due date, title, description to stay in sync:
   ```bash
   python3 integrations/linear-vault-sync/sync.py
   ```
   See [Linear ↔ Vault sync](../linear-vault-sync/README.md). This does not run automatically.

## Run at login (macOS)

To have the full ingest stack start automatically when you log in (router + adapter + tunnel, so transcripts are processed even when you’re not in a terminal):

1. **One-time setup** — Copy the LaunchAgent plist and register it with `launchd` (use your actual vault path if different):

   ```bash
   # Fills in your vault path and username, then registers the job:
   integrations/ai-note-router/scripts/install-launchd.sh router
   ```

   Verify:

   ```bash
   curl -sSf http://localhost:3000/
   curl -sSf http://localhost:3333/health
   ps aux | rg -i "cloudflared tunnel|dist/adapter/index.js|dist/index.js --serve"
   launchctl print "gui/$(id -u)/com.secondbrain.router" | rg -n "state|pid"
   ```

2. **Logs** — Stdout and stderr go to `~/Library/Logs/SecondBrain-Router.log` and `SecondBrain-Router-err.log`. Use these to confirm all three services started or to debug. launchd never rotates these, so see [Log size limits](#log-size-limits-macos) below.

3. **Stop / start manually**:
   - Stop/unregister: `launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.router.plist`
   - Start/register again: `launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.router.plist`
   - Ensure enabled: `launchctl enable "gui/$(id -u)/com.secondbrain.router"`

4. **Prerequisites** — Ensure at least one of Fireflies or Granola has `connected: true` in `config/authority.yaml` so the watcher processes the inbox. The server will start on boot either way; with both `connected: false` it will only queue payloads until you set one to `true` and reload the agent.
5. **Cloudflare tunnel mode**
   - **Recommended (durable URL):** set `CLOUDFLARE_TUNNEL_TOKEN` in `.env`. The startup script runs `cloudflared tunnel run --token ...`, which uses your named tunnel and stable hostname.
   - **Fallback (ephemeral URL):** if `CLOUDFLARE_TUNNEL_TOKEN` is not set, startup uses `cloudflared tunnel --url http://localhost:3000` (`trycloudflare.com` URL rotates on restart).
   - The LaunchAgent startup script (`integrations/ai-note-router/scripts/start-router.sh`) loads `.env` from vault root before launching services.

### Durable Cloudflare URL (recommended)

Use this once to avoid changing Fireflies webhook URL after restarts:

1. In Cloudflare Zero Trust, create (or reuse) a **named tunnel**.
2. Get the tunnel run token from Cloudflare.
3. Add to your root `.env`:

   ```env
   CLOUDFLARE_TUNNEL_TOKEN=eyJh...
   ```

4. Reload your LaunchAgent:

   ```bash
   launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.router.plist
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.router.plist
   ```

5. In Fireflies webhook settings, set the target URL to your stable hostname (for example `https://fireflies-webhook.<your-domain>/`).

### Cloudflare dashboard flow (current UI)

The UI labels changed. Use this tested path:

1. Open **Zero Trust → Networks → Connectors → <your tunnel>**.
2. If prompted, run **Start migration** for locally configured tunnels.
   - In migration wizard, do **not** add CIDR routes unless you actually need private network routing.
3. After migration, open **Published application routes** (not **Hostname routes** for private/Gateway hostnames).
4. Add a published route:
   - Hostname: `<subdomain>.<domain>` (for example `fireflies.16w.co`)
   - Service type: `HTTP`
   - Service URL: `localhost:3000`
   - Leave Path empty
5. Save.
6. If Cloudflare reports an existing DNS record for the same hostname, delete the old DNS CNAME/tunnel record first, then save the published route again.

Validation:

```bash
curl -sSf https://<subdomain>.<domain>/
```

Expected:

```json
{ "ok": true }
```

If you move the vault to another path, edit the path inside the plist’s `ProgramArguments`, then run `bootout` followed by `bootstrap` again.

Troubleshooting:
- If registration fails or logs show `EADDRINUSE` on port `3333`, another router process is already running.
- Check: `lsof -nP -iTCP:3333 -sTCP:LISTEN`
- Stop the old process (or `bootout` the old LaunchAgent), then run `bootstrap` again.
- If logs show `EADDRINUSE` on port `3000`, another Fireflies adapter is already running.
- Check: `lsof -nP -iTCP:3000 -sTCP:LISTEN`
- Stop old local adapter/tunnel processes before restarting LaunchAgent:
  - `pkill -f "integrations/ai-note-router/dist/adapter/index.js" || true`
  - `pkill -f "cloudflared tunnel" || true`

## Config

**`integrations/ai-note-router/config/authority.yaml`**

- **`default_authority`** — Which note source wins when multiple exist (e.g. `fireflies`).
- **`authority_overrides`** — Per-project or per-client overrides.
- **`routing`** — How team/project are inferred; optional `default_team` / `default_project`.
  - **`fuzzy_auto_apply_score_gap`** — Score gap needed to auto-apply a fuzzy suggestion in the warning band (`0.75-0.85`). Example: `0.20` means top match must beat second match by 20 percentage points to auto-apply.
  - **`folder_routes`** — Maps a **Granola folder name** (case-insensitive) to an explicit route. Granola folders are curated per client/engagement, so folder membership is a high-confidence routing signal (the API poller reads `folder_membership` on each note; see [Connecting Granola](#connecting-granola)). Format: `folder_routes: { "<Folder Name>": { team: "<Linear Team>", project: "<Linear Project>", client: "<label>" } }`. Any of `team` / `project` / `client` may be set. Precedence: explicit `note.team`/`note.project` (e.g. from a Zapier mapping) > `folder_routes` entry > the folder name used as a fuzzy project hint (only applied when it clears the Linear-index match, so generic folders like "Sales calls" never leak through as a bogus project) > default/manual review. Example seeded from the current Linear index:
    ```yaml
    routing:
      folder_routes:
        "Delta Corp": { team: "Delta Corp", project: "Delta Corp" }
        "Acme Analytics": { team: "Acme Analytics", project: "Acme Analytics" }
        "Beta Games": { team: "Beta Games", project: "Beta Games" }
        "Church of Our Savior": { team: "Church of Our Savior", project: "Church of Our Savior" }
        "Zeta Health": { team: "Zeta Health", project: "Zeta Health Health Community" }
        "PEO for the CEO": { team: "PEO for the CEO", project: "PEO website" }
        "Gamma Studio": { team: "my-company", project: "Gamma Studio" }
        "Brainbody Health": { team: "my-company", project: "Brainbody Health" }
        "Delfino": { team: "my-company", project: "Delfino Design Studio" }
        "Global Atlanta": { team: "my-company", project: "Global Atlanta" }
        "Avid": { team: "Avid Group" }
    ```
- **`dedupe`** — Enable/disable and strategy for matching to existing Linear issues.
- **`sources`** — Per-source:
  - **`enabled`** — Source is used for authority and routing.
  - **`connected`** (fireflies, granola only) — When `true`, the inbox watcher runs for that source. Set to `true` only after the provider’s webhook (or other ingest) is pointed at this server.
- **`notifications`** — User notification preferences:
  - **`enabled`** — Master on/off for transcript task notifications.
  - **`cadence`** — `realtime`, `hourly`, `every_3_hours`, `every_8_hours`, `daily`.
  - **`include_sources`** — Filter by transcript source (`fireflies`, `granola`).
  - **`include_systems`** — Filter by task system (`obsidian`, `linear`).
  - **`include_events`** — Filter by event category (`task_created`, `daily_report`, etc.).
  - **`daily_report.hour_local`** — Local hour gate used for daily cadence flush.

**`integrations/ai-note-router/config/linear-route-overrides.json`** (optional)

- Maps Linear issue identifiers to team/project when running the **unassigned-issues** router (`--route-linear-unassigned`). Use when content-based inference would send an issue to the wrong team (e.g. issues that belong to Delta Corp but mention “my-company”). Format: `{ "16W-1400": { "team": "Delta Corp", "project": "Delta Corp" }, ... }`. Keys are matched case-insensitively.

The watcher starts only if at least one of Fireflies or Granola has both `enabled: true` and `connected: true`. Otherwise the server still accepts webhooks and queues payloads, but nothing is processed until you run replay or set `connected: true`.

## Environment

Set variables in a **`.env`** file in the repo root (the app loads it via `dotenv`). Example:

```env
LINEAR_API_KEY=lin_api_...
ROUTER_PORT=3333
ROUTER_TASK_DUE_TIMEZONE=America/New_York
FIREFLIES_WEBHOOK_SECRET=optional_secret
GRANOLA_WEBHOOK_SECRET=optional_secret
GRANOLA_API_KEY=grn_...
GRANOLA_API_POLL_INTERVAL_MINUTES=15
```

- **`LINEAR_API_KEY`** — Used for dedupe (search existing issues) and for creating/updating issues and comments. If unset, vault project notes still update; Linear writes are skipped.
- **`ROUTER_PORT`** — Webhook server port when not using `--port` (default `3333`).
- **`ROUTER_MANAGED_SUMMARY_MAX_CHARS`** — Optional max characters stored in the managed `Summary:` block in project/meeting notes (default `4000`, minimum enforced `500`).
- **`ROUTER_TASK_DUE_TIMEZONE`** — Optional **IANA time zone** (e.g. `America/New_York`) used when inferring relative due dates from transcript task lines: `by tomorrow`, `EOW` / `end of week` (next Friday on or after the meeting’s calendar day in that zone), `next week` (Monday of the following week, week starts Monday), and `by <weekday>`. Defaults to **`UTC`** if unset. On **Node 22+**, calendar math uses the built-in `Temporal` API for correct DST behavior; on older Node, inference falls back to **UTC calendar days** for those phrases (set this variable and use a current Node LTS for best results).
- **`ADAPTER_PORT`** — Fireflies webhook adapter port when running `serve-fireflies-adapter` (default `3000`).
- **`FIREFLIES_API_KEY`** — Required by the Fireflies adapter to fetch the transcript/summary for a `meetingId`.
- **`FIREFLIES_WEBHOOK_SECRET`** — If set, `POST /ingest/fireflies` must send this value in the **`x-router-token`** header; otherwise 401. Generate with e.g. `openssl rand -hex 24`. In Zapier, add header `x-router-token` = your secret in the Webhooks POST action.
- **`FIREFLIES_WEBHOOK_SIGNING_SECRET`** — Optional. If set, the adapter will verify Fireflies’ webhook request using the `x-hub-signature` header.
- **`FIREFLIES_BACKFILL_INTERVAL_MINUTES`** — Optional. When set to `> 0`, the Fireflies adapter runs periodic reconciliation in the background to recover missed webhook deliveries.
- **`FIREFLIES_BACKFILL_LOOKBACK_HOURS`** — Optional lookback window for periodic backfill (default `72`). Recommended `24` when `FIREFLIES_BACKFILL_INTERVAL_MINUTES` is set: the periodic run already repeats every 30 minutes, so a 72 h window only re-lists the same meetings ~96 times each.
- **`FIREFLIES_BACKFILL_MAX_MEETINGS`** — Optional max meetings per periodic backfill run (default `50`).
- **`FIREFLIES_BACKFILL_PAGE_LIMIT`** — Optional Fireflies page size for periodic backfill runs (default `50`, max `50`).
- **`GRANOLA_WEBHOOK_SECRET`** — Same for `POST /ingest/granola`: caller must send it in **`x-router-token`**; add that header in your Zapier (or other) webhook step.
- **`GRANOLA_API_KEY`** — Personal or Enterprise Granola API key for pull-based ingest (`https://public-api.granola.ai`).
- **`GRANOLA_API_BASE_URL`** — Optional Granola API base URL override (default `https://public-api.granola.ai`).
- **`GRANOLA_API_POLL_INTERVAL_MINUTES`** — Optional. When `> 0`, `npm run serve` continuously polls Granola API and queues changed notes.
- **`GRANOLA_API_INITIAL_LOOKBACK_HOURS`** — Optional initial lookback for the first Granola API poll when no prior poll state exists (default `72`).
- **`MANUAL_WEBHOOK_SECRET`** — If set, `POST /ingest/manual` must send this value in the **`x-router-token`** header; otherwise 401.
- **`SLACK_WEBHOOK_URL`** — Incoming webhook URL used for task notifications and report posting.

## Slack setup (router + reports)

Use this to enable transcript task notifications and daily/on-demand task reports in Slack.

1. Create an Incoming Webhook in your Slack workspace:
   - Slack app config: **Incoming Webhooks** → **Add New Webhook to Workspace**
   - Copy the webhook URL.
2. Add webhook to repo root `.env`:
   ```env
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   ```
3. Turn on router notifications in `integrations/ai-note-router/config/authority.yaml`:
   ```yaml
   notifications:
     enabled: true
     slack_webhook_env_var: SLACK_WEBHOOK_URL
     slack_channel: "#second-brain-inbox" # or null to use webhook default channel
     cadence: realtime # realtime | hourly | every_3_hours | every_8_hours | daily
     include_sources: [fireflies, granola]
     include_systems: [obsidian, linear]
     include_events: [task_created, daily_report, manual_report]
     daily_report:
       enabled: true
       hour_local: 8
     on_demand_report:
       enabled: true
   ```
4. Restart router process after config/env changes:
   ```bash
   npm run serve
   ```
5. Send a test transcript (manual or provider webhook), then verify Slack receives task notifications.

### Report commands

- On-demand rolling 24h report (prints locally):
  ```bash
  npm run task-report
  ```
- Daily-mode report posted to Slack:
  ```bash
  npm run task-report-daily
  ```

### Log size limits (macOS)

launchd appends to the `~/Library/Logs/SecondBrain-*.log` files indefinitely. `scripts/rotate-logs.sh` caps them:

- Any `SecondBrain-*.log` over **10 MB** is truncated in place, and its newest 10 MB is kept as a gzipped archive (`SecondBrain-Router.log.<timestamp>.gz`).
- Archives are limited to the **3 newest per log** and **14 days** old.
- Silent unless it rotates or prunes. Override with `SB_LOG_DIR`, `SB_LOG_MAX_MB`, `SB_LOG_KEEP`, `SB_LOG_MAX_AGE_DAYS`.

Install the 15-minute LaunchAgent (one time):

```bash
cp integrations/ai-note-router/scripts/com.secondbrain.log-rotate.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.log-rotate.plist
launchctl enable "gui/$(id -u)/com.secondbrain.log-rotate"
```

`RunAtLoad` makes it clean up immediately on install. `start-router.sh` also runs it on every router start, and sets `TUNNEL_LOGLEVEL=warn` so `cloudflared` stops logging every request. To clean up by hand, or to reclaim space right now:

```bash
integrations/ai-note-router/scripts/rotate-logs.sh
# or throw away the old logs entirely:
rm -f ~/Library/Logs/SecondBrain-*.log.*.gz
```

### Optional 8am schedule on macOS (launchd)

The repo includes:
- `integrations/ai-note-router/scripts/start-task-report.sh`
- `integrations/ai-note-router/scripts/com.secondbrain.task-report.plist`

Install:
```bash
cp integrations/ai-note-router/scripts/com.secondbrain.task-report.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.secondbrain.task-report.plist
launchctl enable "gui/$(id -u)/com.secondbrain.task-report"
```

Logs:
- `~/Library/Logs/SecondBrain-TaskReport.log`
- `~/Library/Logs/SecondBrain-TaskReport-err.log`

## Webhook endpoints

- **`GET /health`** — Returns `{ "ok": true }`. Use for liveness.
- **`POST /ingest/fireflies`** — Body: JSON with required `id`, `url`, `title`, `body`. Optional: `capturedAt`, `client`, `project`, `team`, `people`, `tasks`, `tags`. Payload is queued to the inbox and processed by the watcher when it’s active.
- **`POST /ingest/granola`** — Same shape as Fireflies.
- **`POST /ingest/manual`** — Manual copy/paste entry point for testing.
  - **Option A: `Content-Type: text/plain`** — Body is the transcript text. The router derives `title` from the first non-empty line and uses `manual://<id>` for `url`.
  - **Option B: `Content-Type: application/json`** — Body can be `{ "body": "<transcript>" }` (or `{ "transcript": "<transcript>" }`), plus optional fields: `title`, `id`, `url`, `capturedAt`, `client`, `project`, `team`, `people`, `tasks`, `tags`.
  - The payload is written to `integrations/ai-note-router/inbox/` and will be processed when the inbox watcher is active (same behavior as other webhook endpoints).
  - Example (paste transcript until EOF):
    ```bash
    curl -sSf -X POST http://localhost:3333/ingest/manual \
      -H "Content-Type: text/plain" \
      --data-binary @-
    ```
  - Tip: you can also do `pbpaste | curl ... --data-binary @-` to send your clipboard directly.

Point Fireflies or Granola (or a Zap/Make step) at:

- `http://<your-host>:<ROUTER_PORT>/ingest/fireflies`
- `http://<your-host>:<ROUTER_PORT>/ingest/granola`

If you set `FIREFLIES_WEBHOOK_SECRET` or `GRANOLA_WEBHOOK_SECRET`, configure the provider to send that value in the `x-router-token` header.

### Tunnel topology (important)

Use this to choose whether both providers can share one Cloudflare URL:

- **Single tunnel URL for both Fireflies + Granola (recommended):**
  - Send both through **Zapier** to the router:
    - `https://<cloudflare-tunnel-address>/ingest/fireflies`
    - `https://<cloudflare-tunnel-address>/ingest/granola`
  - Local target is `http://localhost:3333` (`npm run serve`).
  - This is the simplest way to use one Cloudflare tunnel for both sources.
- **Fireflies native webhook (no Zapier):**
  - Fireflies posts to your **adapter** on `localhost:3000` (via tunnel), then adapter forwards to router `localhost:3333`.
  - Granola still posts to router `/ingest/granola` (usually through Zapier).
  - In this mode, `3000` is Fireflies-only.

---

## Connecting Fireflies

Fireflies can notify you when a transcription is ready, but its **native webhook payload** only includes `meetingId`, `eventType`, and `clientReferenceId` — not the full transcript or summary. The router expects a request body with **`id`, `url`, `title`, `body`** (and optional `client`, `project`, `team`, etc.). You have two ways to connect:

### Option A: Zapier (recommended)

1. **Expose your router** so Zapier can reach it: run `npm run serve` and use a public URL (e.g. ngrok: `ngrok http 3333`, or Cloudflare Tunnel to `http://localhost:3333`). Your ingest URL is `https://<your-host>/ingest/fireflies`.
2. In **Zapier**, create a Zap:
   - **Trigger:** Fireflies → “Transcription complete” (or “New transcript”).
   - **Action:** Webhooks by Zapier → “POST”. URL = your `https://<your-host>/ingest/fireflies`. Body type: JSON. Map:
     - `id` ← Fireflies transcript/meeting ID
     - `url` ← Fireflies transcript link (e.g. `https://app.fireflies.ai/view/...`)
     - `title` ← meeting title
     - `body` ← transcript or summary from Fireflies (use the field Zapier provides)
   - If you use `FIREFLIES_WEBHOOK_SECRET`, add a header: `x-router-token` = your secret.
3. In **authority.yaml**, set `sources.fireflies.connected: true` and restart the server.

**Using the same tunnel as Granola:** If Granola is also using Zapier, point both Zaps at the same public host and only change the path:
- Fireflies Zapier URL: `https://<cloudflare-tunnel-address>/ingest/fireflies`
- Granola Zapier URL: `https://<cloudflare-tunnel-address>/ingest/granola`

### Option B: Direct Fireflies webhook + your adapter

If you're running your adapter on your laptop (instead of deploying it somewhere public), you can expose it over HTTPS using **Cloudflare Tunnel**. This is a beginner-friendly alternative to `ngrok`.

Use this only for Fireflies native webhooks. The adapter exists because Fireflies native payloads do not include the full transcript body expected by the router.

> **Known gotcha:** In current Cloudflare UI, configure this under **Published application routes** (public hostnames), not **Hostname routes** (private/Gateway hostnames). See [Cloudflare dashboard flow (current UI)](#cloudflare-dashboard-flow-current-ui).

#### Cloudflare Tunnel quick start (adapter on localhost)
Prereqs (one-time):
1. In `second-brain/.env`, ensure:
   - `FIREFLIES_API_KEY` is set (required)
   - `FIREFLIES_WEBHOOK_SIGNING_SECRET` is set to the “Signing secret” from Fireflies (recommended)
   - `FIREFLIES_WEBHOOK_SECRET` remains set (this is the secret your router expects in `x-router-token`)
2. Start the adapter in a terminal:
   - `npm run serve-fireflies-adapter` (defaults to `http://localhost:3000`)
   - The adapter forwards **full sentence-level transcript text** as `body` when available, and falls back to Fireflies summary text only if sentence text is unavailable.

1. Install Cloudflare Tunnel CLI:
   - macOS (Homebrew): `brew install cloudflared`
2. Log in to your Cloudflare account:
   - `cloudflared tunnel login`
3. Start a tunnel that forwards public HTTPS traffic to your local adapter:
   - Local adapter endpoint: `http://localhost:3000`
   - In another terminal, run:
     - `cloudflared tunnel --url http://localhost:3000`
   - Keep this terminal running.
   - Copy the HTTPS URL it prints (it will look like `https://<random-subdomain>.trycloudflare.com`).
4. Point Fireflies at the tunnel URL:
   - In **Fireflies**: Settings → Developer → Webhooks
   - Enter the HTTPS tunnel URL as the webhook target (Fireflies will POST to `/` on that URL).

**Granola in this setup:** Granola should still post to router `3333` (usually via Zapier to `https://<router-host>/ingest/granola`), not to adapter `3000`.

When Fireflies sends a webhook to that HTTPS URL, Cloudflare will proxy it to your adapter running on `localhost`, and your adapter can then POST into your local AI Note Router.

Notes / gotchas:
- Fireflies needs an **HTTPS** webhook target, and Cloudflare Tunnel provides that.
- This approach is intended for development/testing. If the tunnel stops, Fireflies can't reach your adapter.

1. In **Fireflies**: [Settings → Developer](https://app.fireflies.ai/settings) → Webhooks, enter an **HTTPS** URL. That URL must be a small service you run that:
   - Receives Fireflies’ POST (payload: `meetingId`, `eventType`, …).
   - Optionally verifies Fireflies’ `x-hub-signature` (see [Fireflies webhook auth](https://docs.fireflies.ai/graphql-api/webhooks)).
   - Calls the Fireflies API to fetch the transcript/summary for `meetingId`.
   - POSTs to your AI Note Router at `http://localhost:<ROUTER_PORT>/ingest/fireflies` with body `{ "id", "url", "title", "body", ... }` and header `x-router-token` (if `FIREFLIES_WEBHOOK_SECRET` is set).
2. In **authority.yaml**, set `sources.fireflies.connected: true`.

Fireflies’ own docs: [Webhooks](https://docs.fireflies.ai/graphql-api/webhooks).

---

## Connecting Granola

Granola exposes two independent surfaces; they are complementary, not alternatives:

- **Ingest (headless) — the API poller / Zapier, covered below.** Uses a Granola **API key** (`GRANOLA_API_KEY`, `https://public-api.granola.ai`) and runs unattended (launchd). It pulls new notes' summary, transcript, attendees, calendar event, and **folder membership**, then routes them into `meetings/`, `projects/`, and Linear. This is what keeps the vault current.
- **Recall (interactive) — the Granola MCP.** A hosted OAuth server at `https://mcp.granola.ai/mcp` (browser sign-in, no keys) for ad-hoc questions across meetings — "what did we decide about X", "my open follow-ups this week" — with citations back to the source notes. It also exposes the user's private "My Notes", which the REST poller does **not** return. Because it needs interactive OAuth it cannot run in the headless path; use it in a live session via the [`/granola`](../../.claude/skills/granola/SKILL.md) skill. Connect it once in claude.ai connector settings, or `claude mcp add granola --transport http https://mcp.granola.ai/mcp`.

The rest of this section covers **ingest**. Granola **does not offer a “webhook URL” or “post to this URL” setting** in the product. The only built-in way to push note data to an external endpoint is via **Zapier** (or Make, etc.). If your router runs on your own machine, you can still connect **locally without Zapier** by polling the Granola API and POSTing to localhost (see Option B).

### Option A: Zapier (cloud or tunneled)

Use this when you want Zapier to push from Granola to your router (router can be local + ngrok/Cloudflare tunnel, or a hosted server).

1. **Expose your router** so Zapier can reach it (e.g. `npm run serve` + ngrok, or Cloudflare tunnel to `http://localhost:3333`). Ingest URL: `https://<cloudflare-tunnel-address>/ingest/granola`.
2. In **Granola**: Settings (avatar → bottom left) → Integrations → turn on **Zapier** (paid feature on desktop).
3. In **Zapier**, create a Zap:
   - **Trigger:** Granola → “Note shared to Zapier” (manual share from a note) or “Note added to Granola folder” (automatic for a folder).
   - **Action:** Webhooks by Zapier → “POST”. URL = `https://<cloudflare-tunnel-address>/ingest/granola`. Body type: JSON. Map:
     - `id` ← Granola note ID or a stable identifier
     - `url` ← Granola “Link” (share link to the note)
     - `title` ← “Title” or calendar event title
     - `body` ← “Summary” or “Transcript” (Markdown)
     - Optionally: `client`, `project`, `team` from your naming or folder; `people` from “Attendees”; `capturedAt` from “Calendar event” date.
   - If you set `GRANOLA_WEBHOOK_SECRET`, add header `x-router-token` = that secret.
4. In **authority.yaml**, set `sources.granola.connected: true` and restart.

Granola sends: Link, Transcript, Summary (Markdown), My Notes, Calendar event, Attendees, Creator, Title. Map these into the required `id`, `url`, `title`, `body` and any optional fields you use. Granola’s docs: [Zapier](https://help.granola.ai/article/zapier).

**Using the same tunnel as Fireflies:** If Fireflies is also using Zapier, reuse the same Cloudflare host and point to different router paths:
- `https://<cloudflare-tunnel-address>/ingest/fireflies`
- `https://<cloudflare-tunnel-address>/ingest/granola`
No adapter (`3000`) is needed in this dual-Zapier setup.

**Important if you use the Fireflies native adapter flow:** A Cloudflare route that points to `localhost:3000` is for Fireflies adapter traffic only. Granola Zapier posts must reach router `localhost:3333` (directly or via a Cloudflare route/hostname that forwards to `3333`).

### Option B: Local connection (no Zapier)

**Supports Granola Personal API keys (Business/Enterprise) and Enterprise API keys.**

If the router runs on the **same machine** as you (e.g. `npm run serve` on your laptop), you can avoid Zapier by using the built-in Granola API poller:

1. In Granola desktop app, generate a key in Settings → API and set:
   - `GRANOLA_API_KEY=grn_...` in root `.env`
2. Run a one-shot sync:
   - `npm run granola-poll`
3. Or run continuously while serving:
   - `GRANOLA_API_POLL_INTERVAL_MINUTES=15 npm run serve`
4. In **authority.yaml**, set `sources.granola.connected: true` so queued notes are processed by the inbox watcher.

Everything stays on your machine: Granola API (pull) → local inbox queue → router processing.

The poller reads each note's **`folder_membership`** and carries the folder name(s) into routing. Map folders to Linear team/project with `routing.folder_routes` (see [Config](#config)); folders whose names already match a Linear team/project resolve automatically via the fuzzy hint.

### Option C: Local quick-paste page (no Zapier, no API)

If you do not want Zapier and do not have Granola API access, use the built-in local ingest page:

1. Ensure router is running (`npm run serve`) and reachable at `http://localhost:3333/health`.
2. Open: `http://localhost:3333/ingest/granola`
3. Paste:
   - meeting `title`
   - Granola `summary`
   - Granola `transcript`
   - optional attendees/captured-at
   - optional speaker mapping:
     - `I am speaker A/B` + your name
     - explicit `Speaker A name` / `Speaker B name` overrides
4. Click **Queue Granola Note** (writes to inbox and processes via watcher).

This route accepts local form posts from loopback only (`127.0.0.1` / `::1`) so it works even when `GRANOLA_WEBHOOK_SECRET` is configured.

#### Optional: prefill today's meetings from Google Calendar

If you add a private Google Calendar ICS URL to `.env`, the quick-paste page can preload today's meetings so one click fills title/time/attendees:

```env
GRANOLA_CALENDAR_ICS_URL=https://calendar.google.com/calendar/ical/<your-private-ics>/basic.ics
```

Then reload the page at `http://localhost:3333/ingest/granola` and choose from the meetings dropdown. Use the **calendar icon** or **date field** next to the dropdown to load meetings for another day (defaults to today). The API is `GET /ingest/granola/calendar-events?date=YYYY-MM-DD` (local date).

**Troubleshooting (no dropdown / empty list):**

- Restart the router after editing `.env` (`npm run serve` or LaunchAgent).
- Confirm the URL is the **Secret address in iCal format** (not the public calendar URL).
- From a terminal, run `curl -sSf "<GRANOLA_CALENDAR_ICS_URL>" | head -n 5` — you should see `BEGIN:VCALENDAR`.
- The ingest page shows a red **Calendar** hint if the fetch failed (wrong URL, HTTP error, or HTML instead of ICS).

### Manual one-off

You can also export or copy a note from Granola, format it as JSON with `id`, `url`, `title`, `body`, and run `node …/dist/index.js --input <path>` or drop the file into `integrations/ai-note-router/inbox/` and run `npm run replay`.

---

## Outputs

- **Inbox** — `integrations/ai-note-router/inbox/` (raw queued payloads: full Fireflies/Granola transcripts as JSON). **Local-only, gitignored** since 2026-10-19: the payloads are reproducible from Fireflies/Granola and `processed-state.json` is the record of what was handled, so nothing in the inbox is committed. A fresh clone starts with an empty inbox; use the Fireflies backfill or Granola poll to re-queue meetings if needed.
- **Processed state** — `outputs/ai-note-router/processed-state.json` (`processedFingerprints`: notes already handled so replay doesn’t reprocess; `skippedFingerprints`: notes that failed permanently, e.g. a retired Linear team, with the reason and timestamp).
- **Second Brain** — Project notes under `projects/` with an AI Note Router–managed section; vault writes also go to `outputs/ai-note-router/` for summaries.
- **Meetings** — Meeting notes under `meetings/` with frontmatter `type: meeting`, transcript summary, and task checklist.
- **Project meeting index** — Project notes under `projects/` keep `type: project` and receive an AI-managed `## Meetings` section linking related notes in `meetings/`.
- **Uploads intake** — `uploads/` for incoming transcript files, `uploads/successful/` for successfully processed files, `uploads/unsuccessful/` for files needing manual follow-up.
- **Uploads audit logs** — `outputs/ai-note-router/uploads/` stores one markdown audit log per processed upload file.
- **Linear routing index** — `integrations/linear-vault-sync/router-index/` stores teams/projects index and aliases used for routing identification (not daily notes).

Audit events are logged as JSON to stdout (stage, message, payload).

## Uploads auto-processing

When `npm run serve` is running, the router watches `uploads/` for new `.txt` and `.md` files.

- Each file is parsed into a note payload (`source`, `title`, `body`, optional inferred `people` from lines like `Meeting participants: ...`).
- The normal router pipeline runs (routing, vault updates, Linear sync).
- On completion, the file is moved:
  - to `uploads/successful/` when all are true:
    - Project resolved
    - At least one person associated
    - Processing completed without error
    - Linear action is not `skip` (or it is `skip` specifically because no assignee signal was found in transcript text, or because `LINEAR_API_KEY` is not set)
  - otherwise to `uploads/unsuccessful/`.

Notes:
- Team is optional for upload success. Personal/internal notes can still be successful with no resolved team.
- `Meeting Title: ...` headers are used for meeting-note naming, but are not promoted into synthetic project names.
- Upload-derived IDs are deterministic (content-based), so retries/dry-runs are idempotent for unchanged files.

## Action-Item Extractor

Tasks are extracted from each inbound note in the following precedence:

1. **Upstream-curated tasks** on the payload (`input.tasks[]`). Fireflies webhooks carry `summary.action_items` when available — see `src/adapter/index.ts`.
2. **Curated section in the body.** The extractor recognizes Fireflies `Action Items:` markers and Granola `### Next Steps` (also `### Action Items`, `### Next Actions`, `### To Do`) blocks, including per-owner subsections. See `src/normalize/curated-items.ts`.
3. **Heuristic fallback** over the transcript body, gated on a commitment-language phrase or explicit date reference and capped at `extractor.max_items` items. See `src/normalize/tasks.ts`.

Curated output is trusted and is not filtered by chatter-detection or truncated by the cap. Heuristic output is.

Configure in `config/authority.yaml`:

```yaml
extractor:
  # Max items emitted by the heuristic fallback. Curated sections are not capped.
  max_items: 15
  # prefer | force | off
  #   prefer: use curated section if present, else heuristic (default)
  #   force:  require a curated section; return [] if absent
  #   off:    always use heuristic (debugging)
  curated_mode: prefer
  # Heuristic gate — each candidate line must contain at least one phrase
  # (case-insensitive substring) OR a date reference (ISO, by-weekday, EOW,
  # by-tomorrow, next-week) OR be inside an "Action items:" section.
  commitment_phrases:
    - "i'll"
    - "send me"
    - "by eow"
    # ...
  # Ownership buckets for grouped rendering in meeting notes.
  owner_groups:
    self: [Alex, Alex Morgan]
    client: [Casey, Casey Client]
    parking_lot_markers:
      - parking lot
      - open question
      - maybe
```

Meeting notes render tasks grouped under three subheadings when at least one
task carries an `ownerGroup`:

- `### Mine` — items whose assignee matches `owner_groups.self`
- `### Client` — items whose assignee matches `owner_groups.client`, or any
  named non-self assignee (default bucket for unclassified people)
- `### Open Questions / Parking Lot` — items matching any
  `parking_lot_markers` substring, or items with no assignee

If no task has `ownerGroup` set, rendering falls back to the flat
`- [ ] title — owner: X | due: Y` list (backward-compatible).

**Self-attribution from the transcript speaker.** Granola labels the note-taker's
own audio as `Microphone` in transcripts. When the heuristic extracts a
commitment the note-taker speaks (e.g. `Microphone: I'll send the deck by
Friday`) with no explicit assignee, it is bucketed under `### Mine`
rather than the parking lot. An explicit inline assignee still wins (a line the
note-taker speaks *about someone else* is not misattributed to self).

File source defaults to `fireflies`, and switches to `granola` when the filename contains `granola`.
