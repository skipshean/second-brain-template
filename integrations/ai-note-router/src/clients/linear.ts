import type { LinearIssueCandidate } from "../resolve/dedupe.js";
import type { CanonicalNote } from "../normalize/note.js";
import { scoreLinearCandidate } from "../resolve/dedupe.js";
import { retryAsync } from "../runtime/retry.js";
import { isRateLimitError, parseRateLimitResetHeader } from "../worker/failure-policy.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

type TeamNode = {
  id: string;
  name: string;
  retiredAt?: string | null;
  projects: {
    nodes: Array<{
      id: string;
      name: string;
    }>;
  };
};

type TeamWithProjects = {
  id: string;
  name: string;
  retiredAt?: string | null;
  projects: Array<{
    id: string;
    name: string;
  }>;
};

type PersonNode = {
  id: string;
  name: string;
  email?: string;
};

type LabelNode = {
  id: string;
  name: string;
};

type TeamListNode = {
  id: string;
  name: string;
};

export type LinearUnassignedIssue = {
  id: string;
  title: string;
  description?: string;
  identifier: string;
  updatedAt: string;
  stateType: string;
  teamName?: string;
  projectName?: string;
  projectId?: string;
  assigneeNames: string[];
  creatorName?: string;
};

export class LinearClient {
  constructor(private readonly apiKey: string) {}

  private static aliasCache: {
    teamNameAliases?: Record<string, string>;
    projectTitleAliases?: Record<string, string>;
  } | null = null;

  private static loadAliases(): {
    teamNameAliases?: Record<string, string>;
    projectTitleAliases?: Record<string, string>;
  } | null {
    if (LinearClient.aliasCache) return LinearClient.aliasCache;

    const aliasPath = join(process.cwd(), ".claude/linear-aliases.json");
    const newAliasPath = join(process.cwd(), "integrations/linear-vault-sync/router-index/aliases.json");
    const path = existsSync(newAliasPath) ? newAliasPath : aliasPath;
    if (!existsSync(path)) {
      LinearClient.aliasCache = {};
      return LinearClient.aliasCache;
    }

    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as {
        teamNameAliases?: Record<string, string>;
        projectTitleAliases?: Record<string, string>;
        projectNameAliases?: Record<string, string>;
      };
      LinearClient.aliasCache = {
        teamNameAliases: parsed.teamNameAliases ?? {},
        projectTitleAliases: parsed.projectTitleAliases ?? parsed.projectNameAliases ?? {},
      };
      return LinearClient.aliasCache;
    } catch {
      LinearClient.aliasCache = {};
      return LinearClient.aliasCache;
    }
  }

  /** Verify the API key can reach Linear; returns true on success. */
  async ping(): Promise<boolean> {
    const data = await this.graphql<{ viewer: { id: string } }>(
      "query { viewer { id } }"
    );
    return Boolean(data?.viewer?.id);
  }

  async getViewerId(): Promise<string> {
    const data = await this.graphql<{ viewer: { id: string } }>(
      "query { viewer { id } }"
    );
    const id = data?.viewer?.id;
    if (!id) throw new Error("Linear viewer.id not found.");
    return id;
  }

  async resolveTargetIds(teamName: string | null, projectName: string | null): Promise<{ teamId: string | null; projectId: string | null }> {
    return this.resolveTeamAndProjectIds(teamName, projectName);
  }

  async searchOpenIssueCandidates(teamName: string | null, projectName: string | null, note: CanonicalNote): Promise<LinearIssueCandidate[]> {
    const scoped = await this.searchScopedOpenIssueCandidates(teamName, projectName, note);
    if (scoped.length > 0) {
      return scoped;
    }

    return this.searchAllOpenIssueCandidates(note);
  }

  async createIssue(input: {
    teamId: string;
    projectId: string | null;
    title: string;
    description: string;
  }): Promise<{ id: string; identifier: string; url?: string }> {
    const todoStateId = await this.getTodoStateId(input.teamId);
    const data = await this.graphql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url?: string } } }>(
      `
      mutation($teamId: String!, $projectId: String, $title: String!, $description: String!, $stateId: String!) {
        issueCreate(input: {
          teamId: $teamId
          projectId: $projectId
          title: $title
          description: $description
          stateId: $stateId
        }) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
      `,
      {
        teamId: input.teamId,
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        stateId: todoStateId,
      }
    );

    return data.issueCreate.issue;
  }

  async updateIssue(input: {
    issueId: string;
    title: string;
    description: string;
  }): Promise<{ id: string; identifier: string; url?: string }> {
    const data = await this.graphql<{ issueUpdate: { success: boolean; issue: { id: string; identifier: string; url?: string } } }>(
      `
      mutation($id: String!, $title: String!, $description: String!) {
        issueUpdate(id: $id, input: {
          title: $title
          description: $description
        }) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
      `,
      {
        id: input.issueId,
        title: input.title,
        description: input.description,
      }
    );

    return data.issueUpdate.issue;
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.graphql<{ commentCreate: { success: boolean } }>(
      `
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: {
          issueId: $issueId
          body: $body
        }) {
          success
        }
      }
      `,
      { issueId, body }
    );
  }

  async listTeamLabels(teamId: string): Promise<LabelNode[]> {
    const data = await this.graphql<{ team: { labels: { nodes: LabelNode[] } } }>(
      `
      query($teamId: String!) {
        team(id: $teamId) {
          labels {
            nodes {
              id
              name
            }
          }
        }
      }
      `,
      { teamId }
    );

    return data.team.labels.nodes;
  }

  async listTeams(): Promise<TeamListNode[]> {
    const data = await this.graphql<{ teams: { nodes: TeamListNode[] } }>(
      `
      query {
        teams {
          nodes {
            id
            name
          }
        }
      }
      `
    );

    return data.teams.nodes;
  }

  async listTeamsWithProjects(): Promise<TeamWithProjects[]> {
    const data = await this.graphql<{ teams: { nodes: TeamNode[] } }>(
      `
      query {
        teams {
          nodes {
            id
            name
            retiredAt
            projects {
              nodes {
                id
                name
              }
            }
          }
        }
      }
      `
    );

    return data.teams.nodes.map((team) => ({
      id: team.id,
      name: team.name,
      retiredAt: team.retiredAt ?? null,
      projects: team.projects.nodes,
    }));
  }

  async createIssueLabel(input: { teamId: string; name: string }): Promise<LabelNode> {
    const data = await this.graphql<{
      issueLabelCreate: {
        success: boolean;
        issueLabel: { id: string; name: string } | null;
      };
    }>(
      `
      mutation($teamId: String!, $name: String!) {
        issueLabelCreate(input: { teamId: $teamId, name: $name }) {
          success
          issueLabel { id name }
        }
      }
      `,
      { teamId: input.teamId, name: input.name },
    );

    const label = data.issueLabelCreate.issueLabel;
    if (!label) throw new Error("Linear label create returned no issueLabel.");
    return label;
  }

  async resolveWorkflowStateId(teamId: string, stateType: string): Promise<string | null> {
    const states = await this.graphql<{ workflowStates: { nodes: Array<{ id: string; name: string; type: string }> } }>(
      `
      query($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            name
            type
          }
        }
      }
      `,
      { teamId }
    );

    const exact = states.workflowStates.nodes.find((state) => state.type === stateType);
    return exact?.id ?? null;
  }

  private async resolveTeamAndProjectIds(teamName: string | null, projectName: string | null): Promise<{ teamId: string | null; projectId: string | null }> {
    const data = await this.graphql<{ teams: { nodes: TeamNode[] } }>(
      `
      query {
        teams {
          nodes {
            id
            name
            projects {
              nodes {
                id
                name
              }
            }
          }
        }
      }
      `
    );

    const teams = data.teams.nodes;
    const aliases = LinearClient.loadAliases();
    const teamNameResolved = teamName ? (aliases?.teamNameAliases?.[teamName.toLowerCase()] ?? teamName) : null;
    const projectNameResolved = projectName ? (aliases?.projectTitleAliases?.[projectName.toLowerCase()] ?? projectName) : null;

    const team = teamNameResolved ? teams.find((candidate) => candidate.name === teamNameResolved) : null;
    const project = team && projectNameResolved ? team.projects.nodes.find((candidate) => candidate.name === projectNameResolved) : null;

    return {
      teamId: team?.id ?? null,
      projectId: project?.id ?? null,
    };
  }

  async getTodoStateId(teamId: string): Promise<string> {
    const states = await this.graphql<{ workflowStates: { nodes: Array<{ id: string; name: string; type: string }> } }>(
      `
      query($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes {
            id
            name
            type
          }
        }
      }
      `,
      { teamId }
    );

    const todoState = states.workflowStates.nodes.find((state) => state.type === "unstarted" || /todo|backlog/i.test(state.name));
    if (!todoState) {
      throw new Error("Could not determine Todo workflow state for Linear team");
    }

    return todoState.id;
  }

  /**
   * Fetch open issues with *no assignees*.
   * "Unassigned" for this automation = `assignees.nodes.length === 0`.
   */
  async fetchOpenUnassignedIssues(limit: number): Promise<LinearUnassignedIssue[]> {
    const teams = await this.graphql<{ teams: { nodes: Array<{ id: string; name: string }> } }>(
      `
      query {
        teams {
          nodes {
            id
            name
          }
        }
      }
      `
    );

    const results: LinearUnassignedIssue[] = [];

    for (const team of teams.teams.nodes) {
      let after: string | null = null;

      while (true) {
        if (results.length >= limit) break;

        const data: {
          issues: {
            nodes: Array<{
              id: string;
              title: string;
              description?: string;
              identifier: string;
              updatedAt: string;
              state: { type: string };
              project?: { id: string; name: string };
              team?: { name: string };
              assignee?: PersonNode | null;
              creator?: PersonNode;
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string };
          };
        } = await this.graphql(
          `
          query($teamId: ID!, $after: String) {
            issues(
              filter: {
                team: { id: { eq: $teamId } }
              }
              first: 50
              orderBy: updatedAt
              after: $after
            ) {
              nodes {
                id
                title
                description
                identifier
                updatedAt
                state { type }
                project { id name }
                team { name }
                assignee { id name email }
                creator { id name email }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
          `,
          { teamId: team.id, after }
        );

        for (const issue of data.issues.nodes) {
          const assignee = issue.assignee ?? null;
          // "Unassigned" for this automation = null assignee.
          if (assignee) continue;

          // Filter out the obviously closed states.
          const stateType = issue.state.type;
          if (stateType === "completed" || stateType === "canceled") continue;

          const description = issue.description;
          const teamName = issue.team?.name;
          const projectName = issue.project?.name;
          const projectId = issue.project?.id;
          const creatorName = issue.creator?.name;
          const assigneeNames: string[] = [];
          results.push({
            id: issue.id,
            title: issue.title,
            ...(description !== undefined ? { description } : {}),
            identifier: issue.identifier,
            updatedAt: issue.updatedAt,
            stateType,
            assigneeNames,
            ...(teamName !== undefined ? { teamName } : {}),
            ...(projectName !== undefined ? { projectName } : {}),
            ...(projectId !== undefined ? { projectId } : {}),
            ...(creatorName !== undefined ? { creatorName } : {}),
          });

          if (results.length >= limit) break;
        }

        if (!data.issues.pageInfo.hasNextPage) break;
        after = data.issues.pageInfo.endCursor;
      }

      if (results.length >= limit) break;
    }

    return results;
  }

  async updateIssueFields(input: {
    issueId: string;
    title?: string;
    description?: string;
    teamId?: string;
    projectId?: string;
    stateId?: string;
    assigneeId?: string;
    labelIds?: string[];
  }): Promise<{ id: string; identifier: string; url?: string }> {
    const issueUpdateInput: Record<string, unknown> = {};
    if (input.title !== undefined) issueUpdateInput.title = input.title;
    if (input.description !== undefined) issueUpdateInput.description = input.description;
    if (input.teamId !== undefined) issueUpdateInput.teamId = input.teamId;
    if (input.projectId !== undefined) issueUpdateInput.projectId = input.projectId;
    if (input.stateId !== undefined) issueUpdateInput.stateId = input.stateId;
    if (input.assigneeId !== undefined) issueUpdateInput.assigneeId = input.assigneeId;
    if (input.labelIds !== undefined) issueUpdateInput.labelIds = input.labelIds;

    const data = await this.graphql<{
      issueUpdate: { success: boolean; issue: { id: string; identifier: string; url?: string } };
    }>(
      `
      mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
      `,
      { id: input.issueId, input: issueUpdateInput }
    );

    return data.issueUpdate.issue;
  }

  private async searchScopedOpenIssueCandidates(teamName: string | null, projectName: string | null, note: CanonicalNote): Promise<LinearIssueCandidate[]> {
    if (!teamName && !projectName) {
      return [];
    }

    const { teamId, projectId } = await this.resolveTeamAndProjectIds(teamName, projectName);
    if (!teamId && !projectId) {
      return [];
    }

    const issues = await this.fetchIssues(teamId, projectId);
    return this.toCandidates(note, issues);
  }

  private async searchAllOpenIssueCandidates(note: CanonicalNote): Promise<LinearIssueCandidate[]> {
    const teams = await this.graphql<{ teams: { nodes: TeamNode[] } }>(
      `
      query {
        teams {
          nodes {
            id
            name
            projects {
              nodes {
                id
                name
              }
            }
          }
        }
      }
      `
    );

    const allCandidates: LinearIssueCandidate[] = [];
    for (const team of teams.teams.nodes) {
      const issues = await this.fetchIssues(team.id, null);
      allCandidates.push(...this.toCandidates(note, issues, team.name));
    }

    return allCandidates;
  }

  private async fetchIssues(teamId: string | null, projectId: string | null): Promise<Array<{
    id: string;
    title: string;
    description?: string;
    identifier: string;
    updatedAt: string;
    state: { type: string };
    project?: { name: string };
    team?: { name: string };
  }>> {
    const [query, variables] = projectId
      ? [
          `
      query($projectId: ID!, $after: String) {
        issues(
          filter: { project: { id: { eq: $projectId } } }
          first: 50
          orderBy: updatedAt
          after: $after
        ) {
          nodes {
            id
            title
            description
            identifier
            updatedAt
            state { type }
            project { name }
            team { name }
          }
        }
      }
      `,
          { projectId, after: null },
        ]
      : [
          `
      query($teamId: ID!, $after: String) {
        issues(
          filter: { team: { id: { eq: $teamId } } }
          first: 50
          orderBy: updatedAt
          after: $after
        ) {
          nodes {
            id
            title
            description
            identifier
            updatedAt
            state { type }
            project { name }
            team { name }
          }
        }
      }
      `,
          { teamId: teamId!, after: null },
        ];

    const issues = await this.graphql<{ issues: { nodes: Array<{
      id: string;
      title: string;
      description?: string;
      identifier: string;
      updatedAt: string;
      state: { type: string };
      project?: { name: string };
      team?: { name: string };
    }> } }>(query, variables);

    return issues.issues.nodes;
  }

  /** Linear workflow state types: only unstarted/started are "open"; completed/canceled/other are closed. */
  private static isOpenState(type: string): boolean {
    return type === "unstarted" || type === "started";
  }

  private toCandidates(
    note: CanonicalNote,
    issues: Array<{
      id: string;
      title: string;
      description?: string;
      identifier: string;
      updatedAt: string;
      state: { type: string };
      project?: { name: string };
      team?: { name: string };
    }>,
    defaultTeamName?: string
  ): LinearIssueCandidate[] {
    return issues
      .filter((issue) => LinearClient.isOpenState(issue.state.type))
      .map((issue) => {
        const description = issue.description;
        const team = issue.team?.name || defaultTeamName;
        const project = issue.project?.name;
        const candidate: LinearIssueCandidate = {
          id: issue.id,
          title: issue.title,
          identifier: issue.identifier,
          state: "open",
          updatedAt: issue.updatedAt,
          ...(description ? { description } : {}),
          ...(team ? { team } : {}),
          ...(project ? { project } : {}),
        };

        return {
          ...candidate,
          score: scoreLinearCandidate(note, candidate),
        };
      });
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return retryAsync(
      async () => {
        const response = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: this.apiKey,
          },
          body: JSON.stringify({ query, variables }),
        });

        // Linear reports the hourly budget window on every response; keep it on
        // the error so the watcher can pause until the window resets.
        const rateLimitResetAt = parseRateLimitResetHeader(response.headers.get("x-ratelimit-requests-reset"));

        if (!response.ok) {
          const body = await response.text();
          const error = new Error(`Linear API error ${response.status}: ${body}`);
          (error as { status?: number }).status = response.status;
          if (rateLimitResetAt) (error as { rateLimitResetAt?: number }).rateLimitResetAt = rateLimitResetAt;
          throw error;
        }

        const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
        if (json.errors?.length) {
          const error = new Error(`Linear API errors: ${json.errors.map((item) => item.message).join(", ")}`);
          (error as { status?: number }).status = 400;
          if (rateLimitResetAt) (error as { rateLimitResetAt?: number }).rateLimitResetAt = rateLimitResetAt;
          throw error;
        }

        if (!json.data) {
          throw new Error("Linear API returned no data");
        }

        return json.data;
      },
      (error) => {
        // A rate-limit rejection will not clear within the retry delays below;
        // retrying only spends more of the hourly budget.
        if (isRateLimitError(error)) {
          return false;
        }

        const status = typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status?: number }).status)
          : undefined;

        if (typeof status === "number" && status >= 500) {
          return true;
        }

        const message = error instanceof Error ? error.message : String(error);
        return /timeout|ECONNRESET|ENOTFOUND|fetch failed/i.test(message);
      },
      {
        attempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 4000,
      }
    );
  }
}
