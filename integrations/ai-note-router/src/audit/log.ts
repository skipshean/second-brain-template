export type AuditEvent = {
  timestamp: string;
  stage: string;
  message: string;
  payload?: Record<string, unknown>;
};

export function logAudit(event: AuditEvent): void {
  // One line per event (NDJSON). Pretty-printing made each event 5-10x larger in the launchd log.
  console.log(JSON.stringify(event));
}
