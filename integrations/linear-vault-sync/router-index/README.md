# Router Linear Index

This folder contains Linear synchronization data used by `ai-note-router` for routing and identification.

It is not part of your everyday notes workflow.

## Purpose

- Cache canonical Linear teams/projects locally.
- Improve router success rate when matching team/project names.
- Hold manual alias mappings for non-canonical names.

## Files

- `index.json` - machine-readable cache used by routing.
- `teams.md` - generated team reference.
- `projects.md` - generated project reference.
- `aliases.json` - manual alias map (`teamNameAliases`, `projectNameAliases`).

## Refresh

Run:

`npm run linear-sync-index`

The router also refreshes these files at startup when `LINEAR_API_KEY` is available.
