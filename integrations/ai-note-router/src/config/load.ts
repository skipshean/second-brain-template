import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import type { RouterConfig } from "./types.js";
import type { SourceName } from "../normalize/note.js";

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`Invalid boolean for ${path}: ${String(value)}`);
}

function parseNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "~" || trimmed.length === 0) return null;
    return trimmed;
  }
  throw new Error(`Invalid string|null for ${path}: ${String(value)}`);
}

function parseNumber(value: unknown, path: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Invalid number for ${path}: ${String(value)}`);
}

function parseString(value: unknown, path: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new Error(`Invalid string for ${path}: ${String(value)}`);
}

function parseSourceName(value: unknown, path: string): SourceName {
  if (typeof value !== "string") {
    throw new Error(`Invalid source for ${path}: ${String(value)}`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "fireflies" || normalized === "granola" || normalized === "obsidian") {
    return normalized;
  }
  throw new Error(`Unsupported source for ${path}: ${value}`);
}

function parseDedupeSearchScope(value: unknown): RouterConfig["dedupe"]["search_scope"] {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "all_linear_issues") return normalized;
  throw new Error(`Unsupported dedupe.search_scope: ${value}`);
}

function parseDedupeCanonicalStrategy(value: unknown): RouterConfig["dedupe"]["canonical_strategy"] {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "newest_open_issue") return normalized;
  throw new Error(`Unsupported dedupe.canonical_strategy: ${value}`);
}

function parseCadence(value: unknown): RouterConfig["notifications"]["cadence"] {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized === "realtime" ||
    normalized === "hourly" ||
    normalized === "every_3_hours" ||
    normalized === "every_8_hours" ||
    normalized === "daily"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported notifications.cadence: ${String(value)}`);
}

function parseSourceFilters(value: unknown): RouterConfig["notifications"]["include_sources"] {
  if (!Array.isArray(value)) throw new Error("notifications.include_sources must be an array");
  const out = value
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item): item is "fireflies" | "granola" => item === "fireflies" || item === "granola");
  return Array.from(new Set(out));
}

function parseSystemFilters(value: unknown): RouterConfig["notifications"]["include_systems"] {
  if (!Array.isArray(value)) throw new Error("notifications.include_systems must be an array");
  const out = value
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item): item is "obsidian" | "linear" => item === "obsidian" || item === "linear");
  return Array.from(new Set(out));
}

function parseEventFilters(value: unknown): RouterConfig["notifications"]["include_events"] {
  if (!Array.isArray(value)) throw new Error("notifications.include_events must be an array");
  const out = value
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter(
      (
        item
      ): item is "task_created" | "task_updated" | "task_completed" | "daily_report" | "manual_report" =>
        item === "task_created" ||
        item === "task_updated" ||
        item === "task_completed" ||
        item === "daily_report" ||
        item === "manual_report"
    );
  return Array.from(new Set(out));
}

function createDefaultConfig(): RouterConfig {
  return {
    default_authority: "fireflies",
    authority_overrides: {
      projects: {},
      clients: {},
    },
    routing: {
      infer_team_from_project: true,
      infer_project_from_client: true,
      default_team: null,
      default_project: null,
      fuzzy_auto_apply_score_gap: 0.2,
      folder_routes: {},
    },
    dedupe: {
      enabled: true,
      search_scope: "all_linear_issues",
      canonical_strategy: "newest_open_issue",
      merge_new_data_into_canonical: true,
    },
    sources: {
      fireflies: { enabled: true, connected: false },
      granola: { enabled: true, connected: false },
      obsidian: { enabled: true },
    },
    notifications: {
      enabled: false,
      slack_webhook_env_var: "SLACK_WEBHOOK_URL",
      slack_channel: null,
      cadence: "realtime",
      include_sources: ["fireflies", "granola"],
      include_systems: ["obsidian", "linear"],
      include_events: ["task_created", "daily_report", "manual_report"],
      daily_report: {
        enabled: true,
        hour_local: 8,
      },
      on_demand_report: {
        enabled: true,
      },
    },
    extractor: {
      max_items: 15,
      curated_mode: "prefer",
      commitment_phrases: [
        "i'll", "i will", "we'll", "we will",
        "send me", "send over", "send you", "get you", "follow up",
        "follow-up", "track down", "confirm", "schedule", "draft",
        "by eow", "by end of week", "by tomorrow", "next week",
      ],
      owner_groups: {
        self: [], // set your own names in authority.yaml (extractor.owner_groups.self)
        client: [],
        parking_lot_markers: ["parking lot", "open question", "open questions", "maybe", "someday"],
      },
    },
  };
}

export function loadRouterConfig(configPath: string): RouterConfig {
  const config = createDefaultConfig();
  const parsed = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") {
    return config;
  }

  if ("default_authority" in parsed) {
    config.default_authority = parseSourceName(parsed.default_authority, "default_authority");
  }

  const authorityOverrides = parsed.authority_overrides as Record<string, unknown> | undefined;
  if (authorityOverrides && typeof authorityOverrides === "object") {
    const projects = authorityOverrides.projects as Record<string, unknown> | undefined;
    if (projects && typeof projects === "object") {
      for (const [name, value] of Object.entries(projects)) {
        const mapped = (value as { authority?: unknown })?.authority;
        if (mapped !== undefined) {
          config.authority_overrides.projects[name] = { authority: parseSourceName(mapped, `authority_overrides.projects.${name}.authority`) };
        }
      }
    }
    const clients = authorityOverrides.clients as Record<string, unknown> | undefined;
    if (clients && typeof clients === "object") {
      for (const [name, value] of Object.entries(clients)) {
        const mapped = (value as { authority?: unknown })?.authority;
        if (mapped !== undefined) {
          config.authority_overrides.clients[name] = { authority: parseSourceName(mapped, `authority_overrides.clients.${name}.authority`) };
        }
      }
    }
  }

  const routing = parsed.routing as Record<string, unknown> | undefined;
  if (routing && typeof routing === "object") {
    if ("infer_team_from_project" in routing) {
      config.routing.infer_team_from_project = parseBoolean(routing.infer_team_from_project, "routing.infer_team_from_project");
    }
    if ("infer_project_from_client" in routing) {
      config.routing.infer_project_from_client = parseBoolean(routing.infer_project_from_client, "routing.infer_project_from_client");
    }
    if ("default_team" in routing) {
      config.routing.default_team = parseNullableString(routing.default_team, "routing.default_team");
    }
    if ("default_project" in routing) {
      config.routing.default_project = parseNullableString(routing.default_project, "routing.default_project");
    }
    if ("fuzzy_auto_apply_score_gap" in routing) {
      config.routing.fuzzy_auto_apply_score_gap = parseNumber(
        routing.fuzzy_auto_apply_score_gap,
        "routing.fuzzy_auto_apply_score_gap"
      );
    }
    const folderRoutes = routing.folder_routes as Record<string, unknown> | undefined;
    if (folderRoutes && typeof folderRoutes === "object") {
      for (const [name, value] of Object.entries(folderRoutes)) {
        if (!value || typeof value !== "object") continue;
        const route = value as { team?: unknown; project?: unknown; client?: unknown };
        const entry: { team?: string; project?: string; client?: string } = {};
        if (typeof route.team === "string" && route.team.trim()) entry.team = route.team.trim();
        if (typeof route.project === "string" && route.project.trim()) entry.project = route.project.trim();
        if (typeof route.client === "string" && route.client.trim()) entry.client = route.client.trim();
        if (entry.team || entry.project || entry.client) {
          config.routing.folder_routes[name.trim()] = entry;
        }
      }
    }
  }

  const dedupe = parsed.dedupe as Record<string, unknown> | undefined;
  if (dedupe && typeof dedupe === "object") {
    if ("enabled" in dedupe) config.dedupe.enabled = parseBoolean(dedupe.enabled, "dedupe.enabled");
    if ("search_scope" in dedupe) config.dedupe.search_scope = parseDedupeSearchScope(dedupe.search_scope);
    if ("canonical_strategy" in dedupe) config.dedupe.canonical_strategy = parseDedupeCanonicalStrategy(dedupe.canonical_strategy);
    if ("merge_new_data_into_canonical" in dedupe) {
      config.dedupe.merge_new_data_into_canonical = parseBoolean(
        dedupe.merge_new_data_into_canonical,
        "dedupe.merge_new_data_into_canonical"
      );
    }
  }

  const sources = parsed.sources as Record<string, unknown> | undefined;
  if (sources && typeof sources === "object") {
    for (const sourceName of ["fireflies", "granola", "obsidian"] as const) {
      const sourceConfig = sources[sourceName] as Record<string, unknown> | undefined;
      if (!sourceConfig || typeof sourceConfig !== "object") continue;
      if ("enabled" in sourceConfig) {
        config.sources[sourceName].enabled = parseBoolean(sourceConfig.enabled, `sources.${sourceName}.enabled`);
      }
      if ((sourceName === "fireflies" || sourceName === "granola") && "connected" in sourceConfig) {
        config.sources[sourceName].connected = parseBoolean(sourceConfig.connected, `sources.${sourceName}.connected`);
      }
    }
  }

  const notifications = parsed.notifications as Record<string, unknown> | undefined;
  if (notifications && typeof notifications === "object") {
    if ("enabled" in notifications) {
      config.notifications.enabled = parseBoolean(notifications.enabled, "notifications.enabled");
    }
    if ("slack_webhook_env_var" in notifications) {
      config.notifications.slack_webhook_env_var = parseString(
        notifications.slack_webhook_env_var,
        "notifications.slack_webhook_env_var"
      );
    }
    if ("slack_channel" in notifications) {
      config.notifications.slack_channel = parseNullableString(notifications.slack_channel, "notifications.slack_channel");
    }
    if ("cadence" in notifications) {
      config.notifications.cadence = parseCadence(notifications.cadence);
    }
    if ("include_sources" in notifications) {
      config.notifications.include_sources = parseSourceFilters(notifications.include_sources);
    }
    if ("include_systems" in notifications) {
      config.notifications.include_systems = parseSystemFilters(notifications.include_systems);
    }
    if ("include_events" in notifications) {
      config.notifications.include_events = parseEventFilters(notifications.include_events);
    }

    const daily = notifications.daily_report as Record<string, unknown> | undefined;
    if (daily && typeof daily === "object") {
      if ("enabled" in daily) {
        config.notifications.daily_report.enabled = parseBoolean(daily.enabled, "notifications.daily_report.enabled");
      }
      if ("hour_local" in daily) {
        const parsedHour = parseNumber(daily.hour_local, "notifications.daily_report.hour_local");
        config.notifications.daily_report.hour_local = Math.min(23, Math.max(0, Math.floor(parsedHour)));
      }
    }

    const onDemand = notifications.on_demand_report as Record<string, unknown> | undefined;
    if (onDemand && typeof onDemand === "object" && "enabled" in onDemand) {
      config.notifications.on_demand_report.enabled = parseBoolean(
        onDemand.enabled,
        "notifications.on_demand_report.enabled"
      );
    }
  }

  const extractor = parsed.extractor as Record<string, unknown> | undefined;
  if (extractor && typeof extractor === "object") {
    if ("max_items" in extractor) {
      const n = parseNumber(extractor.max_items, "extractor.max_items");
      if (n < 1) throw new Error("extractor.max_items must be >= 1");
      config.extractor.max_items = Math.floor(n);
    }
    if ("curated_mode" in extractor) {
      const raw = typeof extractor.curated_mode === "string" ? extractor.curated_mode.trim().toLowerCase() : "";
      if (raw === "prefer" || raw === "force" || raw === "off") {
        config.extractor.curated_mode = raw;
      } else {
        throw new Error(`Unsupported extractor.curated_mode: ${String(extractor.curated_mode)}`);
      }
    }
    if ("commitment_phrases" in extractor) {
      const arr = extractor.commitment_phrases;
      if (!Array.isArray(arr)) throw new Error("extractor.commitment_phrases must be an array");
      config.extractor.commitment_phrases = arr
        .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
        .filter((v) => v.length > 0);
    }
    const og = extractor.owner_groups as Record<string, unknown> | undefined;
    if (og && typeof og === "object") {
      for (const key of ["self", "client", "parking_lot_markers"] as const) {
        const arr = og[key];
        if (arr === undefined) continue;
        if (!Array.isArray(arr)) throw new Error(`extractor.owner_groups.${key} must be an array`);
        config.extractor.owner_groups[key] = arr
          .map((v) => (typeof v === "string" ? v.trim() : ""))
          .filter((v) => v.length > 0);
      }
    }
  }

  return config;
}
