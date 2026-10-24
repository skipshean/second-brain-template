# Linear ↔ Vault two-way sync

Keeps Obsidian vault task/project markdown and Linear in sync both ways. When you (or an agent, or another tool) update a Linear issue, the next sync run updates the corresponding vault file; when you edit the vault, changes are pushed to Linear.

**Use this when:** You want status, due date, title, and description to stay aligned between `tasks/` and `projects/` markdown and Linear. Complements the [AI note router](../ai-note-router/README.md), which only pushes meeting notes → Linear + vault.

Quick path:
- Setup: [Config and state](#config-and-state)
- Run: [Run from repo root](#run-from-repo-root)
- Troubleshoot: `.claude/sync-conflicts.json` + `--resolve` options
- Architecture/data inputs: [Router Linear Index](router-index/README.md) and [AI Note Router lifecycle](../../docs/ai-note-router/meeting-ingestion-lifecycle.md)

## Run from repo root

```bash
# Normal two-way sync
python3 integrations/linear-vault-sync/sync.py

# Maintain Linear mapping aliases (preview first)
python3 integrations/linear-vault-sync/maintain_mappings.py --dry-run

# Apply mapping aliases + rewrite vault files
python3 integrations/linear-vault-sync/maintain_mappings.py

# Preview first
python3 integrations/linear-vault-sync/sync.py --dry-run

# Backfill: add linear-id to existing vault files
python3 integrations/linear-vault-sync/sync.py --backfill

# Resolve conflicts (e.g. vault wins for status, Linear for title)
python3 integrations/linear-vault-sync/sync.py --resolve status=vault --resolve title=linear

# On-demand rolling 24h task report (Obsidian + Linear)
python3 integrations/linear-vault-sync/report_tasks.py --vault-path . --hours 24 --include-linear

# Daily-style report posted to Slack
python3 integrations/linear-vault-sync/report_tasks.py --vault-path . --mode daily --include-linear --post-slack
```

Options: `--dry-run`, `--backfill`, `--verbose`, `--resolve FIELD=SOURCE`, `--vault-path <path>` (default: current directory).

## Config and state

- **Config:** `integrations/linear-vault-sync/config.json` — team mapping, status mapping.
- **Owner push gating:** tasks are only synced to Linear when the extracted task `Owner` matches a real Linear user.
  - `linear_push_owner_allowlist` remains as a fallback override if the Linear user list fetch fails.
- If a legacy task doesn't include an `Owner` line, sync will preserve existing behavior (no gating) to avoid diverting many historical tasks.
- **State:** `.claude/sync-state.json` (vault root) — last sync and item mapping.
- **Conflicts:** `.claude/sync-conflicts.json` (vault root) — when both sides changed the same field.

Vault files need `linear-id` (and optionally `linear-updated`) in frontmatter to participate in sync. See `docs/superpowers/specs/2026-03-17-linear-sync-design.md` for the full design.
