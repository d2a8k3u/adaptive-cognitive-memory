export const RECALL_EVENTS_KEPT = 10_000;
export const SESSION_HISTORY_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

export function daysBefore(at: string, days: number): string {
  return new Date(Date.parse(at) - days * DAY_MS).toISOString();
}
