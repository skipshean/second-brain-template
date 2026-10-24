# Extending the Vault

The core (folders, `CLAUDE.md`, skills, auto-commit hook) works on its own. These add-ons are optional and ship in `integrations/`. No keys or secrets are included: copy `.env.example` to `.env` and fill in your own.

## Meeting-note ingestion: Fireflies and Granola
`integrations/ai-note-router/` ingests meeting notes into the vault: it normalizes each note, matches attendees to `people/`, matches the meeting to a `projects/` note, extracts action items as tasks, and de-duplicates by fingerprint. Raw payloads land in a gitignored `inbox/`.

- **Setup guide:** [projects/fireflies-granola-ingestion-setup.md](../projects/fireflies-granola-ingestion-setup.md) (webhooks, Zapier, shared secrets, run commands)
- **Reference:** [integrations/ai-note-router/README.md](../integrations/ai-note-router/README.md)
- **Flow details:** [docs/ai-note-router/meeting-ingestion-lifecycle.md](ai-note-router/meeting-ingestion-lifecycle.md)
- **Config:** `integrations/ai-note-router/config/authority.yaml` (set `connected: true` per source; add your own client/folder routes)
- Quick start: `npm ci && npm run build && npm run serve`
- Other AI notetakers (Otter, Read, tl;dv...): the router accepts a generic payload at `POST /ingest/manual` (see `npm run ingest-manual`), so any tool that can send a webhook or export JSON can feed it.

## Linear two-way sync (`/sync`)
`integrations/linear-vault-sync/` maps vault tags to Linear teams and syncs tasks and projects both ways. Put your team IDs in `config.json` and `LINEAR_API_KEY` in `.env`. See its README.

## Meeting recall (`/granola`)
The `granola` skill queries Granola through its MCP server to answer ad-hoc questions about past meetings, with citations. Requires the Granola MCP connector in Claude; no key in this repo.

## Keep secrets out of git
Keys live in gitignored `.env` or `.claude/settings.local.json`, never in tracked files.
