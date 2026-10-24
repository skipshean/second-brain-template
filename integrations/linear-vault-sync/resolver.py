"""Conflict resolution and change application logic."""

import json
from datetime import datetime, timezone
from pathlib import Path


def resolve_changes(changes: list) -> tuple[dict, dict]:
    """Split changes into push (vault->Linear) and pull (Linear->vault) dicts."""
    push = {}
    pull = {}
    for change in changes:
        if change["direction"] == "push":
            push[change["field"]] = change["value"]
        elif change["direction"] == "pull":
            pull[change["field"]] = change["value"]
    return push, pull


def log_conflicts(conflicts: list, path: str) -> None:
    """Write conflicts to a JSON file, merging with existing conflicts."""
    existing = {"conflicts": []}
    p = Path(path)
    if p.exists():
        try:
            existing = json.loads(p.read_text())
        except (json.JSONDecodeError, KeyError):
            existing = {"conflicts": []}

    now = datetime.now(timezone.utc).isoformat()
    for conflict in conflicts:
        conflict["detected_at"] = now

    existing["conflicts"].extend(conflicts)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(existing, indent=2) + "\n")


def clear_resolved_conflicts(path: str, resolved_ids: list[str]) -> None:
    """Remove resolved conflicts from the conflicts file."""
    p = Path(path)
    if not p.exists():
        return
    data = json.loads(p.read_text())
    data["conflicts"] = [
        c for c in data.get("conflicts", [])
        if c.get("linear_id") not in resolved_ids
    ]
    p.write_text(json.dumps(data, indent=2) + "\n")
