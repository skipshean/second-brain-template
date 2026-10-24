"""Linear GraphQL API client using urllib (no external deps)."""

import json
import os
import re
import time
import urllib.request
import urllib.error

API_URL = "https://api.linear.app/graphql"
MAX_RETRIES = 3
RETRY_BASE_DELAY = 1.0


class LinearAPIError(Exception):
    """Raised when Linear API returns an error."""
    pass


class LinearClient:
    def __init__(self, api_key: str | None = None, api_url: str = API_URL):
        self.api_key = api_key or os.environ.get("LINEAR_API_KEY", "")
        self.api_url = api_url
        if not self.api_key:
            raise LinearAPIError(
                "LINEAR_API_KEY environment variable not set. "
                "Create a key at https://linear.app/settings/api"
            )

    def _request(self, query: str, variables: dict | None = None) -> dict:
        """Execute a GraphQL request with retry logic."""
        payload = json.dumps({"query": query, "variables": variables or {}}).encode()
        headers = {
            "Content-Type": "application/json",
            "Authorization": self.api_key,
        }

        for attempt in range(MAX_RETRIES):
            try:
                req = urllib.request.Request(
                    self.api_url, data=payload, headers=headers, method="POST"
                )
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode())

                if "errors" in data:
                    error_msg = data["errors"][0].get("message", "Unknown error")
                    raise LinearAPIError(f"GraphQL error: {error_msg}")

                return data.get("data", {})

            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < MAX_RETRIES - 1:
                    delay = RETRY_BASE_DELAY * (2 ** attempt)
                    time.sleep(delay)
                    continue
                raise LinearAPIError(f"HTTP {e.code}: {e.reason}")
            except urllib.error.URLError as e:
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_BASE_DELAY)
                    continue
                raise LinearAPIError(f"Network error: {e.reason}")

    def parse_identifier(self, identifier: str) -> dict:
        """Parse 'TRA-125' into {'team_key': 'TRA', 'number': 125}."""
        match = re.match(r"^([A-Z0-9]+)-(\d+)$", identifier)
        if not match:
            return {"team_key": None, "number": None}
        return {"team_key": match.group(1), "number": int(match.group(2))}

    def _build_issues_query(self, team_id: str = None, state_type: str = None,
                            limit: int = 50, cursor: str = None) -> tuple[str, dict]:
        """Build GraphQL query for listing issues."""
        query = """
        query ListIssues($filter: IssueFilter, $first: Int, $after: String) {
            issues(filter: $filter, first: $first, after: $after) {
                nodes {
                    id identifier title description url dueDate
                    updatedAt createdAt priority priorityLabel
                    state { id name type }
                    team { id name key }
                    labels { nodes { id name } }
                    project { id name url }
                }
                pageInfo { hasNextPage endCursor }
            }
        }
        """
        filter_obj = {}
        if team_id:
            filter_obj["team"] = {"id": {"eq": team_id}}
        if state_type:
            filter_obj["state"] = {"type": {"eq": state_type}}

        variables = {
            "filter": filter_obj,
            "first": limit,
        }
        if cursor:
            variables["after"] = cursor
        variables["teamId"] = team_id
        return query, variables

    def _build_update_issue_mutation(self, issue_id: str,
                                     updates: dict) -> tuple[str, dict]:
        """Build GraphQL mutation to update an issue."""
        query = """
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
                success
                issue { id identifier updatedAt }
            }
        }
        """
        variables = {"id": issue_id, "input": updates}
        return query, variables

    def _build_create_issue_mutation(self) -> str:
        """Build GraphQL mutation to create an issue."""
        return """
        mutation CreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
                success
                issue { id identifier url updatedAt title }
            }
        }
        """

    def get_issue_by_identifier(self, identifier: str) -> dict | None:
        """Fetch a single issue by identifier (e.g., TRA-125)."""
        query = """
        query GetIssue($filter: IssueFilter) {
            issues(filter: $filter, first: 1) {
                nodes {
                    id identifier title description url dueDate
                    updatedAt createdAt priority priorityLabel
                    state { id name type }
                    team { id name key }
                    labels { nodes { id name } }
                    project { id name url }
                }
            }
        }
        """
        parsed = self.parse_identifier(identifier)
        if not parsed["team_key"]:
            return None

        variables = {
            "filter": {
                "number": {"eq": parsed["number"]},
                "team": {"key": {"eq": parsed["team_key"]}}
            }
        }
        data = self._request(query, variables)
        nodes = data.get("issues", {}).get("nodes", [])
        return nodes[0] if nodes else None

    def get_all_issues(self, team_id: str = None, state_type: str = None) -> list[dict]:
        """Fetch all issues, paginating automatically."""
        all_issues = []
        cursor = None
        while True:
            query, variables = self._build_issues_query(
                team_id=team_id, state_type=state_type, limit=50, cursor=cursor
            )
            variables.pop("teamId", None)
            data = self._request(query, variables)
            issues = data.get("issues", {})
            all_issues.extend(issues.get("nodes", []))
            page_info = issues.get("pageInfo", {})
            if not page_info.get("hasNextPage"):
                break
            cursor = page_info.get("endCursor")
        return all_issues

    def update_issue(self, issue_id: str, updates: dict) -> dict:
        """Update an issue by UUID."""
        query, variables = self._build_update_issue_mutation(issue_id, updates)
        data = self._request(query, variables)
        return data.get("issueUpdate", {})

    def create_issue(self, team_id: str, title: str,
                     description: str = "", **kwargs) -> dict:
        """Create a new issue in the specified team."""
        mutation = self._build_create_issue_mutation()
        input_data = {"teamId": team_id, "title": title}
        if description:
            input_data["description"] = description
        input_data.update(kwargs)
        data = self._request(mutation, {"input": input_data})
        return data.get("issueCreate", {})

    def get_project_by_slug(self, slug: str) -> dict | None:
        """Fetch a project by its URL slug."""
        query = """
        query ListProjects($filter: ProjectFilter) {
            projects(filter: $filter, first: 50) {
                nodes {
                    id name description url updatedAt
                    status { id name }
                    teams { nodes { id name key } }
                }
            }
        }
        """
        data = self._request(query, {"filter": {}})
        for node in data.get("projects", {}).get("nodes", []):
            url = node.get("url", "")
            if slug in url:
                return node
        return None

    def get_all_projects(self) -> list[dict]:
        """Fetch all projects."""
        query = """
        query ListProjects($first: Int, $after: String) {
            projects(first: $first, after: $after, includeArchived: true) {
                nodes {
                    id name description url updatedAt
                    status { id name }
                    teams { nodes { id name key } }
                }
                pageInfo { hasNextPage endCursor }
            }
        }
        """
        all_projects = []
        cursor = None
        while True:
            variables = {"first": 50}
            if cursor:
                variables["after"] = cursor
            data = self._request(query, variables)
            projects = data.get("projects", {})
            all_projects.extend(projects.get("nodes", []))
            page_info = projects.get("pageInfo", {})
            if not page_info.get("hasNextPage"):
                break
            cursor = page_info.get("endCursor")
        return all_projects

    def get_all_teams_with_projects(self) -> list[dict]:
        """
        Fetch all Linear teams and, for each team, the projects within that team.

        Used by `maintain_mappings.py` to detect renames/moves using stable UUIDs.
        """
        query = """
        query ListTeamsWithProjects {
            teams {
                nodes {
                    id
                    name
                    key
                    projects {
                        nodes {
                            id
                            name
                            url
                        }
                    }
                }
            }
        }
        """
        data = self._request(query, {})
        return data.get("teams", {}).get("nodes", [])

    def get_all_users(self) -> list[dict]:
        """
        Fetch all Linear users.

        This is used to validate whether a vault task owner corresponds to an actual Linear user.
        Returns a list of dicts: {id, name, email?}.

        Note: email may be null/omitted depending on Linear account config/scope.
        """
        query = """
        query ListUsers {
            users {
                nodes {
                    id
                    name
                    email
                }
            }
        }
        """
        data = self._request(query, {})
        return data.get("users", {}).get("nodes", [])

    def update_project(self, project_id: str, updates: dict) -> dict:
        """Update a project by UUID."""
        query = """
        mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
            projectUpdate(id: $id, input: $input) {
                success
                project { id name updatedAt }
            }
        }
        """
        data = self._request(query, {"id": project_id, "input": updates})
        return data.get("projectUpdate", {})

    def get_workflow_states(self, team_id: str) -> list[dict]:
        """Fetch workflow states for a team."""
        query = """
        query GetStates($teamId: String!) {
            workflowStates(filter: { team: { id: { eq: $teamId } } }) {
                nodes { id name type }
            }
        }
        """
        data = self._request(query, {"teamId": team_id})
        return data.get("workflowStates", {}).get("nodes", [])
