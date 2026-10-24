---
name: granola
description: On-demand recall across Granola meeting notes via the Granola MCP — answer natural-language questions about what was discussed, decided, or committed to, with citations back to the source notes. Use when the user asks about meeting content, follow-ups, or transcripts.
argument-hint: <what you want to know from your meetings>
allowed-tools: Read, Write, Edit, AskUserQuestion
---

# /granola - Meeting Recall

Answer questions across the user's Granola meetings on demand. This is the
**retrieval** counterpart to the AI Note Router: the router *ingests* Granola
notes into the vault automatically (folders → routing, transcripts → tasks),
while this skill *queries* Granola live to answer ad-hoc questions.

Query is in $ARGUMENTS.

## When to use vs. the router

- **This skill (interactive):** "What did we decide about X?", "What are my open
  follow-ups from this week's calls?", "Pull the exact quote where Sam said …".
  Uses the Granola MCP, which requires interactive OAuth — it only works in a
  live session, never in the headless router/launchd path.
- **The router (headless):** automatic ingest of new notes into `meetings/`,
  `projects/`, and Linear. Do not use this skill for ingest.

## Tools (Granola MCP — `mcp__…__*`)

The Granola MCP server exposes these read-only tools. Load their schemas with
ToolSearch if they are deferred (search `query_granola_meetings`).

- **`query_granola_meetings`** — natural-language query across notes. Returns a
  synthesized answer **with inline citation links** like `[[0]](url)`.
  **Preserve these citations verbatim** in your response — they let the user
  click through to the source note. This is the default tool for open-ended
  questions.
- **`list_meetings`** — list notes in a time range (`this_week`, `last_week`,
  `last_30_days`, or `custom` with `custom_start`/`custom_end`), optional
  `folder_id`. Returns titles + metadata.
- **`list_meeting_folders`** — folders (client/engagement buckets) with IDs and
  note counts. Use to scope a query to one client.
- **`get_meetings`** — full detail for up to 10 meeting IDs: **private notes**,
  AI summary, attendees, metadata. Note: private "My Notes" are available here
  but NOT via the router's REST poller, so this skill is the only way to surface
  them.
- **`get_meeting_transcript`** — verbatim transcript by meeting ID. Speaker
  labels: `Microphone` = the note-taker (the user), `Speaker` = others, named
  speakers by name. Use only when an exact quote or literal wording is needed.

## Steps

1. **Choose the tool by intent:**
   - Open-ended / "what/why/what did we decide" → `query_granola_meetings`
     (pass `$ARGUMENTS` as the query). Add `document_ids` to scope if you already
     know the meeting(s).
   - "list my meetings [with X / this week]" → `list_meetings` (+ `folder_id`
     from `list_meeting_folders` to scope to a client).
   - Exact quote / literal wording → identify the meeting, then
     `get_meeting_transcript`.
   - Needs the user's own private notes → `get_meetings`.
2. **Run the query.** If the account/workspace matters, confirm with
   `get_account_info` first.
3. **Answer concisely**, preserving all `[[n]](url)` citations from
   `query_granola_meetings`.
4. **Offer to capture** (do not auto-file): if the answer contains a task,
   decision, or follow-up worth keeping, offer to run `/new` to file it into the
   vault. Only write to the vault on explicit confirmation.

## Notes

- If the MCP is not connected, tell the user to add it in their claude.ai
  connector settings (or `claude mcp add granola --transport http https://mcp.granola.ai/mcp`).
  It authenticates via browser OAuth; there are no API keys to paste.
- Folders/transcripts require a paid Granola plan; the free tier is limited to
  the last 30 days of personal notes.
- Rate limit is ~100 requests/min across all tools — batch meeting IDs
  (`get_meetings` takes up to 10) rather than looping one at a time.
