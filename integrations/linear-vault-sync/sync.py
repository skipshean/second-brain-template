"""Main sync orchestrator — CLI entry point."""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from vault import (
    parse_vault_file, update_vault_file, extract_linear_url,
    extract_linear_id_from_url, read_vault_dir, write_vault_file,
    serialize_frontmatter,
)
from linear_api import LinearClient, LinearAPIError
from differ import diff_task, DiffResult
from resolver import resolve_changes, log_conflicts

CONFIG_PATH = SCRIPT_DIR / "config.json"
TASK_LINKS_START = "<!-- linear-sync:links:start -->"
TASK_LINKS_END = "<!-- linear-sync:links:end -->"
# Map misspelled/alternate project slugs to canonical slugs, e.g. "acme-analytic": "acme-analytics".
PROJECT_ALIAS_BY_SLUG: dict = {}


def load_config() -> dict:
    with open(CONFIG_PATH) as f:
        return json.load(f)


def load_sync_state(vault_path: str) -> dict:
    state_path = Path(vault_path) / ".claude" / "sync-state.json"
    if state_path.exists():
        with open(state_path) as f:
            return json.load(f)
    return {"last_sync": None, "items": {}}


def save_sync_state(vault_path: str, state: dict) -> None:
    state_path = Path(vault_path) / ".claude" / "sync-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with open(state_path, "w") as f:
        json.dump(state, f, indent=2)
        f.write("\n")


def iso_to_epoch(iso_str: str) -> float:
    if not iso_str:
        return 0.0
    try:
        iso_str = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(iso_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return 0.0


def vault_status_to_linear(status: str, item_type: str, config: dict) -> str | None:
    mapping = config["status_mapping"].get(item_type, {}).get("vault_to_linear", {})
    return mapping.get(status)


def linear_status_to_vault(status_type: str, item_type: str, config: dict) -> str | None:
    mapping = config["status_mapping"].get(item_type, {}).get("linear_to_vault", {})
    return mapping.get(status_type)


def tag_to_team(tag: str, config: dict) -> dict | None:
    return config.get("team_mapping", {}).get(tag)


def team_to_tag(team_name: str, config: dict) -> str | None:
    for tag, info in config.get("team_mapping", {}).items():
        if team_name.lower().replace(" ", "-") == tag or \
           info.get("key", "").upper() == team_name.upper():
            return tag
    return team_name.lower().replace(" ", "-")


def extract_owner_and_emails(body: str) -> tuple[str, list[str]]:
    """
    Extract task owner name and any email addresses from the markdown body.

    Example body fragments:
    - "* **Owner:** Alex Morgan ([you@example.com](mailto:you@example.com))"
    - "* **Owner:** Stacy McCarthy"
    """
    # Capture the line fragment right after "**Owner:**" up to end-of-line or another bold field marker.
    m = re.search(r"\*\*\s*Owner:\s*([^\n\r*]+)", body or "")
    owner_raw = (m.group(1).strip() if m else "").strip()

    # Normalize owner name by removing parenthesized contact info.
    owner_name = re.sub(r"\s*\(.*\)\s*", "", owner_raw).strip()

    # Only consider emails that appear on the Owner line (avoid false positives from
    # other "assigned to" notes elsewhere in the body).
    emails = re.findall(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", owner_raw)
    # De-dupe while preserving order
    seen = set()
    out_emails: list[str] = []
    for e in emails:
        e_l = e.lower()
        if e_l in seen:
            continue
        seen.add(e_l)
        out_emails.append(e_l)

    return owner_name, out_emails


def build_allowed_owner_filters(client: LinearClient, config: dict) -> tuple[set[str], set[str]]:
    """
    Build the allow filters for which task owners are allowed to be synced to Linear.

    Primary source: Linear's current user list (names/emails).
    Fallback: `config.linear_push_owner_allowlist`.
    """
    allowlist = config.get("linear_push_owner_allowlist") or {}
    fallback_names = {str(x).strip().lower() for x in allowlist.get("names", []) if str(x).strip()}
    fallback_emails = {str(x).strip().lower() for x in allowlist.get("emails", []) if str(x).strip()}

    try:
        linear_users = client.get_all_users()
    except LinearAPIError:
        # If we can't fetch users, fall back to allowlist to avoid breaking sync.
        return fallback_names, fallback_emails

    linear_names = {str(u.get("name", "")).strip().lower() for u in linear_users if str(u.get("name", "")).strip()}
    linear_emails = {str(u.get("email", "")).strip().lower() for u in linear_users if str(u.get("email", "")).strip()}

    # If Linear returned an empty set (unexpected), preserve old behavior by using fallback.
    if not linear_names and not linear_emails:
        return fallback_names, fallback_emails

    # Union so the static allowlist can still be used as an override.
    return linear_names | fallback_names, linear_emails | fallback_emails


def task_owner_is_allowed(body: str, allowed_names: set[str], allowed_emails: set[str]) -> bool:
    owner_name, emails = extract_owner_and_emails(body)
    owner_name_l = owner_name.lower()

    # If we can't validate (no allow filters), fail open.
    if not allowed_names and not allowed_emails:
        return True

    if owner_name_l == "" and len(emails) == 0:
        # Owner is missing/unknown; preserve existing behavior so we don't
        # accidentally divert large numbers of legacy tasks.
        return True

    # Allow name matches (exact or substring, since some bodies use "Alex" vs "Alex Morgan").
    for n in allowed_names:
        if not n:
            continue
        if owner_name_l == n or (n in owner_name_l) or (owner_name_l in n):
            return True

    # If we couldn't extract an owner name, fall back to email match from the Owner line.
    if owner_name_l == "":
        for e in emails:
            if e in allowed_emails:
                return True

    return False


def get_review_state_id(team_id: str, client: LinearClient) -> str | None:
    """
    Find a workflow state to use as a "review / triage" queue.
    Falls back to "unstarted/todo/backlog" when no explicit review state exists.
    """
    try:
        states = client.get_workflow_states(team_id)
    except LinearAPIError:
        return None

    # Prefer explicit review/triage naming.
    for s in states:
        name = str(s.get("name", "") or "")
        state_type = str(s.get("type", "") or "")
        if re.search(r"review|triage", name, flags=re.IGNORECASE):
            return s.get("id")

        # Some Linear accounts may have a typed "review" state.
        if state_type.lower() == "review":
            return s.get("id")

    # Fallback to "todo/unstarted/backlog".
    for s in states:
        state_type = str(s.get("type", "") or "").lower()
        name = str(s.get("name", "") or "")
        if state_type == "unstarted" or re.search(r"todo|backlog", name, flags=re.IGNORECASE):
            return s.get("id")

    return None


def make_filename(team_key: str, title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower().strip())
    slug = slug.strip("-")
    parts = slug.split("-")[:6]
    slug = "-".join(parts)
    return f"{team_key.lower()}-{slug}"


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower().strip())
    return slug.strip("-")


def resolve_project_wikilink(vault_path: str, tags: list[str]) -> str | None:
    if not tags:
        return None
    projects_dir = Path(vault_path) / "projects"
    if not projects_dir.exists():
        return None

    by_slug = {}
    for md in projects_dir.glob("*.md"):
        by_slug[slugify(md.stem)] = md.stem

    for tag in tags:
        tag_slug = slugify(str(tag))
        tag_slug = PROJECT_ALIAS_BY_SLUG.get(tag_slug, tag_slug)
        if not tag_slug:
            continue
        project_name = by_slug.get(tag_slug)
        if project_name:
            return f"[[projects/{tag_slug}|{project_name}]]"
    return None


def upsert_task_links_block(content: str, linear_url: str, project_wikilink: str | None) -> str:
    block_lines = [
        TASK_LINKS_START,
        "## Sync Links",
        "",
        f"- Linear: [{linear_url}]({linear_url})" if linear_url else "- Linear: (missing)",
        f"- Project: {project_wikilink}" if project_wikilink else "- Project: (unresolved)",
        TASK_LINKS_END,
    ]
    block = "\n".join(block_lines)
    pattern = re.compile(
        re.escape(TASK_LINKS_START) + r"[\s\S]*?" + re.escape(TASK_LINKS_END),
        re.MULTILINE,
    )
    if pattern.search(content):
        return pattern.sub(block, content)
    return f"{content.rstrip()}\n\n{block}\n"


def extract_vault_fields(parsed: dict) -> dict:
    fm = parsed["frontmatter"]
    return {
        "status": fm.get("status", ""),
        "due": fm.get("due", ""),
        "title": parsed.get("title", ""),
        "description": parsed.get("body", ""),
    }


def extract_linear_fields(item: dict, item_type: str, config: dict) -> dict:
    if item_type == "tasks":
        state = item.get("state", {})
        status = linear_status_to_vault(
            state.get("type", ""), "tasks", config
        ) or "pending"
        return {
            "status": status,
            "due": item.get("dueDate") or "",
            "title": item.get("title", ""),
            "description": item.get("description") or "",
        }
    else:
        proj_status = item.get("status", {})
        status = linear_status_to_vault(
            proj_status.get("name", ""), "projects", config
        ) or "paused"
        return {
            "status": status,
            "due": "",
            "title": item.get("name", ""),
            "description": item.get("description") or "",
        }


def backfill(vault_path: str, config: dict, client: LinearClient,
             dry_run: bool = False, verbose: bool = False) -> dict:
    """Backfill linear-id and linear-updated into existing vault files."""
    stats = {"updated": 0, "skipped": 0, "errors": 0}

    for folder in config.get("sync_folders", ["tasks", "projects"]):
        items = read_vault_dir(vault_path, folder)
        for item in items:
            fm = item["parsed"]["frontmatter"]

            if fm.get("linear-id"):
                stats["skipped"] += 1
                continue

            full_text = item["parsed"].get("body", "")
            linear_url = extract_linear_url(full_text)
            if not linear_url:
                stats["skipped"] += 1
                continue

            linear_id = extract_linear_id_from_url(linear_url)
            if not linear_id:
                stats["skipped"] += 1
                continue

            try:
                if folder == "tasks":
                    linear_item = client.get_issue_by_identifier(linear_id)
                else:
                    linear_item = client.get_project_by_slug(linear_id)

                if not linear_item:
                    if verbose:
                        print(f"  Not found in Linear: {linear_id}")
                    stats["skipped"] += 1
                    continue

                updated_at = linear_item.get("updatedAt", "")

                if dry_run:
                    print(f"  Would backfill: {item['relative_path']} -> {linear_id}")
                    stats["updated"] += 1
                    continue

                new_content = update_vault_file(item["content"], {
                    "frontmatter": {
                        "linear-id": linear_id,
                        "linear-updated": updated_at,
                    }
                })
                write_vault_file(item["path"], new_content)
                if verbose:
                    print(f"  Backfilled: {item['relative_path']} -> {linear_id}")
                stats["updated"] += 1

            except LinearAPIError as e:
                print(f"  Error backfilling {item['relative_path']}: {e}")
                stats["errors"] += 1

    return stats


def parse_resolve_rules(resolve_args: list[str]) -> dict:
    """Parse --resolve FIELD=SOURCE args into {field: source} dict."""
    rules = {}
    for arg in resolve_args:
        if "=" not in arg:
            print(f"  Warning: invalid --resolve format '{arg}', expected FIELD=SOURCE")
            continue
        field, source = arg.split("=", 1)
        if source not in ("vault", "linear"):
            print(f"  Warning: invalid source '{source}', must be 'vault' or 'linear'")
            continue
        rules[field] = source
    return rules


def sync(vault_path: str, config: dict, client: LinearClient,
         dry_run: bool = False, verbose: bool = False,
         resolve_rules: dict | None = None) -> dict:
    """Run two-way sync between vault and Linear."""
    stats = {
        "pushed": {"tasks": 0, "projects": 0},
        "pulled": {"tasks": 0, "projects": 0},
        "new_in_vault": {"tasks": 0, "projects": 0},
        "new_in_linear": {"tasks": 0, "projects": 0},
        "conflicts": 0,
        "skipped": 0,
        "skipped_push_not_allowed_owner": 0,
        "skipped_create_not_allowed_owner": 0,
        "errors": 0,
    }

    state = load_sync_state(vault_path)
    last_sync = iso_to_epoch(state.get("last_sync", ""))
    conflicts_path = str(Path(vault_path) / ".claude" / "sync-conflicts.json")
    all_conflicts = []

    allowed_user_names, allowed_user_emails = build_allowed_owner_filters(client, config)

    for folder in config.get("sync_folders", ["tasks", "projects"]):
        vault_items = read_vault_dir(vault_path, folder)

        vault_by_linear_id = {}
        vault_without_id = []
        for item in vault_items:
            lid = item["parsed"]["frontmatter"].get("linear-id")
            if lid:
                vault_by_linear_id[lid] = item
            else:
                vault_without_id.append(item)

        try:
            if folder == "tasks":
                linear_items = client.get_all_issues()
                linear_by_id = {i["identifier"]: i for i in linear_items}
            else:
                linear_items = client.get_all_projects()
                linear_by_id = {}
                for p in linear_items:
                    url = p.get("url", "")
                    slug = extract_linear_id_from_url(url) if url else None
                    if slug:
                        linear_by_id[slug] = p
        except LinearAPIError as e:
            print(f"  Error fetching Linear {folder}: {e}")
            stats["errors"] += 1
            continue

        # Sync existing linked items
        for linear_id, vault_item in vault_by_linear_id.items():
            linear_item = linear_by_id.get(linear_id)
            if not linear_item:
                if verbose:
                    print(f"  Linear item not found: {linear_id}")
                stats["skipped"] += 1
                continue

            vault_fields = extract_vault_fields(vault_item["parsed"])
            linear_fields = extract_linear_fields(linear_item, folder, config)

            vault_mtime = vault_item["mtime"]
            linear_updated = iso_to_epoch(linear_item.get("updatedAt", ""))

            diff = diff_task(vault_fields, linear_fields,
                             vault_mtime, linear_updated, last_sync)

            if diff.conflicts:
                for c in diff.conflicts:
                    c["file"] = vault_item["relative_path"]
                    c["linear_id"] = linear_id
                    # Auto-resolve if rule exists for this field
                    if resolve_rules and c["field"] in resolve_rules:
                        source = resolve_rules[c["field"]]
                        direction = "push" if source == "vault" else "pull"
                        value = c["vault_value"] if source == "vault" else c["linear_value"]
                        diff.changes.append({
                            "field": c["field"],
                            "direction": direction,
                            "value": value,
                        })
                        if verbose:
                            print(f"  Auto-resolved {c['field']}: {source} wins for {vault_item['relative_path']}")
                    else:
                        all_conflicts.append(c)
                        stats["conflicts"] += 1

            if diff.changes:
                push_updates, pull_updates = resolve_changes(diff.changes)

                # Push to Linear
                if push_updates:
                    owner_allowed = True
                    if folder == "tasks":
                        owner_allowed = task_owner_is_allowed(
                            vault_item["parsed"].get("body", ""),
                            allowed_user_names,
                            allowed_user_emails,
                        )

                    if not owner_allowed:
                        if folder == "tasks":
                            # Fail-open: move the existing linked issue into a Review/Triage state,
                            # but do not overwrite title/description/due.
                            team = linear_item.get("team", {})
                            team_id = team.get("id") if isinstance(team, dict) else None
                            if team_id:
                                review_state_id = get_review_state_id(team_id, client)
                                if review_state_id:
                                    if not dry_run:
                                        try:
                                            client.update_issue(linear_item["id"], {"stateId": review_state_id})
                                            stats["pushed"][folder] += 1
                                            if verbose:
                                                print(
                                                    f"  Moved to review (task owner not allowlisted): {vault_item['relative_path']}"
                                                )
                                        except LinearAPIError as e:
                                            print(f"  Error moving to review {linear_id}: {e}")
                                            stats["errors"] += 1
                                    else:
                                        if verbose:
                                            print(
                                                f"  Would move to review (task owner not allowlisted): {vault_item['relative_path']}"
                                            )
                                        stats["pushed"][folder] += 1
                                else:
                                    stats["skipped_push_not_allowed_owner"] += 1
                                    if verbose:
                                        print(f"  Skipping push (no review state found): {vault_item['relative_path']}")
                            else:
                                stats["skipped_push_not_allowed_owner"] += 1
                                if verbose:
                                    print(f"  Skipping push (missing team id): {vault_item['relative_path']}")
                        else:
                            stats["skipped_push_not_allowed_owner"] += 1
                            if verbose:
                                print(f"  Skipping push (not allowlisted): {vault_item['relative_path']}")
                    else:
                        linear_updates = {}
                        if "status" in push_updates:
                            target_type = vault_status_to_linear(
                                push_updates["status"], folder, config
                            )
                            if target_type and folder == "tasks":
                                team = linear_item.get("team", {})
                                team_id = team.get("id") if isinstance(team, dict) else None
                                if team_id:
                                    try:
                                        states = client.get_workflow_states(team_id)
                                        for s in states:
                                            if s.get("type") == target_type:
                                                linear_updates["stateId"] = s["id"]
                                                break
                                    except LinearAPIError:
                                        pass
                        if "due" in push_updates:
                            if folder == "tasks":
                                linear_updates["dueDate"] = push_updates["due"] or None
                            else:
                                linear_updates["targetDate"] = push_updates["due"] or None
                        if "title" in push_updates:
                            if folder == "tasks":
                                linear_updates["title"] = push_updates["title"]
                            else:
                                linear_updates["name"] = push_updates["title"]
                        if "description" in push_updates and folder == "tasks":
                            linear_updates["description"] = push_updates["description"]

                        if linear_updates and not dry_run:
                            try:
                                if folder == "tasks":
                                    client.update_issue(linear_item["id"], linear_updates)
                                else:
                                    client.update_project(linear_item["id"], linear_updates)
                                stats["pushed"][folder] += 1
                                if verbose:
                                    print(f"  Pushed: {vault_item['relative_path']} -> {linear_id}")
                            except LinearAPIError as e:
                                print(f"  Error pushing {linear_id}: {e}")
                                stats["errors"] += 1
                        elif linear_updates and dry_run:
                            print(f"  Would push: {vault_item['relative_path']} -> {linear_id}: {list(linear_updates.keys())}")
                            stats["pushed"][folder] += 1

                # Pull to vault
                if pull_updates:
                    fm_updates = {}
                    if "status" in pull_updates:
                        fm_updates["status"] = pull_updates["status"]
                    if "due" in pull_updates:
                        fm_updates["due"] = pull_updates["due"]

                    content_updates = {}
                    if fm_updates:
                        content_updates["frontmatter"] = fm_updates
                    if "title" in pull_updates:
                        content_updates["title"] = pull_updates["title"]

                    if "frontmatter" not in content_updates:
                        content_updates["frontmatter"] = {}
                    content_updates["frontmatter"]["linear-updated"] = \
                        linear_item.get("updatedAt", "")

                    if not dry_run:
                        new_content = update_vault_file(
                            vault_item["content"], content_updates
                        )
                        if folder == "tasks":
                            tags = vault_item["parsed"]["frontmatter"].get("tags", [])
                            project_wikilink = resolve_project_wikilink(vault_path, tags if isinstance(tags, list) else [])
                            new_content = upsert_task_links_block(
                                new_content,
                                linear_item.get("url", ""),
                                project_wikilink,
                            )
                        write_vault_file(vault_item["path"], new_content)
                        stats["pulled"][folder] += 1
                        if verbose:
                            print(f"  Pulled: {linear_id} -> {vault_item['relative_path']}")
                    else:
                        print(f"  Would pull: {linear_id} -> {vault_item['relative_path']}: {list(pull_updates.keys())}")
                        stats["pulled"][folder] += 1

            linear_by_id.pop(linear_id, None)

        # New vault items -> push to Linear
        for vault_item in vault_without_id:
            fm = vault_item["parsed"]["frontmatter"]
            tags = fm.get("tags", [])
            if not tags:
                stats["skipped"] += 1
                continue

            team_info = tag_to_team(tags[0], config)
            if not team_info:
                if verbose:
                    print(f"  No team mapping for tag '{tags[0]}': {vault_item['relative_path']}")
                stats["skipped"] += 1
                continue

            if folder == "tasks":
                # Only push tasks owned by allowlisted Linear users (currently you).
                if not task_owner_is_allowed(
                    vault_item["parsed"].get("body", ""),
                    allowed_user_names,
                    allowed_user_emails,
                ):
                    stats["skipped_create_not_allowed_owner"] += 1
                    if verbose:
                        print(f"  Skipping create (task owner not allowlisted): {vault_item['relative_path']}")
                    continue

                title = vault_item["parsed"].get("title", vault_item["filename"])
                description = vault_item["parsed"].get("body", "")

                create_kwargs = {}
                if fm.get("due"):
                    create_kwargs["dueDate"] = fm["due"]

                if dry_run:
                    print(f"  Would create in Linear: {vault_item['relative_path']} -> {team_info['key']}")
                    stats["new_in_vault"][folder] += 1
                    continue

                try:
                    result = client.create_issue(
                        team_id=team_info["id"],
                        title=title,
                        description=description,
                        **create_kwargs
                    )
                    if result.get("success"):
                        issue = result.get("issue", {})
                        new_content = update_vault_file(vault_item["content"], {
                            "frontmatter": {
                                "linear-id": issue.get("identifier", ""),
                                "linear-updated": issue.get("updatedAt", ""),
                            }
                        })
                        project_wikilink = resolve_project_wikilink(vault_path, fm.get("tags", []))
                        new_content = upsert_task_links_block(
                            new_content,
                            issue.get("url", ""),
                            project_wikilink,
                        )
                        write_vault_file(vault_item["path"], new_content)
                        stats["new_in_vault"][folder] += 1
                        if verbose:
                            print(f"  Created: {vault_item['relative_path']} -> {issue.get('identifier')}")
                except LinearAPIError as e:
                    print(f"  Error creating {vault_item['relative_path']}: {e}")
                    stats["errors"] += 1

        # New Linear items -> pull to vault
        for linear_id, linear_item in linear_by_id.items():
            if folder == "tasks":
                team = linear_item.get("team", {})
                team_key = team.get("key", "UNK") if isinstance(team, dict) else "UNK"
                title = linear_item.get("title", "Untitled")
                filename = make_filename(team_key, title)
                file_path = str(Path(vault_path) / folder / f"{filename}.md")

                if Path(file_path).exists():
                    stats["skipped"] += 1
                    continue

                team_name = team.get("name", "") if isinstance(team, dict) else ""
                tag = team_to_tag(team_name, config)
                linear_fields = extract_linear_fields(linear_item, folder, config)

                due_line = f"due: {linear_fields['due']}\n" if linear_fields['due'] else ""
                content = f"""---
type: task
status: {linear_fields['status']}
{due_line}tags: [{tag}]
created: {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')}
linear-id: {linear_id}
linear-updated: {linear_item.get('updatedAt', '')}
---

# {title}

{linear_fields['description'] or title}

## Notes
- Linear: {linear_item.get('url', '')}
"""
                project_wikilink = resolve_project_wikilink(vault_path, [tag] if tag else [])
                content = upsert_task_links_block(content, linear_item.get("url", ""), project_wikilink)

                if dry_run:
                    print(f"  Would pull new: {linear_id} -> {folder}/{filename}.md")
                    stats["new_in_linear"][folder] += 1
                    continue

                write_vault_file(file_path, content)
                stats["new_in_linear"][folder] += 1
                if verbose:
                    print(f"  Pulled new: {linear_id} -> {folder}/{filename}.md")

    # In dry-run, avoid writing any artifacts to disk (including conflicts log).
    if all_conflicts and not dry_run:
        log_conflicts(all_conflicts, conflicts_path)

    if not dry_run:
        state["last_sync"] = datetime.now(timezone.utc).isoformat()
        for folder in config.get("sync_folders", []):
            for item in read_vault_dir(vault_path, folder):
                lid = item["parsed"]["frontmatter"].get("linear-id")
                if lid:
                    state["items"][lid] = {
                        "vault_file": item["relative_path"],
                        "last_synced": state["last_sync"],
                    }
        save_sync_state(vault_path, state)

    return stats


def print_summary(stats: dict, start_time: float, dry_run: bool = False) -> None:
    elapsed = time.time() - start_time
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    print(f"\nLinear Sync — {now}")
    print()
    pushed_label = "Would push to Linear:" if dry_run else "Pushed to Linear:"
    pulled_label = "Would pull to vault:" if dry_run else "Pulled to vault:"
    new_in_vault_label = "Would create in Linear from vault:" if dry_run else "New in vault:"
    new_in_linear_label = "Would pull new from Linear:" if dry_run else "New in Linear:"

    print(f"{pushed_label:22} {stats['pushed']['tasks']} tasks, {stats['pushed']['projects']} projects")
    print(f"{pulled_label:22} {stats['pulled']['tasks']} tasks, {stats['pulled']['projects']} projects")

    conflicts_line = f"Conflicts detected: {stats['conflicts']}"
    if stats["conflicts"] and not dry_run:
        conflicts_line += " (see .claude/sync-conflicts.json)"
    print(conflicts_line)

    if dry_run:
        print(f"{new_in_vault_label:22} {stats['new_in_vault']['tasks']} tasks, {stats['new_in_vault']['projects']} projects")
        print(f"{new_in_linear_label:22} {stats['new_in_linear']['tasks']} tasks, {stats['new_in_linear']['projects']} projects")
    else:
        print(f"{new_in_vault_label:22} {stats['new_in_vault']['tasks']} tasks, {stats['new_in_vault']['projects']} projects created in Linear")
        print(f"{new_in_linear_label:22} {stats['new_in_linear']['tasks']} tasks, {stats['new_in_linear']['projects']} projects pulled to vault")
    print(f"Skipped:           {stats['skipped']}")
    if stats['errors']:
        print(f"Errors:            {stats['errors']}")
    print(f"\nDone in {elapsed:.1f}s")


def main():
    parser = argparse.ArgumentParser(description="Two-way sync between vault and Linear")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview changes without applying")
    parser.add_argument("--backfill", action="store_true",
                        help="Backfill linear-id fields on existing vault files")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Show detailed output")
    parser.add_argument("--resolve", metavar="FIELD=SOURCE",
                        action="append", default=[],
                        help="Resolve conflicts: FIELD=vault or FIELD=linear "
                             "(e.g., --resolve status=vault --resolve title=linear)")
    parser.add_argument("--vault-path", default=".",
                        help="Path to vault root (default: current directory)")
    args = parser.parse_args()

    config = load_config()
    vault_path = args.vault_path

    try:
        client = LinearClient()
    except LinearAPIError as e:
        print(f"Error: {e}")
        sys.exit(1)

    start_time = time.time()

    if args.backfill:
        print("Backfilling linear-id fields..." + (" (dry run)" if args.dry_run else ""))
        stats = backfill(vault_path, config, client, args.dry_run, args.verbose)
        elapsed = time.time() - start_time
        print(f"\nBackfill complete: {stats['updated']} updated, "
              f"{stats['skipped']} skipped, {stats['errors']} errors "
              f"({elapsed:.1f}s)")
    else:
        if args.dry_run:
            print("Dry run — no changes will be made\n")
        resolve_rules = parse_resolve_rules(args.resolve) if args.resolve else None
        stats = sync(vault_path, config, client, args.dry_run, args.verbose, resolve_rules)
        print_summary(stats, start_time, args.dry_run)


if __name__ == "__main__":
    main()
