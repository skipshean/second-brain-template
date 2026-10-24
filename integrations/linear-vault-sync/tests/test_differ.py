import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from differ import diff_task, DiffResult

def test_no_changes():
    vault = {"status": "in-progress", "due": "2026-03-21", "title": "My Task"}
    linear = {"status": "in-progress", "due": "2026-03-21", "title": "My Task"}
    result = diff_task(vault, linear, vault_mtime=100.0, linear_updated=100.0, last_sync_time=50.0)
    assert result.changes == []

def test_vault_changed_status():
    vault = {"status": "complete", "due": "2026-03-21", "title": "My Task"}
    linear = {"status": "in-progress", "due": "2026-03-21", "title": "My Task"}
    # vault changed after last sync, linear did not
    result = diff_task(vault, linear, vault_mtime=200.0, linear_updated=50.0, last_sync_time=100.0)
    assert len(result.changes) == 1
    assert result.changes[0]["field"] == "status"
    assert result.changes[0]["direction"] == "push"

def test_linear_changed_due():
    vault = {"status": "in-progress", "due": "2026-03-21", "title": "My Task"}
    linear = {"status": "in-progress", "due": "2026-04-01", "title": "My Task"}
    # linear changed after last sync, vault did not
    result = diff_task(vault, linear, vault_mtime=50.0, linear_updated=200.0, last_sync_time=100.0)
    assert len(result.changes) == 1
    assert result.changes[0]["field"] == "due"
    assert result.changes[0]["direction"] == "pull"

def test_conflict_both_changed():
    vault = {"status": "complete", "due": "2026-03-21", "title": "My Task"}
    linear = {"status": "cancelled", "due": "2026-03-21", "title": "My Task"}
    # both changed after last sync
    result = diff_task(vault, linear, vault_mtime=200.0, linear_updated=200.0, last_sync_time=100.0)
    assert len(result.conflicts) == 1
    assert result.conflicts[0]["field"] == "status"

def test_both_changed_same_value():
    vault = {"status": "complete", "due": "2026-03-21", "title": "My Task"}
    linear = {"status": "complete", "due": "2026-03-21", "title": "My Task"}
    result = diff_task(vault, linear, vault_mtime=200.0, linear_updated=200.0, last_sync_time=100.0)
    assert result.changes == []
    assert result.conflicts == []

if __name__ == "__main__":
    test_no_changes()
    test_vault_changed_status()
    test_linear_changed_due()
    test_conflict_both_changed()
    test_both_changed_same_value()
    print("All differ tests passed!")
