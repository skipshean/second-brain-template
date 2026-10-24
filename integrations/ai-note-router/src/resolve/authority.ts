import type { CanonicalNote, SourceName } from "../normalize/note.js";

type AuthorityConfig = {
  default_authority: SourceName;
  authority_overrides: {
    projects: Record<string, { authority: SourceName }>;
    clients: Record<string, { authority: SourceName }>;
  };
};

export function resolveAuthority(
  note: Pick<CanonicalNote, "client" | "project" | "source">,
  config: AuthorityConfig
): { source: SourceName; overrideReason?: string } {
  const projectKey = note.project?.trim().toLowerCase();
  const clientKey = note.client?.trim().toLowerCase();

  if (projectKey && config.authority_overrides.projects[projectKey]) {
    return {
      source: config.authority_overrides.projects[projectKey].authority,
      overrideReason: `project override: ${projectKey}`,
    };
  }

  if (clientKey && config.authority_overrides.clients[clientKey]) {
    return {
      source: config.authority_overrides.clients[clientKey].authority,
      overrideReason: `client override: ${clientKey}`,
    };
  }

  return { source: config.default_authority };
}
