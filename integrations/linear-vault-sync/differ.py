"""Compare vault and Linear item snapshots to produce change sets."""

from dataclasses import dataclass, field

SYNC_FIELDS = ["status", "due", "title", "description"]


@dataclass
class DiffResult:
    """Result of comparing a vault item with its Linear counterpart."""
    changes: list = field(default_factory=list)
    conflicts: list = field(default_factory=list)


def diff_task(vault_fields: dict, linear_fields: dict,
              vault_mtime: float, linear_updated: float,
              last_sync_time: float = 0.0) -> DiffResult:
    """Compare vault and Linear representations of the same item."""
    result = DiffResult()

    for field_name in SYNC_FIELDS:
        vault_val = vault_fields.get(field_name)
        linear_val = linear_fields.get(field_name)

        if vault_val is None and linear_val is None:
            continue

        v_str = str(vault_val) if vault_val is not None else ""
        l_str = str(linear_val) if linear_val is not None else ""

        if v_str == l_str:
            continue

        vault_changed = vault_mtime > last_sync_time
        linear_changed = linear_updated > last_sync_time

        if vault_changed and linear_changed:
            result.conflicts.append({
                "field": field_name,
                "vault_value": vault_val,
                "linear_value": linear_val,
            })
        elif vault_changed:
            result.changes.append({
                "field": field_name,
                "direction": "push",
                "value": vault_val,
            })
        elif linear_changed:
            result.changes.append({
                "field": field_name,
                "direction": "pull",
                "value": linear_val,
            })
        else:
            result.changes.append({
                "field": field_name,
                "direction": "pull",
                "value": linear_val,
            })

    return result
