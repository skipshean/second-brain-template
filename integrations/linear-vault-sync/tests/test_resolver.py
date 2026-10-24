import sys, os, json, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from resolver import resolve_changes, log_conflicts

def test_resolve_push_changes():
    changes = [
        {"field": "status", "direction": "push", "value": "complete"},
        {"field": "due", "direction": "push", "value": "2026-04-01"},
    ]
    push, pull = resolve_changes(changes)
    assert push == {"status": "complete", "due": "2026-04-01"}
    assert pull == {}

def test_resolve_pull_changes():
    changes = [
        {"field": "title", "direction": "pull", "value": "New Title"},
    ]
    push, pull = resolve_changes(changes)
    assert push == {}
    assert pull == {"title": "New Title"}

def test_resolve_mixed():
    changes = [
        {"field": "status", "direction": "push", "value": "complete"},
        {"field": "due", "direction": "pull", "value": "2026-05-01"},
    ]
    push, pull = resolve_changes(changes)
    assert push == {"status": "complete"}
    assert pull == {"due": "2026-05-01"}

def test_log_conflicts():
    conflicts = [
        {
            "file": "tasks/test.md",
            "linear_id": "TRA-1",
            "field": "status",
            "vault_value": "complete",
            "linear_value": "in-progress",
        }
    ]
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        path = f.name
    log_conflicts(conflicts, path)
    with open(path) as f:
        data = json.load(f)
    assert len(data["conflicts"]) == 1
    assert data["conflicts"][0]["field"] == "status"
    os.unlink(path)

if __name__ == "__main__":
    test_resolve_push_changes()
    test_resolve_pull_changes()
    test_resolve_mixed()
    test_log_conflicts()
    print("All resolver tests passed!")
