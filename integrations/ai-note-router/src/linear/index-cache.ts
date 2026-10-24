import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
export type LinearTeamIndex = {
  id: string;
  name: string;
  /** Set when the team has been retired in Linear; retired teams reject issue writes. */
  retiredAt?: string | null;
  projects: Array<{ id: string; name: string }>;
};

export type LinearRetiredTeam = { id: string; name: string; retiredAt: string };

export type LinearIndex = {
  generatedAt: string;
  teams: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string; teamId: string; teamName: string }>;
  /** Teams excluded from routing because Linear reports them as retired. */
  retiredTeams?: LinearRetiredTeam[];
};

export type LinearIndexSource = {
  listTeamsWithProjects(): Promise<LinearTeamIndex[]>;
};

export async function syncLinearIndex(
  workspaceRoot: string,
  client: LinearIndexSource
): Promise<{ linearDir: string; teams: number; projects: number; retiredTeams: number }> {
  const allTeams = await client.listTeamsWithProjects();
  const linearDir = getLinearIndexDir(workspaceRoot);
  ensureDirectory(linearDir);

  const retiredTeams: LinearRetiredTeam[] = allTeams
    .filter((team) => Boolean(team.retiredAt))
    .map((team) => ({ id: team.id, name: team.name, retiredAt: String(team.retiredAt) }));
  const teams = allTeams.filter((team) => !team.retiredAt);

  const generatedAt = new Date().toISOString();
  const projects = teams.flatMap((team) =>
    team.projects.map((project) => ({
      id: project.id,
      name: project.name,
      teamId: team.id,
      teamName: team.name,
    }))
  );

  const index: LinearIndex = {
    generatedAt,
    teams: teams.map((team) => ({ id: team.id, name: team.name })),
    projects,
    retiredTeams,
  };

  writeFileSync(join(linearDir, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  writeFileSync(join(linearDir, "teams.md"), buildTeamsMarkdown(generatedAt, teams, retiredTeams), "utf8");
  writeFileSync(join(linearDir, "projects.md"), buildProjectsMarkdown(generatedAt, projects), "utf8");

  const aliasesPath = join(linearDir, "aliases.json");
  if (!existsSync(aliasesPath)) {
    const template = {
      teamNameAliases: {},
      projectNameAliases: {},
    };
    writeFileSync(aliasesPath, JSON.stringify(template, null, 2) + "\n", "utf8");
  }

  const readmePath = join(linearDir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, buildLinearReadme(), "utf8");
  }

  return { linearDir, teams: index.teams.length, projects: index.projects.length, retiredTeams: retiredTeams.length };
}

export function loadLinearIndex(workspaceRoot: string): LinearIndex | null {
  const path = join(getLinearIndexDir(workspaceRoot), "index.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LinearIndex;
  } catch {
    return null;
  }
}

export function loadLinearAliases(workspaceRoot: string): {
  teamNameAliases: Record<string, string>;
  projectNameAliases: Record<string, string>;
} {
  const path = join(getLinearIndexDir(workspaceRoot), "aliases.json");
  if (!existsSync(path)) return { teamNameAliases: {}, projectNameAliases: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      teamNameAliases?: Record<string, string>;
      projectNameAliases?: Record<string, string>;
    };
    return {
      teamNameAliases: parsed.teamNameAliases ?? {},
      projectNameAliases: parsed.projectNameAliases ?? {},
    };
  } catch {
    return { teamNameAliases: {}, projectNameAliases: {} };
  }
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function getLinearIndexDir(workspaceRoot: string): string {
  return join(workspaceRoot, "integrations/linear-vault-sync/router-index");
}

function buildTeamsMarkdown(generatedAt: string, teams: LinearTeamIndex[], retiredTeams: LinearRetiredTeam[] = []): string {
  const lines = [
    "---",
    "type: linear-index",
    `generated-at: ${generatedAt}`,
    "---",
    "",
    "# Linear Teams Index",
    "",
    "| Team | Team ID | Project Count |",
    "| --- | --- | ---: |",
  ];
  for (const team of teams.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`| ${escapePipe(team.name)} | ${team.id} | ${team.projects.length} |`);
  }
  if (retiredTeams.length > 0) {
    lines.push("", "## Retired teams (not offered as routes)", "", "| Team | Team ID | Retired At |", "| --- | --- | --- |");
    for (const team of [...retiredTeams].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`| ${escapePipe(team.name)} | ${team.id} | ${team.retiredAt} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function buildProjectsMarkdown(
  generatedAt: string,
  projects: Array<{ id: string; name: string; teamId: string; teamName: string }>
): string {
  const lines = [
    "---",
    "type: linear-index",
    `generated-at: ${generatedAt}`,
    "---",
    "",
    "# Linear Projects Index",
    "",
    "| Project | Project ID | Team | Team ID |",
    "| --- | --- | --- | --- |",
  ];
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(
      `| ${escapePipe(project.name)} | ${project.id} | ${escapePipe(project.teamName)} | ${project.teamId} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildLinearReadme(): string {
  return [
    "# Linear Sync Data",
    "",
    "This folder is for Linear sync and routing identification data only.",
    "Do not use this folder for everyday notes.",
    "",
    "## Files",
    "",
    "- `index.json` - machine-readable teams/projects cache used by routing.",
    "- `teams.md` - generated team reference.",
    "- `projects.md` - generated project reference.",
    "- `aliases.json` - manual alias map for matching non-canonical names.",
    "",
    "## Update",
    "",
    "Run `npm run linear-sync-index` to refresh from Linear.",
    "",
  ].join("\n");
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|");
}
