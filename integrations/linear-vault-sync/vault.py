"""Read/write vault markdown files with YAML frontmatter."""

import re
import os
from pathlib import Path

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
TITLE_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)
LINEAR_URL_RE = re.compile(r"Linear:\s*(https://linear\.app/[^\s]+)")
ISSUE_ID_RE = re.compile(r"/issue/([A-Z]+-\d+)")
PROJECT_SLUG_RE = re.compile(r"/project/([a-z0-9-]+)$")


def parse_frontmatter_yaml(text: str) -> dict:
    """Simple YAML parser for frontmatter (no external deps)."""
    result = {}
    for line in text.strip().split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ": " not in line and not line.endswith(":"):
            continue
        key, _, value = line.partition(": ")
        key = key.strip()
        value = value.strip()

        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            if inner:
                result[key] = [v.strip().strip("'\"") for v in inner.split(",")]
            else:
                result[key] = []
        elif value.lower() in ("true", "false"):
            result[key] = value.lower() == "true"
        elif value.lower() in ("null", "~", ""):
            result[key] = None
        elif (value.startswith('"') and value.endswith('"')) or \
             (value.startswith("'") and value.endswith("'")):
            result[key] = value[1:-1]
        elif re.match(r"^-?\d+$", value):
            result[key] = int(value)
        elif re.match(r"^-?\d+\.\d+$", value):
            result[key] = float(value)
        else:
            result[key] = value
    return result


def serialize_frontmatter(data: dict) -> str:
    """Convert dict back to YAML frontmatter string."""
    lines = []
    for key, value in data.items():
        if value is None:
            continue
        elif isinstance(value, list):
            items = ", ".join(str(v) for v in value)
            lines.append(f"{key}: [{items}]")
        elif isinstance(value, bool):
            lines.append(f"{key}: {'true' if value else 'false'}")
        else:
            lines.append(f"{key}: {value}")
    return "\n".join(lines)


def parse_vault_file(content: str) -> dict:
    """Parse a vault markdown file into structured data."""
    result = {"frontmatter": {}, "title": "", "body": "", "raw": content}

    fm_match = FRONTMATTER_RE.match(content)
    if fm_match:
        result["frontmatter"] = parse_frontmatter_yaml(fm_match.group(1))
        rest = content[fm_match.end():]
    else:
        rest = content

    title_match = TITLE_RE.search(rest)
    if title_match:
        result["title"] = title_match.group(1).strip()
        body_start = title_match.end()
        result["body"] = rest[body_start:].strip()
    else:
        result["body"] = rest.strip()

    return result


def update_vault_file(content: str, updates: dict) -> str:
    """Update frontmatter fields and/or title in a vault file."""
    parsed = parse_vault_file(content)

    if "frontmatter" in updates:
        parsed["frontmatter"].update(updates["frontmatter"])
    if "title" in updates:
        parsed["title"] = updates["title"]
    if "body" in updates:
        parsed["body"] = updates["body"]

    fm_str = serialize_frontmatter(parsed["frontmatter"])
    parts = [f"---\n{fm_str}\n---\n"]
    if parsed["title"]:
        parts.append(f"\n# {parsed['title']}\n")
    if parsed["body"]:
        parts.append(f"\n{parsed['body']}\n")

    return "".join(parts)


def extract_linear_url(body: str) -> str | None:
    """Extract Linear URL from the Notes section of a vault file body."""
    match = LINEAR_URL_RE.search(body)
    return match.group(1) if match else None


def extract_linear_id_from_url(url: str) -> str | None:
    """Extract Linear issue identifier or project slug from a Linear URL."""
    issue_match = ISSUE_ID_RE.search(url)
    if issue_match:
        return issue_match.group(1)

    project_match = PROJECT_SLUG_RE.search(url)
    if project_match:
        return project_match.group(1)

    return None


def read_vault_dir(vault_path: str, folder: str) -> list[dict]:
    """Read all .md files in a vault folder (recursive)."""
    folder_path = Path(vault_path) / folder
    if not folder_path.exists():
        return []

    items = []
    vault_root = Path(vault_path)
    for f in sorted(folder_path.rglob("*.md")):
        if f.is_dir():
            continue
        content = f.read_text(encoding="utf-8")
        parsed = parse_vault_file(content)
        items.append({
            "path": str(f),
            "relative_path": str(f.relative_to(vault_root)),
            "filename": f.stem,
            "content": content,
            "parsed": parsed,
            "mtime": f.stat().st_mtime,
        })
    return items


def write_vault_file(path: str, content: str) -> None:
    """Write content to a vault file, creating parent dirs if needed."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
