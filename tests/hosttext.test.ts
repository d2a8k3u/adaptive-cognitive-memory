import { describe, expect, it } from "vitest";
import { checkpoint, type OpenSignal } from "../src/capture";
import { type HostId, hostProfile } from "../src/host";
import { routingLine } from "../src/session";
import { hostToolName } from "../src/toolnames";
import { TOOL_DEFINITIONS } from "../src/tools";

interface ToolMention {
  readonly host: HostId | undefined;
  readonly tool: string;
}

const HOSTS: readonly HostId[] = ["claude", "codex", "opencode"];
const QUALIFIED_FORMS: readonly { readonly host: HostId; readonly pattern: RegExp }[] = [
  { host: "claude", pattern: /^mcp__plugin_adaptive-cognitive-memory_memory__(.+)$/ },
  { host: "codex", pattern: /^mcp__memory__(.+)$/ },
  { host: "opencode", pattern: /^memory_(memory_.+)$/ },
];
const BARE_TOOL_PREFIX = "memory_";
const WHOLE_TOKEN = /[\w-]+/g;
const SERVER_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.map(({ name }) => name));
const OPEN_SIGNALS: readonly OpenSignal[] = [{ id: 1, kind: "remember", detail: "use pnpm" }];

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

function emittedTexts(host: HostId): string[] {
  const profile = hostProfile(host);
  return [
    checkpoint(OPEN_SIGNALS, false, hostToolName(host, "memory_store"))!.text,
    routingLine(profile.nativeAutoMemory),
  ];
}

describe("host-facing texts", () => {
  it.each(HOSTS)("name every memory tool in %s texts in the form that host reports", (host) => {
    const mentions = emittedTexts(host).flatMap(toolMentions);

    expect(mentions).toContainEqual({ host, tool: "memory_store" });
    expect(
      mentions.filter(
        (mention) =>
          (mention.host !== undefined && mention.host !== host) ||
          !SERVER_TOOL_NAMES.has(mention.tool),
      ),
    ).toEqual([]);
  });
});
