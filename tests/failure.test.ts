import { describe, expect, it } from "vitest";
import {
  FAILURE_TERMS_MAX,
  FAILURE_TEXT_MAX_CHARS,
  failureLookup,
  failureSignature,
} from "../src/failure";
import { FAKE_SECRETS } from "./fixtures/secrets";

const ESCAPE = String.fromCharCode(0x1b);
const OVERSIZED_ERROR_CHARS = 600;
const CANDIDATE_CODES = 40;

function codeNumbered(index: number): string {
  return `ECODE${String(index).padStart(2, "0")}`;
}

describe("failureSignature", () => {
  it.each([
    {
      termClass: "class names ending in Error, Exception and Warning",
      error:
        "Exit code 1\nTypeError: Cannot read properties of undefined\njava.lang.IllegalStateException: closed\nDeprecationWarning: Buffer() is deprecated",
      terms: ["TypeError", "IllegalStateException", "DeprecationWarning"],
    },
    {
      termClass: "upper-case codes, each kept once",
      error:
        "Exit code 1\nError: ENOENT: no such file or directory\nENOENT again\nSQLITE_BUSY: database is locked\nconnect ECONNREFUSED 127.0.0.1:5432\nnpm error code E401",
      terms: ["ENOENT", "SQLITE_BUSY", "ECONNREFUSED", "E401"],
    },
    {
      termClass: "the module name after Cannot find module",
      error: "Exit code 1\nError: Cannot find module 'express'",
      terms: ["express"],
    },
    {
      termClass: "the module name after No module named",
      error: "Exit code 1\nModuleNotFoundError: No module named 'requests'",
      terms: ["ModuleNotFoundError", "requests"],
    },
    {
      termClass: "the module name after could not resolve, in any case",
      error: 'Exit code 1\nX [ERROR] Could not resolve "@vueuse/core"',
      terms: ["@vueuse/core"],
    },
    {
      termClass: "the basename of a relative path",
      error: "Exit code 1\nerror: cannot open ./scripts/seed.ts",
      terms: ["seed.ts"],
    },
  ])("extracts $termClass", ({ error, terms }) => {
    expect(failureSignature(error).terms).toEqual(terms);
  });

  it.each([
    {
      noiseClass: "the Exit code line, read as the exit code",
      error: "Exit code 127\n",
      exitCode: 127,
      terms: [],
    },
    {
      noiseClass: "the absolute path prefix",
      error: 'Exit code 1\n  File "/Users/dev/billing/app/tax.py", line 42, in total',
      exitCode: 1,
      terms: ["tax.py"],
    },
    {
      noiseClass: "a :line:col suffix",
      error: "Exit code 1\n    at render (/app/src/server.ts:42:17)",
      exitCode: 1,
      terms: ["server.ts"],
    },
    {
      noiseClass: "hex runs of 7 or more, while 6 stay a code",
      error: "Exit code 139\nsegfault at DEADBEEF00 in E3B0C4",
      exitCode: 139,
      terms: ["E3B0C4"],
    },
    {
      noiseClass: "durations",
      error: "Exit code 1\nTimeoutError: navigation timeout of 30000 ms exceeded after 31.2s",
      exitCode: 1,
      terms: ["TimeoutError"],
    },
    {
      noiseClass: "ISO timestamps",
      error: "Exit code 1\n2026-10-20T12:34:56.789Z TypeError: boom at 2026-10-20T12:34:57+02:00",
      exitCode: 1,
      terms: ["TypeError"],
    },
    {
      noiseClass: "ANSI sequences around a class name",
      error: `Exit code 1\n${ESCAPE}[31mTypeError${ESCAPE}[0m: boom`,
      exitCode: 1,
      terms: ["TypeError"],
    },
    {
      noiseClass: "generic status words",
      error: "Exit code 1\nFAIL tests/a.test.ts\nPASS tests/b.test.ts\nnpm ERR! FATAL ERROR FAILED",
      exitCode: 1,
      terms: [],
    },
    {
      noiseClass: "the empty basename of a run of slashes",
      error: "Exit code 1\nDSN: postgresql://billing:hunter2pass@db:5432/billing",
      exitCode: 1,
      terms: ["DSN", "billing"],
    },
    {
      noiseClass: "pytest section headers",
      error: "Exit code 1\n==== ERRORS ====\n==== FAILURES ====\nE   KeyError: 'vat'",
      exitCode: 1,
      terms: ["KeyError"],
    },
    {
      noiseClass: "the marker left where a secret was redacted",
      error: "Exit code 1\nAuthorization: Bearer abcdefghijklmnop1234 rejected",
      exitCode: 1,
      terms: [],
    },
  ])("drops $noiseClass", ({ error, exitCode, terms }) => {
    expect(failureSignature(error)).toEqual({ exitCode, terms });
  });

  it("takes terms from the first 500 characters only", () => {
    const kept = "EKEPT1";
    const head = `${" ".repeat(FAILURE_TEXT_MAX_CHARS - kept.length)}${kept}`;
    const error = `${head}ECUT01${" ".repeat(OVERSIZED_ERROR_CHARS - head.length - 6)}`;

    expect(error).toHaveLength(OVERSIZED_ERROR_CHARS);
    expect(failureSignature(error).terms).toEqual([kept]);
  });

  it("keeps the first 32 of 40 candidate terms", () => {
    const codes = Array.from({ length: CANDIDATE_CODES }, (_, index) => codeNumbered(index));

    expect(failureSignature(`Exit code 1\n${codes.join(" ")}`).terms).toEqual(
      codes.slice(0, FAILURE_TERMS_MAX),
    );
  });

  it.each(Object.entries(FAKE_SECRETS))(
    "leaves no part of the %s secret in the terms",
    (_name, secret) => {
      const error = `Exit code 1\nrequest with ${secret} failed: ECONNRESET`;

      expect(failureSignature(error).terms).toEqual(["ECONNRESET"]);
    },
  );
});

describe("failureLookup", () => {
  it("abstains when the error holds no signature term", () => {
    expect(failureLookup(failureSignature("Exit code 1\nassert 1 == 2"))).toBeUndefined();
  });

  it("matches the terms as anchors and their content words against the keys", () => {
    expect(failureLookup({ exitCode: 1, terms: ["SQLITE_BUSY", "tax.py"] })).toEqual({
      anchors: ["SQLITE_BUSY", "tax.py"],
      tokens: ["sqlite", "busy", "tax", "py"],
    });
  });
});
