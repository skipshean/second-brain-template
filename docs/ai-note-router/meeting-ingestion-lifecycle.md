# AI Note Router: Meeting Ingestion Lifecycle

This doc explains what happens *after* a Fireflies/Granola transcript (or meeting note) is ingested—down to how routing to a team/project is decided and when it falls back to “needs review”.

Related docs:
- Operational setup/runbook: [AI Note Router README](../../integrations/ai-note-router/README.md)
- Two-way task/project sync behavior: [Linear ↔ Vault sync](../../integrations/linear-vault-sync/README.md)

## 1) Ingest (webhook) -> Inbox Queue

The router exposes these endpoints:

- `POST /ingest/fireflies`
- `POST /ingest/granola`

Both expect a JSON body with:

- Required: `id`, `url`, `title`, `body`
- Optional: `capturedAt`, `client`, `project`, `team`, `people`, `tasks`, `tags`

If `FIREFLIES_WEBHOOK_SECRET` / `GRANOLA_WEBHOOK_SECRET` are set in `.env`, the caller must also send `x-router-token` (otherwise you get `401`).

On successful request, the router writes the payload to:

- `integrations/ai-note-router/inbox/`

If the `<source>:<id>` fingerprint is already processed, permanently skipped, or still waiting in the inbox, the router answers `200` with `queued: false, reason: "already-known"` and writes nothing (this is what stops the periodic Fireflies backfill from queueing the same meeting every run).

If `--dry-run` is used, it does not persist the inbox payload.

## 2) Inbox Watcher / Replay decides when to process

Processing is gated by `integrations/ai-note-router/config/authority.yaml`:

- The inbox watcher only runs if at least one source has `enabled: true` *and* `connected: true`.
- If both Fireflies and Granola are `connected: false`, the server still queues payloads, but nothing gets processed until you:
  - set one `connected: true` and restart `npm run serve`, or
  - run `npm run replay` (one-shot batch over inbox JSON files)
- Failure handling (added 2026-10-17 after Linear rate-limit starvation): a `Rate limit exceeded` reply pauses scanning until Linear's reset time; `Entity is retired` marks the fingerprint as `skippedFingerprints` in `processed-state.json` and is never retried; anything else backs off per payload (5 min doubling, max 6 h). See the README "Daily check" section for how to spot and clear starvation.

## 3) Normalization -> Canonical Note

Each inbox JSON file is loaded by a source adapter:

- Fireflies adapter: maps `SourceInput` into a `CanonicalNote`
- Granola adapter: maps `SourceInput` into a `CanonicalNote`

This is where `note.people` becomes important: it is the input used for vault-based routing inference.

Important: meeting titles in transcript headers are used for meeting-note naming, but are not treated as synthetic project names.

## 4) Routing to a team + project

Routing happens in two stages:

### 4a) Base routing (explicit fields first)

The router starts with:

- `note.team` and `note.project` from the ingest payload
- otherwise `routing.default_team` / `routing.default_project` from config

If both are missing, you normally would get “unassigned”.

### 4b) Vault inference from `note.people`

If routing fields are missing and `note.people` is present, the router attempts inference using your vault:

1. It builds an index of:
  - `people/*.md` (who is associated with which project(s)/team(s))
  - `projects/*.md` (project titles + `Team:` metadata)
2. It matches each participant against the appropriate `people` card.
3. It picks the best candidate project and returns:
  - `route.team`
  - `route.project`

If it cannot map participants to a project/team, it sets the route reason to one of:

- `Needs review: no matching Obsidian people card for participants (...)`
- `Needs review: participants (...) matched Obsidian people cards, but no team/project mapping was found in vault.`

## 5) Authority + Dedupe (Linear)

Authority resolution selects the note “source of truth” (Fireflies vs Granola) using:

- `default_authority`
- optional per-project / per-client overrides from `authority_overrides`

Dedupe then tries to match the note to an existing open Linear issue and either:

- `update` the best canonical issue, or
- `create` a new issue (depending on match results)

## 6) Outputs written to the vault + Linear

### 6a) Vault project note upsert

The router writes/updates a managed section inside a project note under:

- `projects/*.md`

The key detail: the router now uses `route.project` to decide which `projects/<slug>.md` file to upsert into.

The managed block includes:

- Source link + captured timestamp (if available)
- `Route: <team> / <project>`
- `Reason: ...`
- `Linear: <issue id>` (if linked)

### 6b) Linear update

If a Linear write is possible, the router updates the canonical Linear issue:

- title + description
- and posts a comment containing the source + route summary

If `route.team` cannot be resolved, Linear writes are skipped.

## 7) How to make routing “just work”

For reliable routing, ensure your ingest payload provides `people` *as names that match your vault*.

Then ensure your `people/*.md` cards provide enough mapping context to infer:

- which `teams` they belong to
- which `projects` they belong to

If no mapping can be inferred from the vault, you will see “Needs review” in the managed section and the route will remain unassigned until you either:

- update the `people`/`projects` vault metadata, and/or
- include explicit `team` and `project` in the ingest payload.

