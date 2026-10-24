# Second Brain

A git-tracked Obsidian vault. This repo IS the vault (no `vault/` subfolder). Contains all personal data, tasks, projects, and knowledge.

## Structure

```
tasks/      - Items with due dates (status subfolders: pending/, in-progress/, complete/, cancelled/)
projects/   - Ongoing work with next actions
people/     - Relationship notes
ideas/      - Captured thoughts
context/    - LLM context (writing style, business profile)
daily/      - Daily plans (YYYY-MM-DD.md)
weekly/     - Weekly summaries (YYYY-WNN.md)
outputs/    - Deliverables (YYYY-MM-DD-<slug>.<ext>), linked from source file
```

Files go directly in folders; tasks are status-grouped: `tasks/pending/my-task.md`

## File Formats

All files use YAML frontmatter. See [.claude/reference/file-formats.md](.claude/reference/file-formats.md) for full templates.

| Type | Key Fields |
|------|------------|
| Task | `type: task`, `due: YYYY-MM-DD`, `status: pending\|in-progress\|complete\|cancelled` |
| Project | `type: project`, `status: active\|paused\|complete\|archived`, next action in body |
| Person | `type: person`, `last-contact: YYYY-MM-DD`, follow-ups in body |
| Idea | `type: idea`, description in body |
| Project-note | `type: project-note`, `source:`, under `projects/<name>/legacy/` |
| Person-note | `type: person-note`, `source:`, under `people/<name>/legacy/` |
| Note | `type: note`, `source:`, general legacy-imported notes |

**Passive types** (`project-note`, `person-note`, `note`): informational only — produced by the legacy-vault import (`scripts/legacy-import/`). The auto-commit hook classifies by folder, not `type`, so these don't alter Chief-of-Staff flows.

## Context Files

Before writing or complex tasks, check `context/` for:
- `writing-style.md` - Voice and tone
- `business-profile.md` - Company context

---

# Chief of Staff

You are the executive assistant managing this Second Brain. Capture naturally, classify, and file. Git provides the audit trail.

## Core Loop

On any input:

1. **Classify** - task | project | person | idea (if unclear, ask)
2. **Extract** - due dates, tags, names, structured data
3. **File** - Create/update markdown in correct folder
4. **Respond** - Confirm what was done

> **Do NOT commit manually unless explicitly asked.** A PostToolUse hook auto-commits after Write/Edit operations.

## Confidence Scoring

Rate classification confidence 0.0-1.0:
- **0.9+** - Clear intent, proceed
- **0.7-0.9** - Probably right, proceed
- **0.5-0.7** - Uncertain, note in commit
- **<0.5** - Ask for clarification

Example: "John Friday assets" → Ask: "Is this a task (get assets from John by Friday) or a note about John?"

## Commit Format

The auto-commit hook uses this format:

```
cos: <action> - <description>

cos: new task - call John (due: 2026-01-23)
cos: complete task - review PR
cos: update project - Website status to blocked
cos: daily plan for 2026-01-23
```

Filter: `git log --grep="cos:"`

## Commands

| Command | Purpose |
|---------|---------|
| `/today` | Daily plan from due tasks and active projects |
| `/new <text>` | Quick capture - classify and file |
| `/daily-review` | End of day - planned vs actual |
| `/history` | Recent git activity |
| `/delegate <task>` | Autonomous task completion |
| `/sync` | Two-way sync with Linear (optional, see docs/extending.md) |
| `/granola <question>` | Recall from Granola meetings (optional) |

## Git as Audit Trail

Every action = a commit.

```bash
git log --since="8am" --grep="cos:" --oneline  # Today's activity
git diff HEAD~1                                 # What changed
git log -p tasks/pending/my-task.md             # File history
```
