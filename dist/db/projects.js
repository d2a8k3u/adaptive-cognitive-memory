"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recallEnabled = recallEnabled;
exports.setRecallEnabled = setRecallEnabled;
function recallEnabled(db, projectId) {
    const row = db
        .prepare("SELECT recall_enabled AS enabled FROM project_settings WHERE project_id = ?")
        .get(projectId);
    return row === undefined || row.enabled === 1;
}
function setRecallEnabled(db, projectId, enabled, at) {
    db.prepare(`INSERT INTO project_settings (project_id, recall_enabled, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET recall_enabled = excluded.recall_enabled,
       updated_at = excluded.updated_at`).run(projectId, enabled ? 1 : 0, at);
}
