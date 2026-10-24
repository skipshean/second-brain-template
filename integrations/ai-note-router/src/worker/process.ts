import type { RouterConfig } from "../config/types.js";
import type { CanonicalNote } from "../normalize/note.js";
import { resolveAuthority } from "../resolve/authority.js";
import { chooseCanonicalIssue, type DeduplicationResult, type LinearIssueCandidate } from "../resolve/dedupe.js";
import { resolveRouting, type ResolvedRoute } from "../resolve/routing.js";
import { inferRouteFromVaultParticipants } from "../resolve/inferFromVaultParticipants.js";
import { buildVaultNote, type VaultWriteResult } from "../vault/second-brain.js";
import { lookupVaultContext, type VaultLookupResult } from "../vault/lookup.js";
import { buildLinearSyncPlan, type LinearSyncResult } from "../linear/sync.js";

export type ProcessingResult = {
  note: CanonicalNote;
  authority: ReturnType<typeof resolveAuthority>;
  route: ResolvedRoute;
  vaultContext: VaultLookupResult;
  dedupe: DeduplicationResult;
  vault: VaultWriteResult;
  linear: LinearSyncResult;
};

export function processNote(
  note: CanonicalNote,
  config: RouterConfig,
  candidates: LinearIssueCandidate[] = [],
  workspaceRoot: string
): ProcessingResult {
  const authority = resolveAuthority(note, config);
  const resolvedBaseRoute = resolveRouting(note, config, workspaceRoot);
  const route = inferRouteFromVaultParticipants(workspaceRoot, note, config, resolvedBaseRoute);
  const vaultContext = lookupVaultContext(workspaceRoot, note);

  const noteWithAuthority: CanonicalNote = {
    ...note,
    authority: {
      ...note.authority,
      source: authority.source,
      ...(authority.overrideReason ? { overrideReason: authority.overrideReason } : {}),
    },
  };

  const dedupe = config.dedupe.enabled
    ? chooseCanonicalIssue(noteWithAuthority, candidates)
    : { action: "review" as const, reason: "Deduping disabled by config." };

  const vault = buildVaultNote(noteWithAuthority, dedupe.canonicalIssueId, route);
  const linear = buildLinearSyncPlan(noteWithAuthority, dedupe.canonicalIssueId, noteWithAuthority.body);

  return {
    note: noteWithAuthority,
    authority,
    route,
    vaultContext,
    dedupe,
    vault,
    linear,
  };
}
