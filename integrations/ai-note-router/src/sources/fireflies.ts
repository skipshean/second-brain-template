import type { SourceAdapter, SourceInput, AdapterContext } from "./types.js";
import { buildTaskCandidates } from "../normalize/tasks.js";

export const firefliesAdapter: SourceAdapter = {
  source: "fireflies",
  load(input: SourceInput, context?: AdapterContext) {
    const source = {
      source: "fireflies" as const,
      url: input.url,
      externalId: input.id,
      ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
    };

    return {
      source,
      title: input.title,
      body: input.body,
      ...(input.client ? { client: input.client } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.team ? { team: input.team } : {}),
      people: input.people ?? [],
      tasks: buildTaskCandidates({
        body: input.body,
        people: input.people ?? [],
        tasks: input.tasks ?? [],
        ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
        ...(context?.extractor ? { extractor: context.extractor } : {}),
      }),
      confidence: 1,
      tags: input.tags ?? [],
      authority: {
        source: "fireflies",
      },
    };
  },
};
