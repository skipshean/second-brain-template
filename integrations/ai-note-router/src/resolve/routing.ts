import type { CanonicalNote } from "../normalize/note.js";
import type { RouterConfig } from "../config/types.js";
import { loadLinearAliases, loadLinearIndex } from "../linear/index-cache.js";

export type ResolvedRoute = {
  team: string | null;
  project: string | null;
  reason: string;
};

const FUZZY_AUTO_ROUTE_THRESHOLD = 0.86;
const FUZZY_SUGGEST_THRESHOLD = 0.75;

export function resolveRouting(note: CanonicalNote, config: RouterConfig, workspaceRoot: string): ResolvedRoute {
  const index = loadLinearIndex(workspaceRoot);
  const aliases = loadLinearAliases(workspaceRoot);

  // Granola folders are human-curated per client/engagement, so folder
  // membership is a strong routing signal. Precedence:
  //   1. explicit note.team/project (e.g. mapped in a Zapier step)
  //   2. an explicit `routing.folder_routes` entry (deterministic, trusted)
  //   3. the folder name itself as a project hint — but only if it clears the
  //      Linear-index (exact/fuzzy) match, so generic folders ("Sales calls")
  //      don't leak through as bogus projects.
  const explicitNoteTeam = note.team?.trim() || null;
  const explicitNoteProject = note.project?.trim() || null;
  const folderMatch = matchFolderRoute(note.folders, config.routing.folder_routes);

  if (explicitNoteTeam || explicitNoteProject || folderMatch) {
    const team = explicitNoteTeam || folderMatch?.route.team?.trim() || null;
    const project = explicitNoteProject || folderMatch?.route.project?.trim() || null;
    const base = resolveFromInputs(team, project, index, aliases, config);
    if (folderMatch && (base.team || base.project)) {
      return { ...base, reason: `${base.reason} [Granola folder: ${folderMatch.name}]`.trim() };
    }
    return base;
  }

  const folderHintProject = firstFolderName(note.folders);
  if (folderHintProject) {
    const hinted = resolveFromInputs(null, folderHintProject, index, aliases, config);
    // Only keep the hint if it actually resolved against the Linear index.
    // "resolved via ..." is the positive signal; suggestion/pass-through
    // reasons ("not auto-resolved", "resolved with ... fallback") are rejected
    // so an unmatched folder name never leaks through as a bogus project.
    if ((hinted.team || hinted.project) && /resolved via/i.test(hinted.reason)) {
      return { ...hinted, reason: `${hinted.reason} [Granola folder: ${folderHintProject}]`.trim() };
    }
  }

  return resolveFromInputs(null, null, index, aliases, config);
}

function resolveFromInputs(
  explicitTeam: string | null,
  explicitProject: string | null,
  index: ReturnType<typeof loadLinearIndex>,
  aliases: ReturnType<typeof loadLinearAliases>,
  config: RouterConfig
): ResolvedRoute {
  const resolved = resolveAgainstLinearIndex(
    explicitTeam,
    explicitProject,
    index,
    aliases,
    config.routing.fuzzy_auto_apply_score_gap
  );
  if (resolved.dropped) {
    return { team: null, project: null, reason: resolved.reason };
  }

  const team = resolved.team ?? config.routing.default_team;
  const project = resolved.project ?? config.routing.default_project;

  if ((resolved.team || resolved.project) && (resolved.reason || "").length > 0) {
    return {
      team,
      project,
      reason: resolved.reason,
    };
  }

  if (team && project) {
    return {
      team,
      project,
      reason: "Route resolved from explicit note context or defaults.",
    };
  }

  if (team) {
    return {
      team,
      project,
      reason: "Route resolved with team context and default project fallback.",
    };
  }

  if (project) {
    return {
      team,
      project,
      reason: "Route resolved with project context and default team fallback.",
    };
  }

  return {
    team,
    project,
    reason: "No explicit route context found; worker will require a later mapping or manual review.",
  };
}

function firstFolderName(folders: string[] | undefined): string | null {
  if (!folders) return null;
  for (const folder of folders) {
    const trimmed = folder?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function matchFolderRoute(
  folders: string[] | undefined,
  folderRoutes: RouterConfig["routing"]["folder_routes"]
): { name: string; route: { team?: string; project?: string; client?: string } } | null {
  if (!folders || !folderRoutes) return null;
  const byLowerName = new Map<string, { key: string; route: { team?: string; project?: string; client?: string } }>();
  for (const [key, route] of Object.entries(folderRoutes)) {
    byLowerName.set(key.trim().toLowerCase(), { key: key.trim(), route });
  }
  for (const folder of folders) {
    const normalized = folder?.trim().toLowerCase();
    if (!normalized) continue;
    const hit = byLowerName.get(normalized);
    if (hit) return { name: hit.key, route: hit.route };
  }
  return null;
}

function resolveAgainstLinearIndex(
  team: string | null,
  project: string | null,
  index: ReturnType<typeof loadLinearIndex>,
  aliases: ReturnType<typeof loadLinearAliases>,
  gapThreshold = 0.2
): { team: string | null; project: string | null; reason: string; dropped?: boolean } {
  if (!index) {
    return { team, project, reason: "" };
  }

  const normTeamInput = normalizeName(team ? aliases.teamNameAliases[team.toLowerCase()] ?? team : null);
  const normProjectInput = normalizeName(project ? aliases.projectNameAliases[project.toLowerCase()] ?? project : null);

  // A retired Linear team rejects every issue write ("Entity is retired: team"),
  // so a route pointing at one must not reach the Linear step at all. The vault
  // note is still written; only the Linear sync is skipped.
  const retiredTeam = normTeamInput
    ? (index.retiredTeams ?? []).find((candidate) => normalizeName(candidate.name) === normTeamInput) ?? null
    : null;
  if (retiredTeam) {
    return {
      team: null,
      project: null,
      dropped: true,
      reason: `Team '${retiredTeam.name}' is retired in Linear (since ${retiredTeam.retiredAt}); Linear routing skipped, vault note only.`,
    };
  }

  const teamMatch = normTeamInput
    ? index.teams.find((candidate) => normalizeName(candidate.name) === normTeamInput) ?? null
    : null;

  const exactProjectSelection = normProjectInput
    ? selectProjectMatch(index.projects, normProjectInput, teamMatch?.id ?? null)
    : { match: null, ambiguous: false };
  const projectMatch = exactProjectSelection.match;

  if (!teamMatch && normTeamInput) {
    const ranked = topFuzzyMatches(normTeamInput, index.teams.map((t) => t.name), 3);
    const fuzzyTeam = ranked[0] ?? null;
    const secondTeam = ranked[1] ?? null;
    if (fuzzyTeam && fuzzyTeam.score >= FUZZY_AUTO_ROUTE_THRESHOLD) {
      const matched = index.teams.find((t) => t.name === fuzzyTeam.value) ?? null;
      if (matched) {
        return {
          team: matched.name,
          project,
          reason: `Team resolved via local Linear fuzzy match (${Math.round(fuzzyTeam.score * 100)}%).`,
        };
      }
    }
    if (
      fuzzyTeam &&
      secondTeam &&
      fuzzyTeam.score >= FUZZY_SUGGEST_THRESHOLD &&
      fuzzyTeam.score < FUZZY_AUTO_ROUTE_THRESHOLD &&
      fuzzyTeam.score - secondTeam.score >= gapThreshold
    ) {
      const matched = index.teams.find((t) => t.name === fuzzyTeam.value) ?? null;
      if (matched) {
        return {
          team: matched.name,
          project,
          reason: `Team resolved via score-gap fuzzy promotion (${Math.round(fuzzyTeam.score * 100)}%, gap ${Math.round((fuzzyTeam.score - secondTeam.score) * 100)}%).`,
        };
      }
    }
    if (fuzzyTeam && fuzzyTeam.score >= FUZZY_SUGGEST_THRESHOLD) {
      const suggestions = ranked
        .filter((s) => s.score >= FUZZY_SUGGEST_THRESHOLD)
        .map((s) => `${s.value} (${Math.round(s.score * 100)}%)`)
        .join(", ");
      return {
        team,
        project,
        reason: `Team not auto-resolved (low-confidence fuzzy match). Suggestions: ${suggestions || "none"}.`,
      };
    }
  }

  if (exactProjectSelection.ambiguous) {
    return {
      team,
      project,
      reason: "Project not auto-resolved: name is ambiguous across multiple teams. Provide team to disambiguate.",
    };
  }

  if (!projectMatch && normProjectInput) {
    const ranked = topFuzzyMatches(normProjectInput, index.projects.map((p) => p.name), 3);
    const fuzzyProject = ranked[0] ?? null;
    const secondProject = ranked[1] ?? null;
    if (fuzzyProject && fuzzyProject.score >= FUZZY_AUTO_ROUTE_THRESHOLD) {
      const matchedSelection = selectProjectByRawName(index.projects, fuzzyProject.value, teamMatch?.id ?? null);
      const matched = matchedSelection.match;
      if (matched) {
        return {
          team: matched.teamName,
          project: matched.name,
          reason: `Route resolved via local Linear fuzzy project match (${Math.round(fuzzyProject.score * 100)}%).`,
        };
      }
      if (matchedSelection.ambiguous) {
        return {
          team,
          project,
          reason: "Project not auto-resolved: fuzzy match points to a project name shared by multiple teams.",
        };
      }
    }
    if (
      fuzzyProject &&
      secondProject &&
      fuzzyProject.score >= FUZZY_SUGGEST_THRESHOLD &&
      fuzzyProject.score < FUZZY_AUTO_ROUTE_THRESHOLD &&
      fuzzyProject.score - secondProject.score >= gapThreshold
    ) {
      const matchedSelection = selectProjectByRawName(index.projects, fuzzyProject.value, teamMatch?.id ?? null);
      const matched = matchedSelection.match;
      if (matched) {
        return {
          team: matched.teamName,
          project: matched.name,
          reason: `Route resolved via score-gap fuzzy promotion (${Math.round(fuzzyProject.score * 100)}%, gap ${Math.round((fuzzyProject.score - secondProject.score) * 100)}%).`,
        };
      }
      if (matchedSelection.ambiguous) {
        return {
          team,
          project,
          reason: "Project not auto-resolved: fuzzy match points to a project name shared by multiple teams.",
        };
      }
    }
    if (fuzzyProject && fuzzyProject.score >= FUZZY_SUGGEST_THRESHOLD) {
      const suggestions = ranked
        .filter((s) => s.score >= FUZZY_SUGGEST_THRESHOLD)
        .map((s) => `${s.value} (${Math.round(s.score * 100)}%)`)
        .join(", ");
      return {
        team,
        project,
        reason: `Project not auto-resolved (low-confidence fuzzy match). Suggestions: ${suggestions || "none"}.`,
      };
    }
  }

  if (teamMatch && projectMatch && projectMatch.teamId === teamMatch.id) {
    return {
      team: teamMatch.name,
      project: projectMatch.name,
      reason: "Route resolved via local Linear index exact match.",
    };
  }

  if (!teamMatch && projectMatch) {
    return {
      team: projectMatch.teamName,
      project: projectMatch.name,
      reason: "Route resolved via local Linear project match and inferred team.",
    };
  }

  if (teamMatch && !projectMatch) {
    return {
      team: teamMatch.name,
      project,
      reason: "Team resolved via local Linear index; project unresolved.",
    };
  }

  return { team, project, reason: "" };
}

function selectProjectMatch(
  projects: Array<{ id: string; name: string; teamId: string; teamName: string }>,
  normalizedName: string,
  teamId: string | null
): {
  match: { id: string; name: string; teamId: string; teamName: string } | null;
  ambiguous: boolean;
} {
  const matches = projects.filter((candidate) => normalizeName(candidate.name) === normalizedName);
  if (teamId) {
    const scoped = matches.filter((candidate) => candidate.teamId === teamId);
    if (scoped.length === 1) return { match: scoped[0] ?? null, ambiguous: false };
    if (scoped.length > 1) return { match: null, ambiguous: true };
    return { match: null, ambiguous: false };
  }
  if (matches.length === 1) return { match: matches[0] ?? null, ambiguous: false };
  if (matches.length > 1) return { match: null, ambiguous: true };
  return { match: null, ambiguous: false };
}

function selectProjectByRawName(
  projects: Array<{ id: string; name: string; teamId: string; teamName: string }>,
  rawName: string,
  teamId: string | null
): {
  match: { id: string; name: string; teamId: string; teamName: string } | null;
  ambiguous: boolean;
} {
  const matches = projects.filter((project) => project.name === rawName);
  if (teamId) {
    const scoped = matches.filter((project) => project.teamId === teamId);
    if (scoped.length === 1) return { match: scoped[0] ?? null, ambiguous: false };
    if (scoped.length > 1) return { match: null, ambiguous: true };
    return { match: null, ambiguous: false };
  }
  if (matches.length === 1) return { match: matches[0] ?? null, ambiguous: false };
  if (matches.length > 1) return { match: null, ambiguous: true };
  return { match: null, ambiguous: false };
}

function normalizeName(value: string | null): string | null {
  if (!value) return null;
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function topFuzzyMatches(input: string, candidates: string[], limit: number): Array<{ value: string; score: number }> {
  const ranked = candidates
    .map((candidate) => {
      const normalized = normalizeName(candidate);
      if (!normalized) return null;
      return { value: candidate, score: diceCoefficient(input, normalized) };
    })
    .filter((item): item is { value: string; score: number } => item !== null)
    .sort((a, b) => b.score - a.score);

  const unique = new Map<string, { value: string; score: number }>();
  for (const item of ranked) {
    if (!unique.has(item.value)) unique.set(item.value, item);
  }
  return Array.from(unique.values()).slice(0, limit);
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  let intersection = 0;
  const bMap = new Map<string, number>();
  for (const token of bBigrams) {
    bMap.set(token, (bMap.get(token) ?? 0) + 1);
  }
  for (const token of aBigrams) {
    const count = bMap.get(token) ?? 0;
    if (count > 0) {
      intersection += 1;
      bMap.set(token, count - 1);
    }
  }
  return (2 * intersection) / (aBigrams.length + bBigrams.length);
}

function bigrams(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length - 1; i += 1) {
    out.push(value.slice(i, i + 2));
  }
  return out;
}
