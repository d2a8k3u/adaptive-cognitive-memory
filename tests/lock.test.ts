import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type OpenedDb, openDatabase } from "../src/db/database";
import { type MemoryEnv, type StoreInput, store } from "../src/db/memories";
import { testModelCacheDir } from "../vitest.config";
import { seedConfig } from "./fixtures/seed";

const LOCK_REJECT_MIN_MS = 3500;
const LOCK_REJECT_MAX_MS = 9000;
const STORE_PROJECT_ID = "proj-lock";

function fact(title: string, content: string): StoreInput {
  return {
    title,
    content,
    type: "semantic",
    kind: "fact",
    conflictKey: "test.lock_verification",
    cardinality: "multi",
    valueText: "",
    keywords: "",
    anchors: [],
    scope: "project",
  };
}

describe("external exclusive lock (AC-23)", () => {
  it("store fails with a bounded explicit error and persists nothing", {
    timeout: 30_000,
  }, async () => {
    const pluginData = mkdtempSync(join(tmpdir(), "acm-lock-"));
    const config = seedConfig(pluginData, testModelCacheDir);
    const opened: OpenedDb = openDatabase(config);
    const env: MemoryEnv = {
      db: opened.db,
      vecLoaded: opened.vecLoaded,
      modelCacheDir: config.modelCacheDir,
    };
    const holder = new Database(config.dbPath, { fileMustExist: true });
    try {
      holder.exec("BEGIN EXCLUSIVE");

      const startedAt = performance.now();
      const lockedStore = store(
        env,
        fact(
          "locked out fact",
          "This store must not land while an external writer holds the exclusive lock.",
        ),
        STORE_PROJECT_ID,
      );
      await expect(lockedStore).rejects.toMatchObject({
        code: "SQLITE_BUSY",
        message: "database is locked",
      });
      const elapsedMs = performance.now() - startedAt;

      console.log(`AC-23 lock rejection after ${Math.round(elapsedMs)} ms (busy_timeout 5000)`);
      expect(elapsedMs).toBeGreaterThanOrEqual(LOCK_REJECT_MIN_MS);
      expect(elapsedMs).toBeLessThanOrEqual(LOCK_REJECT_MAX_MS);
      expect(opened.db.prepare("SELECT count(*) AS n FROM memories").get()).toEqual({ n: 0 });
      expect(opened.db.prepare("SELECT count(*) AS n FROM memories_vec").get()).toEqual({ n: 0 });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }

    const recovered = await store(
      env,
      fact("fact after release", "This store lands once the exclusive lock is gone."),
      STORE_PROJECT_ID,
    );
    expect(recovered).toEqual({
      outcome: "written",
      result: { id: expect.any(String), action: "created" },
    });
    expect(opened.db.prepare("SELECT count(*) AS n FROM memories").get()).toEqual({ n: 1 });
    opened.db.close();
  });
});
