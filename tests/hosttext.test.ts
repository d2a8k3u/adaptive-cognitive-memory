import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpoint, type OpenSignal } from "../src/capture";
import { runDoctor } from "../src/doctor";
import type { RecalledMemory } from "../src/gate";
import { type HostId, hostProfile } from "../src/host";
import { hostOutput } from "../src/hosts/output";
import { renderInjection } from "../src/inject";
import { modelNotice } from "../src/modeldownload";
import { sessionNotice, storageOutage } from "../src/outage";
import { routingLine } from "../src/session";
import { hostToolName } from "../src/toolnames";
import { TOOL_DEFINITIONS } from "../src/tools";
import { PLUGIN_ROOT } from "../src/version";

interface ToolMention {
  readonly host: HostId | undefined;
  readonly tool: string;
}

interface HostTexts {
  readonly sessionStart: string;
  readonly checkpoint: string;
  readonly routing: string;
  readonly modelDownload: string;
  readonly outage: string;
  readonly doctor: string;
}

const HOSTS: readonly HostId[] = ["claude", "codex", "opencode"];
const HOSTS_WITHOUT_CLAUDE_COMMANDS = ["codex", "opencode"] as const;
const QUALIFIED_FORMS: readonly { readonly host: HostId; readonly pattern: RegExp }[] = [
  { host: "claude", pattern: /^mcp__plugin_adaptive-cognitive-memory_memory__(.+)$/ },
  { host: "codex", pattern: /^mcp__memory__(.+)$/ },
  { host: "opencode", pattern: /^memory_(memory_.+)$/ },
];
const BARE_TOOL_PREFIX = "memory_";
const WHOLE_TOKEN = /[\w-]+/g;
const CLAUDE_COMMAND = /\/memory-|claude plugin/;
const SERVER_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.map(({ name }) => name));
const OPEN_SIGNALS: readonly OpenSignal[] = [{ id: 1, kind: "remember", detail: "use pnpm" }];
const RECALLED: RecalledMemory = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  kind: "fact",
  epistemic: "verified",
  scope: "project",
  abstract: "the billing service deploys with make release",
  validFrom: "2026-10-13T09:30:00.000Z",
};
const BUDGET_TOKENS = 1200;
const MISSING_DEPENDENCY = Object.assign(new Error("Cannot find module 'better-sqlite3'"), {
  code: "MODULE_NOT_FOUND",
});

function qualifiedMention(token: string): ToolMention | undefined {
  for (const { host, pattern } of QUALIFIED_FORMS) {
    const tool = pattern.exec(token)?.[1];
    if (tool !== undefined) {
      return { host, tool };
    }
  }
  return undefined;
}

function toolMentions(text: string): ToolMention[] {
  return (text.match(WHOLE_TOKEN) ?? []).flatMap((token) => {
    const qualified = qualifiedMention(token);
    if (qualified !== undefined) {
      return [qualified];
    }
    return token.startsWith(BARE_TOOL_PREFIX) ? [{ host: undefined, tool: token }] : [];
  });
}

function doctorTexts(host: HostId): string {
  const root = mkdtempSync(join(tmpdir(), "acm-hosttext-doctor-"));
  const configDir = join(root, "claude");
  const dataDirInPluginData = join(configDir, "plugins", "data", "adaptive-cognitive-memory");
  const emptyModelCache = join(root, "models");
  mkdirSync(dataDirInPluginData, { recursive: true });
  const report = runDoctor(
    {
      ACM_HOST: host,
      ACM_DATA_DIR: dataDirInPluginData,
      ACM_MODEL_CACHE_DIR: emptyModelCache,
      CLAUDE_CONFIG_DIR: configDir,
    },
    root,
  );
  return report.checks.flatMap(({ detail, fix }) => [detail, fix]).join("\n");
}

function emittedTexts(host: HostId): HostTexts {
  const profile = hostProfile(host);
  return {
    sessionStart: renderInjection([RECALLED], BUDGET_TOKENS, profile.doctorInstruction, {
      model: true,
    }).text,
    checkpoint: checkpoint(OPEN_SIGNALS, false, hostToolName(host, "memory_store"))!.text,
    routing: routingLine(profile.nativeAutoMemory),
    modelDownload: modelNotice("download-off", undefined, profile.doctorInstruction)!,
    outage: sessionNotice(storageOutage(MISSING_DEPENDENCY, profile.dependencyFix)!),
    doctor: doctorTexts(host),
  };
}

function misnamedMentions(mentions: readonly ToolMention[], host: HostId): ToolMention[] {
  return mentions.filter(
    (mention) =>
      (mention.host !== undefined && mention.host !== host) || !SERVER_TOOL_NAMES.has(mention.tool),
  );
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return typeof value === "object" && value !== null
    ? Object.values(value).flatMap(stringLeaves)
    : [];
}

function codexHookStdouts(texts: HostTexts): (string | undefined)[] {
  return [
    hostOutput("codex", "SessionStart", [{ context: texts.sessionStart, notice: texts.outage }]),
    hostOutput("codex", "SessionStart", [{ context: "", notice: texts.modelDownload }]),
    hostOutput("codex", "Stop", [{ context: texts.checkpoint }]),
  ];
}

describe("host-facing texts", () => {
  it.each(HOSTS)("name every memory tool in %s texts in the form that host reports", (host) => {
    const mentions = Object.values(emittedTexts(host)).flatMap(toolMentions);

    expect(mentions).toContainEqual({ host, tool: "memory_store" });
    expect(misnamedMentions(mentions, host)).toEqual([]);
  });

  it("keep the Codex form in the session start, outage, model download and checkpoint stdout a Codex hook prints", () => {
    const mentions = codexHookStdouts(emittedTexts("codex"))
      .flatMap((stdout) => stringLeaves(stdout === undefined ? undefined : JSON.parse(stdout)))
      .flatMap(toolMentions);

    expect(mentions).toContainEqual({ host: "codex", tool: "memory_store" });
    expect(mentions).toContainEqual({ host: undefined, tool: "memory_feedback" });
    expect(misnamedMentions(mentions, "codex")).toEqual([]);
  });

  it.each(HOSTS_WITHOUT_CLAUDE_COMMANDS)(
    "send %s to the plugin CLI under its own host id, never to a Claude command",
    (host) => {
      const texts = emittedTexts(host);
      const doctorCommand = `ACM_HOST=${host} node "${PLUGIN_ROOT}/dist/cli.js" doctor`;

      expect(Object.values(texts).join("\n")).not.toMatch(CLAUDE_COMMAND);
      expect(texts.sessionStart).toContain(`run ${doctorCommand}`);
      expect(texts.modelDownload).toContain(`run ${doctorCommand} for the one-time model-init`);
      expect(texts.outage).toContain(`Fix: npm ci --ignore-scripts --omit=dev in ${PLUGIN_ROOT}.`);
      expect(texts.doctor).toContain("export <file>, and move the database out of");
    },
  );
});
