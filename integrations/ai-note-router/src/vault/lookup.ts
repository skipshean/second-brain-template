import { existsSync } from "fs";
import { join } from "path";
import type { CanonicalNote } from "../normalize/note.js";

export type VaultLookupResult = {
  filePath: string;
  exists: boolean;
};

export function lookupVaultContext(workspaceRoot: string, note: CanonicalNote): VaultLookupResult {
  const slug = (note.project || note.client || note.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const filePath = join(workspaceRoot, "projects", `${slug}.md`);
  return {
    filePath,
    exists: existsSync(filePath),
  };
}
