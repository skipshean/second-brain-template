import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { VaultWriteResult } from "./second-brain.js";

export function writeVaultNote(workspaceRoot: string, note: VaultWriteResult): { filePath: string } {
  const filePath = join(workspaceRoot, note.filePath);
  const directory = dirname(filePath);

  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  writeFileIfChanged(filePath, note.summary);
  return { filePath };
}

/** Writes only when content differs, so re-processing a payload does not churn the vault (and its auto-commit hook). */
export function writeFileIfChanged(filePath: string, content: string): boolean {
  if (existsSync(filePath) && readFileSync(filePath, "utf8") === content) {
    return false;
  }
  writeFileSync(filePath, content, "utf8");
  return true;
}
