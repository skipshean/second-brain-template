import type { CanonicalNote } from "../normalize/note.js";

export type LinearIssueCandidate = {
  id: string;
  title: string;
  description?: string;
  identifier?: string;
  state: "open" | "closed";
  team?: string;
  project?: string;
  updatedAt?: string;
  score?: number;
};

export type DeduplicationResult = {
  action: "update" | "create" | "review";
  canonicalIssueId?: string;
  reason: string;
};

export function chooseCanonicalIssue(
  note: CanonicalNote,
  candidates: LinearIssueCandidate[]
): DeduplicationResult {
  const openCandidates = candidates.filter((issue) => issue.state === "open");

  if (!openCandidates.length) {
    return {
      action: "create",
      reason: "No open Linear issue matched the authoritative Second Brain context.",
    };
  }

  const best = [...openCandidates].sort((a, b) => {
    const scoreA = a.score ?? 0;
    const scoreB = b.score ?? 0;
    const updatedA = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const updatedB = b.updatedAt ? Date.parse(b.updatedAt) : 0;

    if (scoreA !== scoreB) return scoreB - scoreA;
    return updatedB - updatedA;
  })[0];

  if (!best) {
    return {
      action: "review",
      reason: "Open Linear candidates existed, but none could be selected confidently.",
    };
  }

  if ((best.score ?? 0) < 0.35) {
    return {
      action: "review",
      reason: `Best Linear candidate was too weak a match (${Math.round((best.score ?? 0) * 100)}%).`,
    };
  }

  return {
    action: "update",
    canonicalIssueId: best.id,
    reason: `Selected best open match for ${note.project || note.client || note.title}.`,
  };
}

export function scoreLinearCandidate(note: CanonicalNote, candidate: LinearIssueCandidate): number {
  const queryTerms = uniqueTerms([
    note.title,
    note.body,
    note.project,
    note.client,
    note.team,
    ...note.people.map((person) => person.name),
    ...note.tasks.map((task) => task.title),
    ...note.tags,
  ]);

  const candidateTerms = uniqueTerms([
    candidate.title,
    candidate.description || "",
    candidate.identifier || "",
    candidate.project || "",
    candidate.team || "",
  ]);

  if (queryTerms.length === 0 || candidateTerms.length === 0) {
    return 0;
  }

  const querySet = new Set(queryTerms);
  const candidateSet = new Set(candidateTerms);

  let overlap = 0;
  for (const term of querySet) {
    if (candidateSet.has(term)) {
      overlap += 1;
    }
  }

  const exactPhraseBonus =
    normalizedIncludes(candidate.title, note.title) ||
    normalizedIncludes(candidate.description || "", note.title) ||
    normalizedIncludes(note.body, candidate.title)
      ? 0.35
      : 0;

  const projectBonus =
    note.project && candidate.project && normalizeTerm(note.project) === normalizeTerm(candidate.project)
      ? 0.2
      : 0;

  const teamBonus =
    note.team && candidate.team && normalizeTerm(note.team) === normalizeTerm(candidate.team)
      ? 0.1
      : 0;

  const taskBonus = note.tasks.some((task) => normalizedIncludes(candidate.title, task.title) || normalizedIncludes(candidate.description || "", task.title))
    ? 0.2
    : 0;

  const bodyBonus = normalizedIncludes(candidate.description || "", note.body) || normalizedIncludes(note.body, candidate.description || "")
    ? 0.15
    : 0;

  const overlapScore = overlap / Math.max(querySet.size, candidateSet.size);
  const total = overlapScore * 0.6 + exactPhraseBonus + projectBonus + teamBonus + taskBonus + bodyBonus;
  return Math.min(1, Number(total.toFixed(3)));
}

function uniqueTerms(values: Array<string | undefined>): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const term of tokenize(value)) {
      terms.add(term);
    }
  }
  return Array.from(terms);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => term.length > 2);
}

function normalizeTerm(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function normalizedIncludes(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeTerm(haystack);
  const normalizedNeedle = normalizeTerm(needle);
  return normalizedHaystack.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedHaystack);
}
