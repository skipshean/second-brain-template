import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from "fs";
import { basename, extname, join } from "path";
import { createHash } from "crypto";
import type { RouterConfig } from "../config/types.js";
import { logAudit } from "../audit/log.js";
import type { SourceName } from "../normalize/note.js";
import type { SourceInput } from "../sources/types.js";
import { firefliesAdapter } from "../sources/fireflies.js";
import { granolaAdapter } from "../sources/granola.js";
import { executeNote } from "./execute.js";

export type UploadsWatcherOptions = {
  workspaceRoot: string;
  config: RouterConfig;
  dryRun: boolean;
  apiKey?: string;
  uploadsDir?: string;
  pollIntervalMs?: number;
};

export type UploadsWatcherHandle = {
  active: boolean;
  stop(): Promise<void>;
};

export function determineUploadSuccess(input: {
  hasProject: boolean;
  hasPeople: boolean;
  linearAction: string;
  linearReason: string;
}): boolean {
  const skipBecauseNoAssignee = input.linearAction === "skip" && /no assignee signal/i.test(input.linearReason);
  const skipBecauseNoLinearConfigured =
    input.linearAction === "skip" && /LINEAR_API_KEY is not set/i.test(input.linearReason);
  return (
    input.hasProject &&
    input.hasPeople &&
    (input.linearAction !== "skip" || skipBecauseNoAssignee || skipBecauseNoLinearConfigured)
  );
}

export function buildDeterministicUploadId(source: SourceName, fileName: string, body: string): string {
  const digest = createHash("sha256")
    .update(`${source}\n${fileName}\n${body}`)
    .digest("hex")
    .slice(0, 16);
  const safeName = fileName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `upload-${safeName || "file"}-${digest}`;
}

export async function startUploadsWatcher(options: UploadsWatcherOptions): Promise<UploadsWatcherHandle> {
  const uploadsDir = options.uploadsDir ?? join(options.workspaceRoot, "uploads");
  const successfulDir = join(uploadsDir, "successful");
  const unsuccessfulDir = join(uploadsDir, "unsuccessful");
  const uploadLogsDir = join(options.workspaceRoot, "outputs/ai-note-router/uploads");

  ensureDirectory(uploadsDir);
  ensureDirectory(successfulDir);
  ensureDirectory(unsuccessfulDir);
  ensureDirectory(uploadLogsDir);

  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  let stopped = false;
  let scanning = false;
  let rescanRequested = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const scheduleScan = (): void => {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void scan();
    }, 250);
  };

  const scan = async (): Promise<void> => {
    if (stopped) return;
    if (scanning) {
      rescanRequested = true;
      return;
    }

    scanning = true;
    try {
      const files = listUploadFiles(uploadsDir);
      for (const filePath of files) {
        if (stopped) break;
        await processUploadFile(filePath, {
          workspaceRoot: options.workspaceRoot,
          config: options.config,
          dryRun: options.dryRun,
          successfulDir,
          unsuccessfulDir,
          uploadLogsDir,
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        });
      }
    } finally {
      scanning = false;
      if (rescanRequested && !stopped) {
        rescanRequested = false;
        await scan();
      }
    }
  };

  logAudit({
    timestamp: new Date().toISOString(),
    stage: "uploads-watch",
    message: "Uploads watcher started",
    payload: { uploadsDir, successfulDir, unsuccessfulDir },
  });

  const watcher = watch(uploadsDir, { persistent: true }, () => {
    scheduleScan();
  });

  const interval = setInterval(() => {
    scheduleScan();
  }, pollIntervalMs);

  await scan();

  return {
    active: true,
    stop: async () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(interval);
      watcher.close();
    },
  };
}

async function processUploadFile(
  filePath: string,
  options: {
    workspaceRoot: string;
    config: RouterConfig;
    dryRun: boolean;
    apiKey?: string;
    successfulDir: string;
    unsuccessfulDir: string;
    uploadLogsDir: string;
  }
): Promise<void> {
  const fileName = basename(filePath);
  const source = inferSourceFromFileName(fileName);
  const raw = readFileSync(filePath, "utf8");
  const body = raw.trim();

  if (!body) {
    moveToBucket(filePath, options.unsuccessfulDir, options.dryRun);
    writeUploadAuditLog(options.uploadLogsDir, {
      sourceFilePath: filePath,
      success: false,
      destinationDir: options.unsuccessfulDir,
      routeTeam: null,
      routeProject: null,
      routeReason: "empty_upload_file",
      peopleCount: 0,
      linearAction: "skip",
    });
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "uploads-watch",
      message: "Moved empty upload file to unsuccessful",
      payload: { filePath },
    });
    return;
  }

  const input = buildSourceInputFromFile(filePath, body, source);
  const adapterContext = { extractor: options.config.extractor };
  const note = source === "granola" ? granolaAdapter.load(input, adapterContext) : firefliesAdapter.load(input, adapterContext);

  try {
    const execution = await executeNote(note, options.config, {
      workspaceRoot: options.workspaceRoot,
      dryRun: options.dryRun,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    });

    const hasProject = Boolean(execution.result.route.project);
    const hasPeople = execution.result.note.people.length > 0;
    const linearAction = execution.linearResult?.action ?? "skip";
    const linearReason = execution.linearResult?.reason ?? "";
    // Team can remain unresolved for personal vault captures; success depends on
    // route/participants and whether Linear was intentionally skipped.
    const success = determineUploadSuccess({
      hasProject,
      hasPeople,
      linearAction,
      linearReason,
    });

    const destinationDir = success ? options.successfulDir : options.unsuccessfulDir;
    moveToBucket(filePath, destinationDir, options.dryRun);

    logAudit({
      timestamp: new Date().toISOString(),
      stage: "uploads-watch",
      message: success ? "Processed upload file successfully" : "Processed upload file with missing route context",
      payload: {
        filePath,
        destinationDir,
        success,
        route: execution.result.route,
        peopleCount: execution.result.note.people.length,
        linearAction,
        linearReason,
      },
    });
    writeUploadAuditLog(options.uploadLogsDir, {
      sourceFilePath: filePath,
      success,
      destinationDir,
      routeTeam: execution.result.route.team,
      routeProject: execution.result.route.project,
      routeReason: execution.result.route.reason,
      peopleCount: execution.result.note.people.length,
      linearAction,
      linearReason,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    moveToBucket(filePath, options.unsuccessfulDir, options.dryRun);
    writeUploadAuditLog(options.uploadLogsDir, {
      sourceFilePath: filePath,
      success: false,
      destinationDir: options.unsuccessfulDir,
      routeTeam: null,
      routeProject: null,
      routeReason: "processing_error",
      peopleCount: 0,
      linearAction: "skip",
      error: errorMessage,
    });
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "uploads-watch",
      message: "Failed processing upload file; moved to unsuccessful",
      payload: {
        filePath,
        error: errorMessage,
      },
    });
  }
}

function moveToBucket(filePath: string, targetDir: string, dryRun: boolean): void {
  if (dryRun) return;
  const fileName = basename(filePath);
  const targetPath = uniquePath(join(targetDir, fileName));
  renameSync(filePath, targetPath);
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const extension = extname(path);
  const stem = path.slice(0, path.length - extension.length);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stem}-${stamp}${extension}`;
}

function listUploadFiles(uploadsDir: string): string[] {
  if (!existsSync(uploadsDir)) return [];
  return readdirSync(uploadsDir)
    .map((name) => join(uploadsDir, name))
    .filter((path) => {
      const fileStat = statSync(path);
      if (!fileStat.isFile()) return false;
      const lower = extname(path).toLowerCase();
      return lower === ".txt" || lower === ".md";
    })
    .sort();
}

function inferSourceFromFileName(fileName: string): SourceName {
  const lower = fileName.toLowerCase();
  if (lower.includes("granola")) return "granola";
  return "fireflies";
}

function buildSourceInputFromFile(filePath: string, body: string, source: SourceName): SourceInput {
  const fileName = basename(filePath);
  const title = inferTitleFromContent(body, fileName);
  const people = inferPeopleFromContent(body);

  return {
    source,
    id: buildDeterministicUploadId(source, fileName, body),
    url: `upload://${encodeURIComponent(fileName)}`,
    title,
    body,
    ...(people.length > 0 ? { people: people.map((name) => ({ name })) } : {}),
  };
}

function inferTitleFromContent(content: string, fileName: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fromHeader = lines.find((line) => /^meeting title\s*:/i.test(line));
  if (fromHeader) {
    const value = fromHeader.replace(/^meeting title\s*:/i, "").trim();
    if (value) return value;
  }
  const first = lines[0];
  if (first) return first.length > 120 ? `${first.slice(0, 117)}...` : first;
  return fileName.replace(/\.[^.]+$/, "");
}

function inferPeopleFromContent(content: string): string[] {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const maxHeaderScanLines = Math.min(lines.length, 40);
  const names = new Set<string>();

  for (let i = 0; i < maxHeaderScanLines; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const match = line.match(/^(meeting participants?|participants?|attendees?)\s*:\s*(.+)$/i);
    if (!match) continue;

    const rawList = match[2] ?? "";
    const candidates = rawList
      .split(/,|;|\band\b/gi)
      .map((value) => value.trim())
      .map((value) => value.replace(/\s*\([^)]*\)\s*$/g, "").trim())
      .filter(Boolean)
      .filter((value) => value.length > 1)
      .filter((value) => !/^me|them|speaker \d+|unknown$/i.test(value));

    for (const candidate of candidates) {
      if (!/[a-z]/i.test(candidate)) continue;
      names.add(candidate);
    }
  }

  return Array.from(names);
}

function ensureDirectory(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}

function writeUploadAuditLog(
  uploadLogsDir: string,
  details: {
    sourceFilePath: string;
    success: boolean;
    destinationDir: string;
    routeTeam: string | null;
    routeProject: string | null;
    routeReason: string;
    peopleCount: number;
    linearAction: string;
    linearReason?: string;
    error?: string;
  }
): void {
  ensureDirectory(uploadLogsDir);
  const fileName = basename(details.sourceFilePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(uploadLogsDir, `${stamp}-${fileName}.md`);
  const lines = [
    "# Upload Processing Audit",
    "",
    `- Timestamp: ${new Date().toISOString()}`,
    `- Source file: ${details.sourceFilePath}`,
    `- Result: ${details.success ? "successful" : "unsuccessful"}`,
    `- Destination: ${details.destinationDir}`,
    `- Team: ${details.routeTeam ?? "unassigned"}`,
    `- Project: ${details.routeProject ?? "unassigned"}`,
    `- Route reason: ${details.routeReason}`,
    `- People count: ${details.peopleCount}`,
    `- Linear action: ${details.linearAction}`,
    ...(details.linearReason ? [`- Linear reason: ${details.linearReason}`] : []),
    ...(details.error ? [`- Error: ${details.error}`] : []),
    "",
  ];
  writeFileSync(logPath, lines.join("\n"), "utf8");
}
