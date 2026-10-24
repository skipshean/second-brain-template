import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from vault import parse_vault_file, extract_linear_url, extract_linear_id_from_url, update_vault_file

def test_parse_task_frontmatter():
    content = """---
type: task
status: in-progress
due: 2026-03-21
tags: [delta-corp]
created: 2026-03-17T00:00:00
linear-id: TRA-125
linear-updated: 2026-03-17T14:30:00Z
---

# Provide Sam Taylor a Delta Corp login

Description here.

## Notes
- Linear: https://linear.app/your-workspace/issue/TRA-125
- Priority: High
"""
    result = parse_vault_file(content)
    assert result["frontmatter"]["type"] == "task"
    assert result["frontmatter"]["status"] == "in-progress"
    assert result["frontmatter"]["due"] == "2026-03-21"
    assert result["frontmatter"]["tags"] == ["delta-corp"]
    assert result["frontmatter"]["linear-id"] == "TRA-125"
    assert result["title"] == "Provide Sam Taylor a Delta Corp login"
    assert "Description here." in result["body"]

def test_parse_project_frontmatter():
    content = """---
type: project
status: active
tags: [delta-corp]
created: 2026-03-17
---

# Delta Corp

Marketing and operational improvements.

## Next Action
Review in Linear.

## Notes
- Linear: https://linear.app/your-workspace/project/delta-corp-348176e11b53
"""
    result = parse_vault_file(content)
    assert result["frontmatter"]["type"] == "project"
    assert result["frontmatter"]["status"] == "active"
    assert result["title"] == "Delta Corp"
    assert "## Next Action" in result["body"]

def test_extract_linear_url():
    body = "## Notes\n- Linear: https://linear.app/your-workspace/issue/TRA-125\n- Priority: High"
    assert extract_linear_url(body) == "https://linear.app/your-workspace/issue/TRA-125"

def test_extract_linear_url_project():
    body = "## Notes\n- Linear: https://linear.app/your-workspace/project/delta-corp-348176e11b53"
    assert extract_linear_url(body) == "https://linear.app/your-workspace/project/delta-corp-348176e11b53"

def test_extract_linear_id_from_url():
    assert extract_linear_id_from_url("https://linear.app/your-workspace/issue/TRA-125") == "TRA-125"
    assert extract_linear_id_from_url("https://linear.app/your-workspace/issue/TRA-125/some-slug") == "TRA-125"

def test_extract_linear_id_from_project_url():
    assert extract_linear_id_from_url("https://linear.app/your-workspace/project/delta-corp-348176e11b53") == "delta-corp-348176e11b53"

def test_update_frontmatter_adds_linear_id():
    content = """---
type: task
status: in-progress
due: 2026-03-21
tags: [delta-corp]
created: 2026-03-17T00:00:00
---

# My Task Title

Description.

## Notes
- Linear: https://linear.app/your-workspace/issue/TRA-125
"""
    updated = update_vault_file(content, {
        "frontmatter": {
            "linear-id": "TRA-125",
            "linear-updated": "2026-03-17T14:30:00Z"
        }
    })
    parsed = parse_vault_file(updated)
    assert parsed["frontmatter"]["linear-id"] == "TRA-125"
    assert parsed["frontmatter"]["linear-updated"] == "2026-03-17T14:30:00Z"
    assert parsed["frontmatter"]["status"] == "in-progress"
    assert parsed["title"] == "My Task Title"

def test_update_preserves_body():
    content = """---
type: task
status: pending
tags: [my-company]
---

# Some Task

Body content here.

## Notes
- Important stuff
"""
    updated = update_vault_file(content, {
        "frontmatter": {"status": "in-progress"}
    })
    assert "Body content here." in updated
    assert "Important stuff" in updated

if __name__ == "__main__":
    test_parse_task_frontmatter()
    test_parse_project_frontmatter()
    test_extract_linear_url()
    test_extract_linear_url_project()
    test_extract_linear_id_from_url()
    test_extract_linear_id_from_project_url()
    test_update_frontmatter_adds_linear_id()
    test_update_preserves_body()
    print("All vault parser tests passed!")
