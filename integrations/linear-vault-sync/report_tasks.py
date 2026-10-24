"""Task delta reporting for Obsidian + optional Linear."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import request

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from linear_api import LinearClient, LinearAPIError


@dataclass
class ReportWindow:
    since: datetime
    until: datetime


def run_git(root: Path, args: list[str]) -> str:
    proc = subprocess.run(
        ["git", "-C", str(root), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"git {' '.join(args)} failed")
    return proc.stdout


def collect_obsidian_delta(root: Path, window: ReportWindow) -> dict:
    since = window.since.isoformat()
    until = window.until.isoformat()
    commits = run_git(
        root,
        [
            "log",
            "--since",
            since,
            "--until",
            until,
            "--grep=cos:",
            "--pretty=%H%x09%s",
        ],
    ).splitlines()

    added: list[str] = []
    edited: list[str] = []
    completed: list[str] = []

    for line in commits:
        if not line.strip():
            continue
        sha, subject = (line.split("\t", 1) + [""])[:2]
        lowered = subject.lower()
        if "new task" in lowered:
            added.append(subject.replace("cos:", "").strip())
        elif "update task" in lowered:
            edited.append(subject.replace("cos:", "").strip())
        elif "complete task" in lowered:
            completed.append(subject.replace("cos:", "").strip())

        patch = run_git(root, ["show", "--name-only", "--pretty=", sha]).splitlines()
        touches_task = any(path.startswith("tasks/") and path.endswith(".md") for path in patch)
        if touches_task and "update task" not in lowered and "new task" not in lowered and "complete task" not in lowered:
            edited.append(subject.replace("cos:", "").strip() or f"commit {sha[:8]}")

    return {
        "added": dedupe_preserve_order(added),
        "edited": dedupe_preserve_order(edited),
        "completed": dedupe_preserve_order(completed),
    }


def collect_linear_delta(window: ReportWindow) -> tuple[dict | None, str | None]:
    try:
        client = LinearClient()
    except LinearAPIError as e:
        return None, str(e)

    try:
        issues = client.get_all_issues()
    except LinearAPIError as e:
        return None, str(e)

    added: list[str] = []
    updated: list[str] = []
    completed: list[str] = []
    for issue in issues:
        created_at = parse_iso(issue.get("createdAt"))
        updated_at = parse_iso(issue.get("updatedAt"))
        state = issue.get("state", {}) or {}
        status_type = (state.get("type") or "").lower()
        identifier = issue.get("identifier", "UNKNOWN")
        title = issue.get("title", "Untitled")
        line = f"{identifier} — {title}"

        if created_at and window.since <= created_at <= window.until:
            added.append(line)
        if updated_at and window.since <= updated_at <= window.until:
            updated.append(line)
        if status_type == "completed" and updated_at and window.since <= updated_at <= window.until:
            completed.append(line)

    return {
        "added": dedupe_preserve_order(added),
        "edited": dedupe_preserve_order(updated),
        "completed": dedupe_preserve_order(completed),
    }, None


def build_report_text(window: ReportWindow, obsidian: dict, linear: dict | None) -> str:
    lines: list[str] = []
    lines.append("*Second Brain Task Report*")
    lines.append(f"Window: {window.since.astimezone().strftime('%Y-%m-%d %H:%M')} to {window.until.astimezone().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")
    lines.extend(format_section("Obsidian", obsidian))
    if linear is not None:
        lines.append("")
        lines.extend(format_section("Linear", linear))
    return "\n".join(lines)


def format_section(name: str, delta: dict) -> list[str]:
    added = delta.get("added", [])
    edited = delta.get("edited", [])
    completed = delta.get("completed", [])
    net = len(added) - len(completed)
    lines = [f"*{name}* — +{len(added)} added, ~{len(edited)} edited, -{len(completed)} completed, net {net:+d}"]
    lines.extend(format_items("Added", added))
    lines.extend(format_items("Edited", edited))
    lines.extend(format_items("Completed", completed))
    return lines


def format_items(label: str, items: list[str], max_items: int = 10) -> list[str]:
    if not items:
        return [f"- {label}: none"]
    out = [f"- {label} ({len(items)}):"]
    for item in items[:max_items]:
        out.append(f"  - {item}")
    if len(items) > max_items:
        out.append(f"  - ...and {len(items) - max_items} more")
    return out


def post_to_slack(webhook: str, text: str, channel: str | None) -> None:
    payload: dict[str, str] = {"text": text}
    if channel:
        payload["channel"] = channel
    req = request.Request(
        webhook,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=20) as response:
        if response.status >= 300:
            raise RuntimeError(f"Slack webhook failed with status {response.status}")


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def dedupe_preserve_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate task delta report and optionally post to Slack.")
    parser.add_argument("--vault-path", default=".", help="Path to vault root")
    parser.add_argument("--hours", type=int, default=24, help="Rolling report window in hours")
    parser.add_argument("--include-linear", action="store_true", help="Include Linear section")
    parser.add_argument("--post-slack", action="store_true", help="Post report to Slack webhook")
    parser.add_argument("--channel", default="", help="Optional Slack channel override")
    parser.add_argument("--webhook-env", default="SLACK_WEBHOOK_URL", help="Webhook env var name")
    parser.add_argument(
        "--mode",
        choices=["daily", "manual"],
        default="manual",
        help="Report type label (daily scheduled or manual on-demand)",
    )
    return parser.parse_args()


def resolve_window(mode: str, hours: int) -> ReportWindow:
    now = datetime.now(timezone.utc)
    if mode == "daily":
        since = now - timedelta(hours=24)
    else:
        since = now - timedelta(hours=max(1, hours))
    return ReportWindow(since=since, until=now)


def main() -> None:
    args = parse_args()
    vault_root = Path(args.vault_path).resolve()
    window = resolve_window(args.mode, args.hours)

    obsidian = collect_obsidian_delta(vault_root, window)
    linear_error: str | None = None
    linear = None
    if args.include_linear:
        linear, linear_error = collect_linear_delta(window)
    report = build_report_text(window, obsidian, linear)
    if args.include_linear and linear_error:
        report = f"{report}\n\n*Linear fetch error:* {linear_error}"

    print(report)

    if args.post_slack:
        webhook = os.environ.get(args.webhook_env, "").strip()
        if not webhook:
            raise RuntimeError(f"Missing Slack webhook in env var: {args.webhook_env}")
        post_to_slack(webhook, report, args.channel.strip() or None)


if __name__ == "__main__":
    main()
