import type { CanonicalNote, SourceName } from "../normalize/note.js";
import type { RouterConfig } from "../config/types.js";

export type SourceInput = {
  source: SourceName;
  id: string;
  url: string;
  title: string;
  body: string;
  capturedAt?: string;
  client?: string;
  project?: string;
  team?: string;
  people?: CanonicalNote["people"];
  tasks?: CanonicalNote["tasks"];
  tags?: string[];
  /** Source-side folder membership (e.g. Granola folders), used as a routing signal. */
  folders?: string[];
};

export type AdapterContext = {
  extractor?: RouterConfig["extractor"];
};

export interface SourceAdapter {
  source: SourceName;
  load(input: SourceInput, context?: AdapterContext): CanonicalNote;
}
