# Integration test plan (pre-PR)

Run from the **repo root** (e.g. `second-brain` worktree). Use this before merging `feat/ai-note-router` into `main`.

---

## Prerequisites

- [ ] Node 18+ and `npm` available
- [ ] Python 3 available
- [ ] Repo root is the working directory for all commands below

---

## 0. Fireflies & Granola connection (do this first)

Confirm the router can receive and accept payloads from (or on behalf of) Fireflies and Granola before running the rest of the plan.

### 0a. Ingest endpoints accept payloads (local)

- [ ] **Start server**  
  `npm run serve -- --dry-run --port 3340`  
  (Leave it running for the two curls below.)

- [ ] **Fireflies ingest**  
  `curl -s -w "\n%{http_code}" -X POST http://localhost:3340/ingest/fireflies -H "Content-Type: application/json" -d @integrations/ai-note-router/examples/fireflies-sample.json`  
  Expect: HTTP 200 and JSON with `"ok": true`, `"queued": true`.  
  If you use `FIREFLIES_WEBHOOK_SECRET`, add: `-H "x-router-token: $FIREFLIES_WEBHOOK_SECRET"`.

- [ ] **Granola ingest**  
  `curl -s -w "\n%{http_code}" -X POST http://localhost:3340/ingest/granola -H "Content-Type: application/json" -d @integrations/ai-note-router/inbox/granola-sample.json`  
  Expect: HTTP 200 and JSON with `"ok": true`, `"queued": true`.  
  If you use `GRANOLA_WEBHOOK_SECRET`, add: `-H "x-router-token: $GRANOLA_WEBHOOK_SECRET"`.

- [ ] Stop the server (Ctrl+C).

This proves the router’s ingest URLs and payload shape work. If either curl fails (4xx/5xx or missing required fields), fix that before continuing.

### 0b. Fireflies can reach your server (if using Fireflies webhook)

Only if you’ve configured Fireflies to POST to your router:

- [ ] **URL reachable**  
  If your router runs on a public URL (e.g. ngrok, tunnel, or host): from another machine or a browser, open `https://<your-url>/health`. Expect `{"ok": true}`.  
  If you only run locally, Fireflies cannot reach you; use Zapier or an adapter that forwards to localhost, or skip until after deploy.

- [ ] **Optional: real Fireflies event**  
  In Fireflies: upload a short test audio or use a test meeting; when the transcription completes, confirm your server received a POST (check server logs or that a new file appeared in the inbox). If Fireflies sends only `meetingId`/`eventType`, your middleware must fetch the transcript and POST the full payload to the router—verify that pipeline once.

### 0c. Granola can reach your server (if using Zapier or API)

- [ ] **Zapier (if used)**  
  In Zapier: run a test for the Granola → Webhooks by Zapier Zap. Confirm the test POST hits your ingest URL and returns 200. If the Zap points at a public URL, ensure that URL is the one you tested in 0a (or the same host/port).

- [ ] **Granola API (if using Enterprise poller)**  
  If you rely on the Granola API to pull notes: verify your API key (e.g. call their API from the machine that will run the poller). No need to run the full poller here—just confirm the key works.

Once 0a (and 0b/0c for whichever sources you use) pass, proceed to the steps below.

---

## 1. AI note router — build and config

- [ ] **Build**  
  `npm run build`  
  Expect: no errors; `integrations/ai-note-router/dist/` populated.

- [ ] **Config loads**  
  `npm start -- --dry-run`  
  Expect: JSON audit line with `"stage": "startup"` and `"message": "AI note router scaffold loaded"`; then batch summary (processed/skipped). No disk writes (dry-run).

---

## 2. AI note router — batch and single-file (dry-run)

- [ ] **Batch dry-run**  
  `npm run replay -- --dry-run`  
  Expect: same as above; inbox JSON files (if any) are read; output shows plan only, no writes.

- [ ] **Single file dry-run**  
  `node integrations/ai-note-router/dist/index.js --input integrations/ai-note-router/examples/fireflies-sample.json --dry-run`  
  Expect: audit + plan JSON for that one note; no file or Linear changes.

---

## 3. AI note router — serve and health

- [ ] **Server starts**  
  `npm run serve -- --dry-run --port 3340`  
  Expect: log line like `AI note router webhook server listening on http://localhost:3340`. If `LINEAR_API_KEY` is set, a startup line for Linear connection (OK or failed).

- [ ] **Health endpoint**  
  In another terminal: `curl -s http://localhost:3340/health`  
  Expect: `{"ok": true}`.

- [ ] **Watcher disabled when no source connected**  
  With default `authority.yaml` (`connected: false` for fireflies and granola), expect an audit line like `"Inbox watcher disabled: no inbound source has enabled and connected in config"`. No watcher processing.

- [ ] Stop the server (Ctrl+C in the serve terminal).

---

## 4. Linear ↔ Vault sync

- [ ] **Sync dry-run from new path**  
  `python3 integrations/linear-vault-sync/sync.py --dry-run`  
  Expect: either runs and prints a summary (if `LINEAR_API_KEY` is set), or exits with a clear error about `LINEAR_API_KEY` not set. No vault or Linear changes (dry-run).

- [ ] **Sync skill path**  
  Confirm `.claude/skills/sync/SKILL.md` tells you to run `python3 integrations/linear-vault-sync/sync.py`. No reference to `.claude/scripts/linear-sync`.

---

## 5. Quick live check (optional)

If you have `LINEAR_API_KEY` set and want a minimal live test:

- [ ] **Replay without dry-run** (processes inbox → vault; Linear if key set)  
  `npm run replay`  
  Expect: audit logs and batch summary; `outputs/ai-note-router/processed-state.json` updated if any inbox file was processed; project note under `projects/` updated if routing matched.

- [ ] **Linear-vault sync without dry-run** (one sync run)  
  `python3 integrations/linear-vault-sync/sync.py`  
  Expect: summary of synced/skipped/errors; vault files with `linear-id` and Linear stay consistent (or no changes if already in sync).

---

## Sign-off

- [ ] All steps above that you ran passed or behaved as expected.
- [ ] Ready to open PR: `feat/ai-note-router` → `main`.
