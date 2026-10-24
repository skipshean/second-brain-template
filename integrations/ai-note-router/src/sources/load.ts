import { existsSync, readFileSync } from "fs";
import type { CanonicalNote } from "../normalize/note.js";
import type { SourceInput, AdapterContext } from "./types.js";
import { firefliesAdapter } from "./fireflies.js";
import { granolaAdapter } from "./granola.js";

export function loadCanonicalNoteFromInput(input: SourceInput, context?: AdapterContext): CanonicalNote {
  switch (input.source) {
    case "granola":
      return granolaAdapter.load(input, context);
    case "fireflies":
    default:
      return firefliesAdapter.load(input, context);
  }
}

export function loadCanonicalNoteFromFile(inputPath: string, context?: AdapterContext): CanonicalNote {
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const parsed = JSON.parse(readFileSync(inputPath, "utf8")) as SourceInput;
  return loadCanonicalNoteFromInput(parsed, context);
}
