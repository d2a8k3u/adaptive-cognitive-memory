import type { Db } from "./database";

export function recallEnabled(db: Db, projectId: string): boolean {
  const row = db
    .prepare("SELECT recall_enabled AS enabled FROM project_settings WHERE project_id = ?")
    .get(projectId) as { enabled: number } | undefined;
  return row === undefined || row.enabled === 1;
}

export function setRecallEnabled(db: Db, projectId: string, enabled: boolean, at: string): void {
  db.prepare(
    `INSERT INTO project_settings (project_id, recall_enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET recall_enabled = excluded.recall_enabled,
       updated_at = excluded.updated_at`,
  ).run(projectId, enabled ? 1 : 0, at);
}
