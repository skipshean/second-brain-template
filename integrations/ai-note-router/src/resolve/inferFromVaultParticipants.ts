import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { CanonicalNote } from "../normalize/note.js";
import type { RouterConfig } from "../config/types.js";
import type { ResolvedRoute } from "./routing.js";

type ProjectMeta = {
  title: string;
  titleLower: string;
  titleTokens: string[];
  teamLower?: string | null;
  team?: string | null;
};

type PersonMeta = {
  heading: string;
  headingLower: string;
  lastNameLower: string;
  /** Lowercased email from person note frontmatter, if present */
  emailLower: string | null;
  projectTitlesLower: Set<string>;
  teamTitlesLower: Set<string>;
};

type VaultInferenceCache = {
  workspaceRoot: string;
  projects: ProjectMeta[];
  people: PersonMeta[];
};

let cache: VaultInferenceCache | null = null;

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  return match?.[1] ?? null;
}

function parseYamlScalar(frontmatter: string, key: string): string | null {
  const lines = frontmatter.split(/\r?\n/);
  const keyPrefix = `${key}:`;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith(keyPrefix)) continue;
    const rest = trimmed.slice(keyPrefix.length).trim();
    if (!rest) return null;
    return rest.replace(/^["']|["']$/g, "").trim() || null;
  }
  return null;
}

function parseYamlList(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const keyPrefix = `${key}:`;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();

    if (!trimmed.startsWith(keyPrefix)) continue;

    const rest = trimmed.slice(keyPrefix.length).trim();
    if (!rest) {
      // Multiline list: key:\n  - a\n  - b
      const values: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const t = (lines[j] ?? "").trim();
        if (!t) break;
        if (t.startsWith("- ")) {
          values.push(t.slice(2).trim().replace(/^["']|["']$/g, ""));
          continue;
        }
        // Next YAML key
        if (/^[A-Za-z0-9_-]+:/.test(t)) break;
        // Ignore unknown lines
        break;
      }
      return values.filter(Boolean);
    }

    // Inline list: key: [a, b]
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      if (!inner) return [];
      return inner
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }

    // Single value: key: a
    return [rest.replace(/^["']|["']$/g, "")].filter(Boolean);
  }

  return [];
}

function getProjectsAndPeopleIndex(workspaceRoot: string): VaultInferenceCache {
  if (cache?.workspaceRoot === workspaceRoot) return cache;

  const projectsDir = join(workspaceRoot, "projects");
  const peopleDir = join(workspaceRoot, "people");

  const projects: ProjectMeta[] = [];
  try {
    const files = readdirSync(projectsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(projectsDir, file);
      const content = readFileSync(filePath, "utf8");
      const titleMatch = content.match(/^#\s*(.+)\s*$/m);
      const teamMatch = content.match(/-?\s*Team:\s*([^\n]+)/i);

      if (!titleMatch) continue;
      const title = titleMatch[1]?.trim();
      if (!title) continue;
      const titleLower = title.toLowerCase();
      projects.push({
        title,
        titleLower,
        titleTokens: tokenizeTitle(titleLower),
        team: normalizeProjectTeam(teamMatch?.[1] ?? null),
        teamLower: normalizeProjectTeam(teamMatch?.[1] ?? null)?.toLowerCase() ?? null,
      });
    }
  } catch {
    // If folders don't exist, keep indexes empty; inference will no-op.
  }

  const people: PersonMeta[] = [];
  try {
    const files = readdirSync(peopleDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(peopleDir, file);
      const content = readFileSync(filePath, "utf8");
      const headingMatch = content.match(/^#\s*(.+)\s*$/m);
      const heading = (headingMatch?.[1] ?? file.replace(/\.md$/, "")).trim();
      const headingLower = heading.toLowerCase();
      const lastNameLower = headingLower.split(/\s+/).filter(Boolean).slice(-1)[0] ?? headingLower;

      const contentLower = content.toLowerCase();
      const frontmatter = extractFrontmatter(content);
      const explicitProjects = frontmatter ? parseYamlList(frontmatter, "projects") : [];
      const explicitTeams = frontmatter ? parseYamlList(frontmatter, "teams") : [];
      const emailRaw = frontmatter ? parseYamlScalar(frontmatter, "email") : null;
      const emailLower = emailRaw ? emailRaw.toLowerCase().trim() : null;

      const projectTitlesLower = new Set<string>();
      const teamTitlesLower = new Set<string>();
      for (const t of explicitTeams) {
        const x = t.trim();
        if (x) teamTitlesLower.add(x.toLowerCase());
      }

      // If the person card doesn't explicitly list projects/teams, try inferring teams
      // from mentions of known project teams inside the card content.
      // This helps cases like "Mike Smith" -> "Epsilon Group" where the card text mentions the team.
      if (explicitTeams.length === 0 && explicitProjects.length === 0) {
        for (const p of projects) {
          if (p.teamLower && contentLower.includes(p.teamLower)) {
            teamTitlesLower.add(p.teamLower);
          }
        }
      }

      if (explicitProjects.length > 0) {
        for (const p of explicitProjects) {
          const x = p.trim();
          if (x) projectTitlesLower.add(x.toLowerCase());
        }
      } else {
        // Fallback heuristic: infer from text mentions of project titles.
        for (const p of projects) {
          if (contentLower.includes(p.titleLower)) {
            projectTitlesLower.add(p.titleLower);
          }
        }
      }

      people.push({
        heading,
        headingLower,
        lastNameLower,
        emailLower,
        projectTitlesLower,
        teamTitlesLower,
      });
    }
  } catch {
    // If folders don't exist, keep indexes empty.
  }

  cache = { workspaceRoot, projects, people };
  return cache;
}

// Email domain -> team name, e.g. { "acme.com": "Acme" }. Forces routing for known client domains.
const TEAM_BY_EMAIL_DOMAIN: Record<string, string> = {};

function normalizeProjectTeam(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned) return null;

  // Project notes can contain composite team lines like:
  //   Team: Acme Analytics, my-company
  // Prefer the leftmost segment so the project-specific team remains primary.
  const parts = cleaned
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;
  return parts[0] ?? null;
}

function scorePersonMatch(personNameLower: string, personMeta: PersonMeta): number {
  // Give a higher score when the person name appears directly in the file.
  // (We don't have a guaranteed canonical mapping, so keep this heuristic simple.)
  const direct = personMeta.headingLower === personNameLower;
  const lastName = personMeta.lastNameLower && personNameLower.endsWith(personMeta.lastNameLower);
  return (direct ? 10 : 0) + (lastName ? 3 : 0);
}

export function inferRouteFromVaultParticipants(
  workspaceRoot: string,
  note: CanonicalNote,
  config: RouterConfig,
  current: ResolvedRoute
): ResolvedRoute {
  const forcedTeamFromEmailDomain =
    note.people
      .map((p) => TEAM_BY_EMAIL_DOMAIN[(p.email?.toLowerCase() ?? "").split("@")[1] ?? ""])
      .find(Boolean) ?? null;

  // Only try when route fields are missing and we have participant names.
  if (note.people.length === 0) return current;
  if (current.team && current.project) {
    const teamMatchesForced = forcedTeamFromEmailDomain
      ? current.team?.toLowerCase() === forcedTeamFromEmailDomain.toLowerCase()
      : true;
    if (teamMatchesForced) return current;
  }
  if (!current.team && !current.project) {
    // ok, try fully-infer
  }

  const idx = getProjectsAndPeopleIndex(workspaceRoot);
  if (idx.projects.length === 0) return current;
  const contentInference = inferProjectFromContent(note, idx.projects);

  let bestProject: ProjectMeta | null = null;
  let bestScore = 0;
  let bestReasonPerson: string | null = null;
  let matchedAnyPersonCard = false;
  const matchedParticipants: string[] = [];

  if (idx.people.length > 0) for (const person of note.people) {
    const personName = person.name?.trim();
    const emailFromField = person.email?.trim();
    const emailFromName =
      personName && personName.includes("@") ? personName : null;
    const resolvedEmail = (emailFromField ?? emailFromName)?.toLowerCase().trim() ?? null;

    let candidates: PersonMeta[] = [];
    if (resolvedEmail) {
      const byEmail = idx.people.filter((p) => p.emailLower && p.emailLower === resolvedEmail);
      if (byEmail.length > 0) {
        candidates = byEmail;
      }
    }
    if (candidates.length === 0) {
      if (!personName) continue;
      const personNameLower = personName.toLowerCase();
      const lastNameLower = personNameLower.split(/\s+/).filter(Boolean).slice(-1)[0] ?? personNameLower;

      // Exact match first; then first-name prefix for short names ("deb"),
      // then fall back to last-name match.
      const exact = idx.people.filter((p) => p.headingLower === personNameLower);
      const firstNamePrefix = idx.people.filter((p) => p.headingLower.startsWith(`${personNameLower} `));
      const fallback = idx.people.filter((p) => p.lastNameLower === lastNameLower);
      if (exact.length > 0) {
        candidates = exact;
      } else if (firstNamePrefix.length > 0) {
        candidates = firstNamePrefix;
      } else {
        candidates = fallback;
      }
    }
    if (candidates.length === 0) continue;

    matchedAnyPersonCard = true;
    matchedParticipants.push(candidates[0]?.heading ?? personName ?? resolvedEmail ?? "");

    for (const personMeta of candidates) {
      const personNameLower = (personName ?? "").toLowerCase();
      let personScore = scorePersonMatch(personNameLower, personMeta);
      if (resolvedEmail && personMeta.emailLower && personMeta.emailLower === resolvedEmail) {
        personScore += 14;
      }
      const hasExplicitProjects = personMeta.projectTitlesLower.size > 0;
      const hasTeams = personMeta.teamTitlesLower.size > 0;
      if (!hasExplicitProjects && !hasTeams) continue;

      const projectCandidates: ProjectMeta[] = [];
      if (hasExplicitProjects) {
        for (const projectTitleLower of personMeta.projectTitlesLower) {
          const project = idx.projects.find((p) => p.titleLower === projectTitleLower) ?? null;
          if (project) projectCandidates.push(project);
        }
      } else {
        // Teams provided but projects not: include all projects in those teams.
        for (const project of idx.projects) {
          if (project.teamLower && personMeta.teamTitlesLower.has(project.teamLower)) {
            projectCandidates.push(project);
          }
        }
      }

      for (const project of projectCandidates) {

        const score = personScore + (hasExplicitProjects ? 5 : 3); // slightly lower for team-only
        if (score > bestScore) {
          bestScore = score;
          bestProject = project;
          bestReasonPerson = personMeta.heading;
        }
      }
    }
  }

  if (!bestProject) {
    if (contentInference.project) {
      const inferredProject = current.project ?? contentInference.project.title;
      const inferredTeam =
        forcedTeamFromEmailDomain ??
        current.team ??
        (config.routing.infer_team_from_project
          ? (contentInference.project.team ?? inferredProject)
          : current.team);
      return {
        team: inferredTeam ?? null,
        project: inferredProject ?? null,
        reason: `Inferred team/project from meeting content (${contentInference.reason}).`,
      };
    }

    if (!matchedAnyPersonCard) {
      return {
        team: forcedTeamFromEmailDomain ?? current.team ?? null,
        project: null,
        reason: `Needs review: no matching Obsidian people card for participants (${note.people.map((p) => p.name).filter(Boolean).join(", ")}).`,
      };
    }

    return {
      team: forcedTeamFromEmailDomain ?? current.team ?? null,
      project: null,
      reason: `Needs review: participants (${matchedParticipants.join(", ")}) matched Obsidian people cards, but no team/project mapping was found in vault.`,
    };
  }

  const inferredProject = current.project ?? bestProject.title;
  const inferredTeam =
    forcedTeamFromEmailDomain ??
    current.team ??
    (config.routing.infer_team_from_project
      ? (bestProject.team ?? inferredProject)
      : current.team);

  return {
    team: inferredTeam ?? null,
    project: inferredProject ?? null,
    reason: bestReasonPerson
      ? `Inferred team/project from vault participant '${bestReasonPerson}'.`
      : "Inferred team/project from vault participant.",
  };
}

function tokenizeTitle(titleLower: string): string[] {
  return titleLower
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function inferProjectFromContent(
  note: CanonicalNote,
  projects: ProjectMeta[]
): { project: ProjectMeta | null; reason: string } {
  const titleLower = note.title.toLowerCase();
  const bodyLower = note.body.toLowerCase();
  const tasksLower = note.tasks.map((t) => t.title.toLowerCase()).join("\n");
  const haystack = `${titleLower}\n${tasksLower}\n${bodyLower}`;

  let best: ProjectMeta | null = null;
  let bestScore = 0;
  let bestReason = "";

  for (const project of projects) {
    // Ignore ultra-short/generic project titles (e.g. "t") for content routing.
    if (project.titleLower.length < 4) continue;

    let score = 0;
    const exactMentions = countOccurrences(haystack, project.titleLower);
    if (exactMentions > 0) score += exactMentions * 6;

    let tokenHits = 0;
    for (const token of project.titleTokens) {
      if (token.length < 4) continue;
      if (new RegExp(`\\b${escapeRegex(token)}\\b`, "i").test(haystack)) {
        tokenHits += 1;
      }
    }
    score += tokenHits;

    if (score > bestScore) {
      bestScore = score;
      best = project;
      bestReason = `project phrase hits=${exactMentions}, token hits=${tokenHits}`;
    }
  }

  // Require strong evidence to avoid accidental cross-project routing.
  if (!best || bestScore < 7) return { project: null, reason: "" };
  return { project: best, reason: bestReason };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle.trim()) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = haystack.indexOf(needle, index);
    if (next < 0) break;
    count += 1;
    index = next + needle.length;
  }
  return count;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

