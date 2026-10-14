import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { redact, redactWithin } from "../src/redact";
import { redactionSamples } from "./eval/fixtures";
import { FAKE_SECRETS } from "./fixtures/secrets";

const PATTERN_CASES = [
  {
    name: "aws access key",
    input: `stage key ${FAKE_SECRETS.awsAccessKeyId} rotate`,
    expected: "stage key [REDACTED] rotate",
  },
  {
    name: "anthropic key",
    input: `use ${FAKE_SECRETS.anthropicKey} here`,
    expected: "use [REDACTED] here",
  },
  {
    name: "generic sk key",
    input: "openai sk-abcdefgh12345678 expired",
    expected: "openai [REDACTED] expired",
  },
  {
    name: "github token",
    input: `ci ${FAKE_SECRETS.githubClassicShort} runs`,
    expected: "ci [REDACTED] runs",
  },
  {
    name: "bearer token keeps label",
    input: "Authorization: Bearer AbC123.def456-ghi_789 ok",
    expected: "Authorization: Bearer [REDACTED] ok",
  },
  {
    name: "private key block",
    input: FAKE_SECRETS.rsaPrivateKeyBlock,
    expected: "[REDACTED]",
  },
  {
    name: "labeled secret keeps label and separator",
    input: "db password=hunter2123 here",
    expected: "db password=[REDACTED] here",
  },
  {
    name: "url credentials keep scheme and host",
    input: "connect postgres://admin:hunter2123@db.internal:5432/app",
    expected: "connect postgres://[REDACTED]@db.internal:5432/app",
  },
  {
    name: "jwt",
    input:
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c ends",
    expected: "jwt [REDACTED] ends",
  },
];

describe("redactWithin", () => {
  it.each([
    {
      name: "keeps text whose redaction ends exactly at the limit",
      text: `${"a".repeat(180)} password=abcdefgh`,
      expected: `${"a".repeat(180)} password=[REDACTED]`,
    },
    {
      name: "cuts text whose redaction ends one past the limit",
      text: `${"a".repeat(181)} password=abcdefgh`,
      expected: `${"a".repeat(181)} password=[REDACTED`,
    },
    {
      name: "drops a character whose surrogate pair the limit would split",
      text: `password=abcdefgh ${"a".repeat(179)}😀`,
      expected: `password=[REDACTED] ${"a".repeat(179)}`,
    },
  ])("$name", ({ text, expected }) => {
    expect(redactWithin(text, 200)).toBe(expected);
  });
});

describe("redact", () => {
  it("redacts every secret pattern class to the exact expected text", () => {
    for (const testCase of PATTERN_CASES) {
      const result = redact(testCase.input);
      expect(result.text, testCase.name).toBe(testCase.expected);
    }
  });

  it("redacts unlabeled modern sk- keys with dashes (sk-proj-, sk-svcacct-)", () => {
    const modernKeys = [
      {
        input: `openai ${FAKE_SECRETS.openaiProjectKey} expired`,
        expected: "openai [REDACTED] expired",
      },
      { input: "openai sk-svcacct-abcdefghij12345678 done", expected: "openai [REDACTED] done" },
    ];
    for (const { input, expected } of modernKeys) {
      const result = redact(input);
      expect(result.text, input).toBe(expected);
      expect(result.found, input).toEqual([{ pattern: "api_key", count: 1 }]);
    }
  });

  it("leaves sk- inside prose words untouched via the boundary guard", () => {
    const prose = redact("task-based-authorization-flows and task-ant-delegation-rules stay");
    expect(prose.text).toBe("task-based-authorization-flows and task-ant-delegation-rules stay");
    expect(prose.found).toEqual([]);
  });

  it("names sk-ant keys anthropic_key, not api_key, under the fixed pattern order", () => {
    const result = redact(`use ${FAKE_SECRETS.anthropicKey} here`);
    expect(result.text).toBe("use [REDACTED] here");
    expect(result.found).toEqual([{ pattern: "anthropic_key", count: 1 }]);
  });

  it("reports pattern names and counts only, never matched text", () => {
    const result = redact(
      `${FAKE_SECRETS.awsAccessKeyId} then ${FAKE_SECRETS.awsAccessKeyIdNeighbour} and sk-abcdefgh12345678 and api_key: zzz999yyy888www`,
    );
    expect(result.text).toBe("[REDACTED] then [REDACTED] and [REDACTED] and api_key: [REDACTED]");
    expect(result.found).toEqual([
      { pattern: "aws_access_key", count: 2 },
      { pattern: "api_key", count: 1 },
      { pattern: "labeled_secret", count: 1 },
    ]);
    const serialized = JSON.stringify(result.found);
    expect(serialized).not.toContain(FAKE_SECRETS.awsAccessKeyId);
    expect(serialized).not.toContain("abcdefgh12345678");
    expect(serialized).not.toContain("zzz999yyy888www");
  });

  it("is idempotent so re-running on update inputs does not recount placeholders", () => {
    const first = redact("db password=hunter2123");
    expect(first.text).toBe("db password=[REDACTED]");
    expect(first.found).toEqual([{ pattern: "labeled_secret", count: 1 }]);

    const second = redact(first.text);
    expect(second.text).toBe(first.text);
    expect(second.found).toEqual([]);
  });

  it("redacts labeled values at the 8-char minimum and keeps 7-char values", () => {
    const redacted = redact("token=12345678");
    expect(redacted.text).toBe("token=[REDACTED]");
    expect(redacted.found).toEqual([{ pattern: "labeled_secret", count: 1 }]);

    const untouched = redact("token=1234567");
    expect(untouched.text).toBe("token=1234567");
    expect(untouched.found).toEqual([]);
  });

  it("redacts unlabeled fine-grained github_pat tokens", () => {
    const token = FAKE_SECRETS.githubFineGrained;
    const result = redact(`ci ${token} runs`);
    expect(result.text).toBe("ci [REDACTED] runs");
    expect(result.found).toEqual([{ pattern: "github_pat", count: 1 }]);
    expect(JSON.stringify(result.found)).not.toContain(token);
  });

  it("redacts labeled secrets with word suffixes before the separator (secret_key:)", () => {
    const result = redact(`stripe secret_key: ${FAKE_SECRETS.stripeLive}`);
    expect(result.text).toBe("stripe secret_key: [REDACTED]");
    expect(result.found).toEqual([{ pattern: "labeled_secret", count: 1 }]);
    const rerun = redact(result.text);
    expect(rerun.text).toBe(result.text);
    expect(rerun.found).toEqual([]);
  });

  it("redacts quoted bearer values including the quotes", () => {
    const doubleQuoted = redact('Authorization: Bearer "AbC123.def456-ghi_789" ok');
    expect(doubleQuoted.text).toBe("Authorization: Bearer [REDACTED] ok");
    expect(doubleQuoted.found).toEqual([{ pattern: "bearer_token", count: 1 }]);
    const singleQuoted = redact("auth Bearer 'AbC123.def456-ghi_789' ok");
    expect(singleQuoted.text).toBe("auth Bearer [REDACTED] ok");
    expect(singleQuoted.found).toEqual([{ pattern: "bearer_token", count: 1 }]);
  });

  it("leaves quoted bearer values below the 16-char minimum untouched", () => {
    const result = redact('Authorization: Bearer "abc123" ok');
    expect(result.text).toBe('Authorization: Bearer "abc123" ok');
    expect(result.found).toEqual([]);
  });

  it("redacts jwts whose payload is not eyJ-prefixed (e30)", () => {
    const result = redact("jwt eyJhbGciOiJub25lIn0.e30.abc123def456 ends");
    expect(result.text).toBe("jwt [REDACTED] ends");
    expect(result.found).toEqual([{ pattern: "jwt", count: 1 }]);
  });

  it("redacts unsecured jwts with an empty signature", () => {
    const result = redact("jwt eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0. ends");
    expect(result.text).toBe("jwt [REDACTED] ends");
  });

  it("masks every secret of the synthetic redaction corpus", () => {
    const corpus = redactionSamples(join(process.cwd(), "tests", "fixtures", "eval"));
    const leaked = corpus
      .filter((sample) => redact(sample.text).text.includes(sample.secret))
      .map((sample) => sample.name);
    expect(leaked).toEqual([]);
  });

  it("redacts an aws secret access key after any label separator and keeps the label", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    for (const separator of [" ", " = ", ": ", "\t"]) {
      const result = redact(`cron aws_secret_access_key${separator}${secret} legacy`);
      expect(result.text, JSON.stringify(separator)).toBe(
        `cron aws_secret_access_key${separator}[REDACTED] legacy`,
      );
    }
    expect(redact(`AWS_SECRET_ACCESS_KEY ${secret}`).text).toBe("AWS_SECRET_ACCESS_KEY [REDACTED]");
  });

  it("redacts url credentials with an empty user part", () => {
    const result = redact("connect postgres://:hunter2123@db.internal:5432/app");
    expect(result.text).toBe("connect postgres://[REDACTED]@db.internal:5432/app");
    expect(result.found).toEqual([{ pattern: "url_credentials", count: 1 }]);
  });

  it("leaves urls without user-pass credentials untouched", () => {
    const plain = redact("see https://example.com/docs now");
    expect(plain.text).toBe("see https://example.com/docs now");
    expect(plain.found).toEqual([]);
    const hostPort = redact("connect postgres://db.internal:5432/app");
    expect(hostPort.text).toBe("connect postgres://db.internal:5432/app");
    expect(hostPort.found).toEqual([]);
  });

  it("leaves no secret in table, fts or wal after a store-shaped redacted insert", () => {
    const storeShapedSecrets = [
      { name: "aws_access_key", value: FAKE_SECRETS.awsAccessKeyId },
      { name: "github_pat", value: FAKE_SECRETS.githubFineGrained },
    ];
    for (const { name, value } of storeShapedSecrets) {
      const dir = mkdtempSync(join("/tmp", "cm-flow-WO-24-redact-"));
      const dbPath = join(dir, "memory.sqlite");
      const db = new Database(dbPath);
      try {
        db.pragma("journal_mode = WAL");
        db.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          abstract TEXT NOT NULL,
          content TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          title, abstract, content,
          content='memories', content_rowid='rowid', detail=full
        );
        CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, abstract, content)
          VALUES (new.rowid, new.title, new.abstract, new.content);
        END;
      `);
        const result = redact(`stage deploy key ${value} rotate soon`);
        expect(result.found, name).toEqual([{ pattern: name, count: 1 }]);

        db.prepare("INSERT INTO memories (title, abstract, content) VALUES (?, ?, ?)").run(
          "deploy notes",
          result.text,
          result.text,
        );

        const placeholderRows = db
          .prepare("SELECT count(*) AS n FROM memories WHERE content LIKE '%[REDACTED]%'")
          .get() as { n: number };
        expect(placeholderRows.n).toBe(1);

        const tableHits = db
          .prepare(
            "SELECT count(*) AS n FROM memories WHERE title LIKE ? OR abstract LIKE ? OR content LIKE ?",
          )
          .get(`%${value}%`, `%${value}%`, `%${value}%`) as { n: number };
        expect(tableHits.n).toBe(0);

        const ftsHits = db
          .prepare(
            "SELECT count(*) AS n FROM memories_fts WHERE title LIKE ? OR abstract LIKE ? OR content LIKE ?",
          )
          .get(`%${value}%`, `%${value}%`, `%${value}%`) as { n: number };
        expect(ftsHits.n).toBe(0);

        const walBytes = readFileSync(`${dbPath}-wal`);
        expect(walBytes.byteLength).toBeGreaterThan(0);
        for (const fileBytes of [readFileSync(dbPath), walBytes]) {
          expect(fileBytes.indexOf(value)).toBe(-1);
        }
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
