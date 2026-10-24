import type { SourceName } from "../normalize/note.js";

export type RouterConfig = {
  default_authority: SourceName;
  authority_overrides: {
    projects: Record<string, { authority: SourceName }>;
    clients: Record<string, { authority: SourceName }>;
  };
  routing: {
    infer_team_from_project: boolean;
    infer_project_from_client: boolean;
    default_team: string | null;
    default_project: string | null;
    fuzzy_auto_apply_score_gap: number;
    /**
     * Maps a Granola folder name (case-insensitive) to an explicit route.
     * Granola folders are human-curated per client/engagement, so folder
     * membership is a high-confidence routing signal. Explicit entries here win
     * over the folder-name fuzzy fallback. Keyed by folder title.
     */
    folder_routes: Record<string, { team?: string; project?: string; client?: string }>;
  };
  dedupe: {
    enabled: boolean;
    search_scope: "all_linear_issues";
    canonical_strategy: "newest_open_issue";
    merge_new_data_into_canonical: boolean;
  };
  sources: Record<
    SourceName,
    { enabled: boolean; connected?: boolean }
  >;
  notifications: {
    enabled: boolean;
    slack_webhook_env_var: string;
    slack_channel: string | null;
    cadence: "realtime" | "hourly" | "every_3_hours" | "every_8_hours" | "daily";
    include_sources: Array<"fireflies" | "granola">;
    include_systems: Array<"obsidian" | "linear">;
    include_events: Array<"task_created" | "task_updated" | "task_completed" | "daily_report" | "manual_report">;
    daily_report: {
      enabled: boolean;
      hour_local: number;
    };
    on_demand_report: {
      enabled: boolean;
    };
  };
  extractor: {
    /** Max items returned when falling back to heuristic transcript parsing. */
    max_items: number;
    /** "prefer" uses curated section if present; "force" requires curated or returns []; "off" always uses heuristic. */
    curated_mode: "prefer" | "force" | "off";
    /** Commitment-language phrases for the heuristic fallback. Matched case-insensitively as whole phrases. */
    commitment_phrases: string[];
    /** Names or aliases assigned to each owner group. First list that matches wins. */
    owner_groups: {
      self: string[];
      client: string[];
      parking_lot_markers: string[];
    };
  };
}
