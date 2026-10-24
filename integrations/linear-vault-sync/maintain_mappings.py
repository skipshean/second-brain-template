"""
Linear catalog reconciliation for keeping Second Brain mappings correct.

What this does (apply mode):
1) Polls Linear teams/projects and snapshots them locally (for rename/move detection).
2) Computes alias mappings for:
   - team name -> canonical team name
   - team tag (vault tags[0] format) -> canonical team tag
   - project title -> canonical project title
   - project slug (linear-id) -> canonical project slug
3) Rewrites vault files so downstream exact-name matching keeps working:
   - `integrations/linear-vault-sync/config.json` team_mapping keys updated to canonical tags
   - `projects/*.md`: # title, frontmatter `linear-id`, `tags[0]`, and `- Team:` line updated
   - `tasks/**/*.md`: frontmatter tags updated via team tag alias mapping
   - `people/*.md`: replaces old project titles with canonical ones and appends `projects:` frontmatter list

Dry-run mode:
- Performs the same diffing and produces a JSON report, but does not write files.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from linear_api import LinearClient
from vault import FRONTMATTER_RE, parse_frontmatter_yaml, serialize_frontmatter, extract_linear_id_from_url


SNAPSHOT_PATH = Path(".claude/linear-catalog-snapshot.json")
ALIAS_PATH = Path(".claude/linear-aliases.json")


def slugify_team_tag(value: str) -> str:
    """
    Matches the tag-style already used in this vault (lowercase + hyphens).
    Example: "Delta Corp" -> "delta-corp"
    """
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def load_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def update_frontmatter(content: str, updates: dict[str, Any]) -> str:
    """
    Replace the entire frontmatter block with updated values.
    We preserve non-updated keys.
    """
    m = FRONTMATTER_RE.match(content)
    if not m:
        return content

    current_yaml = m.group(1)
    current = parse_frontmatter_yaml(current_yaml)
    for k, v in updates.items():
        current[k] = v

    fm_str = serialize_frontmatter(current)
    return content[: m.start()] + f"---\n{fm_str}\n---\n" + content[m.end() :]


def replace_first_title(content: str, new_title: str) -> str:
    # First H1 line after frontmatter is the vault title.
    return re.sub(r"^#\s+.+$", f"# {new_title}", content, count=1, flags=re.MULTILINE)


def replace_team_line_first_token(content: str, new_team_name: str) -> str:
    """
    Rewrites the `- Team:` line by replacing the first token before a comma.
    Example: "- Team: Zeta Health, my-company" -> "- Team: New Team, my-company"
    """
    pattern = re.compile(r"^(-?\s*Team:\s*)([^,\n]+)(,.*)?$", flags=re.IGNORECASE | re.MULTILINE)

    def _repl(match: re.Match[str]) -> str:
        prefix = match.group(1)
        suffix = match.group(3) or ""
        return f"{prefix}{new_team_name}{suffix}"

    return pattern.sub(_repl, content, count=1)


def get_frontmatter_dict(path: Path) -> dict[str, Any] | None:
    content = read_text(path)
    m = FRONTMATTER_RE.match(content)
    if not m:
        return None
    return parse_frontmatter_yaml(m.group(1))


@dataclass(frozen=True)
class LinearTeamRecord:
    id: str
    name: str
    key: str
    tag: str  # vault tags[0]-style key


@dataclass(frozen=True)
class LinearProjectRecord:
    id: str
    name: str
    slug: str  # linear-id stored in project frontmatter
    team_id: str
    team_name: str
    team_tag: str


def build_linear_catalog(client: LinearClient) -> tuple[dict[str, LinearTeamRecord], dict[str, LinearProjectRecord]]:
    """
    Fetch all teams + each team's projects and build local UUID-indexed maps.
    """
    teams_raw = client.get_all_teams_with_projects()

    teams_by_id: dict[str, LinearTeamRecord] = {}
    projects_by_id: dict[str, LinearProjectRecord] = {}

    for t in teams_raw:
        team_id = t["id"]
        team_name = t.get("name", "")
        team_key = t.get("key", "")
        team_tag = slugify_team_tag(team_name)
        teams_by_id[team_id] = LinearTeamRecord(id=team_id, name=team_name, key=team_key, tag=team_tag)

        for p in t.get("projects", {}).get("nodes", []) or []:
            project_id = p["id"]
            project_name = p.get("name", "")
            url = p.get("url", "") or ""
            slug = extract_linear_id_from_url(url) or ""

            # Some GraphQL payloads might omit url; in that case we can't rewrite linear-id yet.
            if not slug:
                continue

            projects_by_id[project_id] = LinearProjectRecord(
                id=project_id,
                name=project_name,
                slug=slug,
                team_id=team_id,
                team_name=team_name,
                team_tag=team_tag,
            )

    return teams_by_id, projects_by_id


def compute_aliases(
    prev: dict[str, Any] | None,
    prev_teams: dict[str, LinearTeamRecord],
    prev_projects: dict[str, LinearProjectRecord],
    curr_teams: dict[str, LinearTeamRecord],
    curr_projects: dict[str, LinearProjectRecord],
) -> dict[str, Any]:
    """
    Build alias maps from rename/move diffs detected via stable UUIDs.
    """
    team_name_aliases: dict[str, str] = {}
    team_tag_aliases: dict[str, str] = {}
    project_title_aliases: dict[str, str] = {}
    project_slug_aliases: dict[str, str] = {}

    # Team renames
    for team_id, curr in curr_teams.items():
        prev_team = prev_teams.get(team_id)
        if not prev_team:
            continue
        if prev_team.name.lower() != curr.name.lower():
            team_name_aliases[prev_team.name.lower()] = curr.name
        if prev_team.tag.lower() != curr.tag.lower():
            team_tag_aliases[prev_team.tag.lower()] = curr.tag

    # Project renames/moves/slug changes
    for project_id, curr in curr_projects.items():
        prev_proj = prev_projects.get(project_id)
        if not prev_proj:
            continue
        if prev_proj.name.lower() != curr.name.lower():
            project_title_aliases[prev_proj.name.lower()] = curr.name
        if prev_proj.slug.lower() != curr.slug.lower():
            project_slug_aliases[prev_proj.slug.lower()] = curr.slug

    # Capture moves so we can rewrite `- Team:` for projects even when title/slug don't change.
    moved_project_ids: list[str] = []
    for project_id, curr in curr_projects.items():
        prev_proj = prev_projects.get(project_id)
        if not prev_proj:
            continue
        if prev_proj.team_id != curr.team_id:
            moved_project_ids.append(project_id)

    return {
        "generatedAt": None,  # filled by caller
        "teamNameAliases": team_name_aliases,
        "teamTagAliases": team_tag_aliases,
        "projectTitleAliases": project_title_aliases,
        "projectSlugAliases": project_slug_aliases,
        "movedProjectIds": moved_project_ids,
    }


def resolve_canonical_project_for_file(
    project_content: str,
    project_path: Path,
    curr_projects_by_slug: dict[str, LinearProjectRecord],
    curr_projects_by_title: dict[str, LinearProjectRecord],
    alias_slug_to_new: dict[str, str],
    alias_title_to_new: dict[str, str],
) -> LinearProjectRecord | None:
    fm = get_frontmatter_dict(project_path) or {}
    old_slug = str(fm.get("linear-id") or "").strip()
    if old_slug:
        old_slug_lower = old_slug.lower()
        if old_slug_lower in alias_slug_to_new:
            new_slug = alias_slug_to_new[old_slug_lower]
            return curr_projects_by_slug.get(new_slug.lower())
        return curr_projects_by_slug.get(old_slug_lower)

    # Fallback: title match / title alias
    title_match = re.search(r"^#\s+(.+)\s*$", project_content, flags=re.MULTILINE)
    if title_match:
        old_title = title_match.group(1).strip()
        old_title_lower = old_title.lower()
        if old_title_lower in alias_title_to_new:
            new_title = alias_title_to_new[old_title_lower]
            return curr_projects_by_title.get(new_title.lower())
        return curr_projects_by_title.get(old_title_lower)

    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Maintain Linear team/project mapping aliases and rewrite vault files.")
    parser.add_argument("--dry-run", action="store_true", help="Report changes without writing any files.")
    parser.add_argument("--vault-path", default=".", help="Path to vault root (default: current directory)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose report output.")
    args = parser.parse_args()

    vault_path = Path(args.vault_path).resolve()
    if (vault_path / "integrations/linear-vault-sync/").exists():
        # ok; validate root
        pass

    client = LinearClient()
    curr_teams, curr_projects = build_linear_catalog(client)

    prev_snapshot = load_json_if_exists(vault_path / SNAPSHOT_PATH)
    prev_teams: dict[str, LinearTeamRecord] = {}
    prev_projects: dict[str, LinearProjectRecord] = {}

    if prev_snapshot:
        for team_id, t in (prev_snapshot.get("teamsById") or {}).items():
            prev_teams[team_id] = LinearTeamRecord(
                id=t["id"],
                name=t["name"],
                key=t.get("key", ""),
                tag=t.get("tag", slugify_team_tag(t["name"])),
            )
        for project_id, p in (prev_snapshot.get("projectsById") or {}).items():
            prev_projects[project_id] = LinearProjectRecord(
                id=p["id"],
                name=p["name"],
                slug=p["slug"],
                team_id=p["team_id"],
                team_name=p["team_name"],
                team_tag=p["team_tag"],
            )

    report: dict[str, Any] = {
        "dryRun": args.dry_run,
        "generatedAt": None,
        "aliases": None,
        "changes": [],
    }

    # If there's no previous snapshot, establish baseline and exit early.
    if not prev_snapshot:
        now_iso = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
        report["generatedAt"] = now_iso
        report["aliases"] = {
            "note": "No previous snapshot found; this run establishes a baseline. Next run will detect renames/moves/removals.",
            "teamNameAliases": {},
            "teamTagAliases": {},
            "projectTitleAliases": {},
            "projectSlugAliases": {},
        }

        if not args.dry_run:
            write_json(
                vault_path / SNAPSHOT_PATH,
                {
                    "generatedAt": now_iso,
                    "teamsById": {tid: t.__dict__ for tid, t in curr_teams.items()},
                    "projectsById": {pid: p.__dict__ for pid, p in curr_projects.items()},
                },
            )
        print(json.dumps(report, indent=2))
        return

    alias_maps = compute_aliases(
        prev_snapshot,
        prev_teams=prev_teams,
        prev_projects=prev_projects,
        curr_teams=curr_teams,
        curr_projects=curr_projects,
    )

    now_iso = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    alias_maps["generatedAt"] = now_iso

    team_name_aliases = {k.lower(): v for k, v in alias_maps["teamNameAliases"].items()}
    team_tag_aliases = {k.lower(): v for k, v in alias_maps["teamTagAliases"].items()}
    project_title_aliases = {k.lower(): v for k, v in alias_maps["projectTitleAliases"].items()}
    project_slug_aliases = {k.lower(): v for k, v in alias_maps["projectSlugAliases"].items()}

    report["generatedAt"] = now_iso
    report["aliases"] = {
        "teamNameAliases": team_name_aliases,
        "teamTagAliases": team_tag_aliases,
        "projectTitleAliases": project_title_aliases,
        "projectSlugAliases": project_slug_aliases,
        "movedProjectIdsCount": len(alias_maps["movedProjectIds"]),
    }

    # Build lookup maps for canonical resolution.
    curr_projects_by_slug: dict[str, LinearProjectRecord] = {p.slug.lower(): p for p in curr_projects.values()}
    curr_projects_by_title: dict[str, LinearProjectRecord] = {p.name.lower(): p for p in curr_projects.values()}

    # Rewrite integrations/linear-vault-sync/config.json team mapping
    config_path = vault_path / "integrations/linear-vault-sync/config.json"
    config_before = json.loads(read_text(config_path))
    config_after = json.loads(read_text(config_path))

    team_mapping: dict[str, Any] = config_after.get("team_mapping") or {}

    # Ensure canonical team tag exists and points at the correct ids/keys.
    for team_id, t in curr_teams.items():
        team_mapping[t.tag] = {"id": t.id, "key": t.key}

    # Also ensure alias tags point to the correct canonical team.
    for alias_tag_lower, canonical_tag in team_tag_aliases.items():
        # Find the canonical team record by tag
        canon_team = next((tt for tt in curr_teams.values() if tt.tag.lower() == canonical_tag.lower()), None)
        if canon_team:
            team_mapping[alias_tag_lower] = {"id": canon_team.id, "key": canon_team.key}

    config_after["team_mapping"] = team_mapping

    if config_after != config_before:
        report["changes"].append(
            {
                "path": str(config_path),
                "kind": "config-team-mapping",
                "modified": True,
            }
        )
        if not args.dry_run:
            write_text(config_path, json.dumps(config_after, indent=2) + "\n")

    # Rewrite projects/
    projects_dir = vault_path / "projects"
    for proj_path in sorted(projects_dir.glob("*.md")):
        content = read_text(proj_path)
        if "type: project" not in content:
            continue

        # Determine canonical project record for this file.
        canonical_proj = resolve_canonical_project_for_file(
            project_content=content,
            project_path=proj_path,
            curr_projects_by_slug=curr_projects_by_slug,
            curr_projects_by_title=curr_projects_by_title,
            alias_slug_to_new=project_slug_aliases,
            alias_title_to_new=project_title_aliases,
        )
        if not canonical_proj:
            continue

        updates: dict[str, Any] = {}
        fm = get_frontmatter_dict(proj_path) or {}

        # Update title if it's an alias.
        # (We only update when we actually resolved a canonical project record.)
        new_title = canonical_proj.name

        # Update frontmatter linear-id if slug aliases indicate change OR if moved (team/tag).
        old_slug = str(fm.get("linear-id") or "").strip()
        if old_slug and old_slug.lower() in project_slug_aliases:
            updates["linear-id"] = project_slug_aliases[old_slug.lower()]
        elif not old_slug:
            updates["linear-id"] = canonical_proj.slug

        # Update tags[0] to canonical team tag.
        tags = fm.get("tags") or []
        if isinstance(tags, list) and tags:
            # sync.py uses tags[0] for team mapping; keep other tags intact.
            tags0_lower = str(tags[0]).lower()
            canonical_tag = canonical_proj.team_tag
            if tags0_lower in team_tag_aliases:
                tags[0] = team_tag_aliases[tags0_lower]
            else:
                tags[0] = canonical_tag
            updates["tags"] = tags

        # Apply file changes.
        changed = False
        next_content = content

        if updates:
            next_content = update_frontmatter(next_content, updates)
            changed = changed or (next_content != content)

        if new_title:
            next_content = replace_first_title(next_content, new_title)
            changed = changed or (next_content != content)

        # Update the `- Team:` line even if only a move happened.
        next_content = replace_team_line_first_token(next_content, canonical_proj.team_name)
        changed = changed or (next_content != content)

        if changed:
            report["changes"].append({"path": str(proj_path), "kind": "project-rewrite", "modified": True})
            if not args.dry_run:
                write_text(proj_path, next_content)

    # Rewrite tasks/
    tasks_dir = vault_path / "tasks"
    for task_path in sorted(tasks_dir.rglob("*.md")):
        content = read_text(task_path)
        if "type: task" not in content:
            continue

        fm = get_frontmatter_dict(task_path) or {}
        tags = fm.get("tags") or []
        if not (isinstance(tags, list) and len(tags) > 0):
            continue

        tags0_lower = str(tags[0]).lower()
        if tags0_lower in team_tag_aliases:
            new_tags0 = team_tag_aliases[tags0_lower]
            updates = {"tags": [new_tags0] + tags[1:]}
            next_content = update_frontmatter(content, updates)
            if next_content != content:
                report["changes"].append({"path": str(task_path), "kind": "task-tag-rewrite", "modified": True})
                if not args.dry_run:
                    write_text(task_path, next_content)

    # Rewrite people/ (replace old project titles; append `projects:` list)
    people_dir = vault_path / "people"
    project_aliases_by_lower = project_title_aliases
    for person_path in sorted(people_dir.glob("*.md")):
        content = read_text(person_path)
        if "type: person" not in content:
            continue

        changed = False

        # Replace body occurrences of old project titles.
        next_content = content
        for old_title_lower, new_title in project_aliases_by_lower.items():
            # Use case-insensitive regex replace.
            old_title = None
            # Reconstruct the exact old string is hard; we replace by lowercase-insensitive pattern on any word boundary-ish.
            # This is intentionally conservative; we replace escaped literal occurrences.
            # We'll derive the pattern by using the canonical map key in lowercase, but it might have different casing.
            # Since we just need correctness over formatting, we build a case-insensitive pattern from the old_title_lower.
            # (Linear titles are typically stable casing anyway.)
            pattern = re.compile(re.escape(old_title_lower), flags=re.IGNORECASE)
            next_content2 = pattern.sub(new_title, next_content)
            if next_content2 != next_content:
                next_content = next_content2
                changed = True

        # Append projects in frontmatter if the content contains any alias titles.
        fm = get_frontmatter_dict(person_path) or {}
        existing_projects = fm.get("projects") or []
        if not isinstance(existing_projects, list):
            existing_projects = [existing_projects]

        to_add: set[str] = set()
        body_lower = next_content.lower()
        for old_title_lower, new_title in project_aliases_by_lower.items():
            if old_title_lower in body_lower:
                to_add.add(new_title)

        if to_add:
            merged = list({str(p).strip(): None for p in (existing_projects + list(to_add))}.keys())
            updates = {"projects": merged}
            next_content2 = update_frontmatter(next_content, updates)
            if next_content2 != next_content:
                next_content = next_content2
                changed = True

        if changed:
            report["changes"].append({"path": str(person_path), "kind": "people-projects-update", "modified": True})
            if not args.dry_run:
                write_text(person_path, next_content)

    # Write alias + snapshot state
    if not args.dry_run:
        write_json(
            vault_path / SNAPSHOT_PATH,
            {
                "generatedAt": now_iso,
                "teamsById": {tid: t.__dict__ for tid, t in curr_teams.items()},
                "projectsById": {pid: p.__dict__ for pid, p in curr_projects.items()},
            },
        )
        write_json(
            vault_path / ALIAS_PATH,
            {
                "generatedAt": now_iso,
                "teamNameAliases": team_name_aliases,
                "teamTagAliases": team_tag_aliases,
                "projectTitleAliases": project_title_aliases,
                "projectSlugAliases": project_slug_aliases,
            },
        )

    if args.verbose:
        report["aliases"] = report.get("aliases", {})

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

