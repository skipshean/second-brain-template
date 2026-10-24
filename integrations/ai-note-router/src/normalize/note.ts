export type SourceName = "fireflies" | "granola" | "obsidian";

export interface SourceReference {
  source: SourceName;
  url: string;
  externalId?: string;
  capturedAt?: string;
}

export interface CanonicalPerson {
  name: string;
  email?: string;
  role?: string;
  company?: string;
}

export interface CanonicalTaskCandidate {
  title: string;
  description?: string;
  confidence: number;
  assigneeName?: string;
  assigneeEmail?: string;
  assigneeConfidence?: number;
  dueDate?: string;
  sourceQuote?: string;
  sourceSpeaker?: string;
  sourceTimestamp?: string;
  /** Ownership bucket used for grouped rendering in meeting notes. */
  ownerGroup?: "self" | "client" | "parking_lot";
}

export interface CanonicalNote {
  source: SourceReference;
  title: string;
  body: string;
  client?: string;
  project?: string;
  team?: string;
  /** Source-side folder membership (e.g. Granola folders) used for routing. */
  folders?: string[];
  people: CanonicalPerson[];
  tasks: CanonicalTaskCandidate[];
  confidence: number;
  tags: string[];
  authority: {
    source: SourceName;
    overrideReason?: string;
  };
}
