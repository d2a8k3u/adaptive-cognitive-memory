import { describe, expect, it } from "vitest";
import { hostProfile } from "../src/host";
import { storageOutage } from "../src/outage";

const CLAUDE_DEPENDENCY_FIX = hostProfile("claude").dependencyFix;

function missing(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("storageOutage", () => {
  it.each([
    {
      name: "a CommonJS require of a missing package",
      error: missing(
        "MODULE_NOT_FOUND",
        "Cannot find module 'better-sqlite3'\nRequire stack:\n- x",
      ),
      missingPackage: "better-sqlite3",
    },
    {
      name: "an ESM import of a missing scoped package",
      error: missing(
        "ERR_MODULE_NOT_FOUND",
        "Cannot find package '@huggingface/transformers' imported from /plugin/dist/embeddings.js",
      ),
      missingPackage: "@huggingface/transformers",
    },
    {
      name: "a missing subpath of a package",
      error: missing(
        "MODULE_NOT_FOUND",
        "Cannot find module '@modelcontextprotocol/sdk/server/index.js'",
      ),
      missingPackage: "@modelcontextprotocol/sdk",
    },
  ])("reports $name as missing npm dependencies", ({ error, missingPackage }) => {
    expect(storageOutage(error, CLAUDE_DEPENDENCY_FIX)?.cause).toBe(
      `the plugin's npm dependencies are not installed (missing ${missingPackage})`,
    );
  });

  it.each([
    missing("MODULE_NOT_FOUND", "Cannot find module './db/database.js'"),
    missing("MODULE_NOT_FOUND", "Cannot find module '/plugin/dist/search.js'"),
    missing("ENOENT", "Cannot find module 'better-sqlite3'"),
  ])("leaves a broken build or another failure to the defect report: %s", (error) => {
    expect(storageOutage(error, CLAUDE_DEPENDENCY_FIX)).toBeUndefined();
  });
});
