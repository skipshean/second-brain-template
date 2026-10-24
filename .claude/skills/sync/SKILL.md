# /sync - Linear ↔ Vault Sync

Run two-way sync between the vault and Linear.

## Usage

```bash
python3 integrations/linear-vault-sync/sync.py [options]
```

## Options

- `--dry-run` — Preview changes without applying
- `--backfill` — One-time: add linear-id to existing vault files
- `--resolve FIELD=SOURCE` — Auto-resolve conflicts per field (e.g., `--resolve status=vault --resolve title=linear`)
- `--verbose` — Show detailed per-item output
- `--vault-path <path>` — Override vault root (default: current directory)

## Steps

1. Run the sync script with appropriate flags
2. Present the summary output to the user
3. If conflicts reported, read `.claude/sync-conflicts.json` and present them
4. If backfill mode, report how many files were updated

## Examples

```bash
# Normal sync
python3 integrations/linear-vault-sync/sync.py

# Preview first
python3 integrations/linear-vault-sync/sync.py --dry-run

# Initial setup: backfill existing files
python3 integrations/linear-vault-sync/sync.py --backfill

# Resolve conflicts: vault wins for status/due, Linear wins for title/description
python3 integrations/linear-vault-sync/sync.py --resolve status=vault --resolve due=vault --resolve title=linear --resolve description=linear
```
