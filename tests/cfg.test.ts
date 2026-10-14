import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUDGET_MAX_TOKENS,
  BUDGET_MIN_TOKENS,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_PRETOOL_BUDGET_TOKENS,
  loadConfig,
} from "../src/cfg";

interface UserConfigOption {
  type: string;
  title: string;
  description: string;
  default: number;
  min: number;
  max: number;
}

const userConfig = (
  JSON.parse(readFileSync(join(process.cwd(), ".claude-plugin", "plugin.json"), "utf8")) as {
    userConfig: Record<string, UserConfigOption>;
  }
).userConfig;

function optionVariable(key: string): string {
  return `CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`;
}

describe("loadConfig", () => {
  it("throws naming CLAUDE_PLUGIN_DATA when it is missing or empty", () => {
    expect(() => loadConfig({})).toThrow(/CLAUDE_PLUGIN_DATA/);
    expect(() => loadConfig({ CLAUDE_PLUGIN_DATA: "" })).toThrow(/CLAUDE_PLUGIN_DATA/);
  });

  it("resolves defaults from CLAUDE_PLUGIN_DATA", () => {
    const config = loadConfig({ CLAUDE_PLUGIN_DATA: "/data" });
    expect(config).toEqual({
      pluginData: "/data",
      dbPath: join("/data", "memory.sqlite"),
      modelCacheDir: join("/data", "models"),
      budgetTokens: 1200,
      pretoolBudgetTokens: 300,
    });
  });

  it("resolves path overrides", () => {
    const config = loadConfig({
      CLAUDE_PLUGIN_DATA: "/data",
      ACM_DB_PATH: "/tmp/acm-test.sqlite",
      ACM_MODEL_CACHE_DIR: "/tmp/acm-models",
    });
    expect(config.dbPath).toBe("/tmp/acm-test.sqlite");
    expect(config.modelCacheDir).toBe("/tmp/acm-models");
  });

  it("reads each budget from the plugin option variable its userConfig key names", () => {
    const config = loadConfig({
      CLAUDE_PLUGIN_DATA: "/data",
      [optionVariable("recall_budget_tokens")]: "500",
      [optionVariable("pretool_budget_tokens")]: "100",
    });

    expect(Object.keys(userConfig).sort()).toEqual([
      "pretool_budget_tokens",
      "recall_budget_tokens",
    ]);
    expect([config.budgetTokens, config.pretoolBudgetTokens]).toEqual([500, 100]);
  });

  it("declares in plugin.json the defaults and bounds the config enforces", () => {
    expect(userConfig).toEqual({
      recall_budget_tokens: {
        type: "number",
        title: expect.any(String),
        description: expect.any(String),
        default: DEFAULT_BUDGET_TOKENS,
        min: BUDGET_MIN_TOKENS,
        max: BUDGET_MAX_TOKENS,
      },
      pretool_budget_tokens: {
        type: "number",
        title: expect.any(String),
        description: expect.any(String),
        default: DEFAULT_PRETOOL_BUDGET_TOKENS,
        min: BUDGET_MIN_TOKENS,
        max: BUDGET_MAX_TOKENS,
      },
    });
  });

  it.each([
    { value: String(BUDGET_MIN_TOKENS), accepted: true },
    { value: String(BUDGET_MAX_TOKENS), accepted: true },
    { value: String(BUDGET_MIN_TOKENS - 1), accepted: false },
    { value: String(BUDGET_MAX_TOKENS + 1), accepted: false },
    { value: "1200.5", accepted: false },
    { value: "abc", accepted: false },
  ])("accepts a budget of $value: $accepted", ({ value, accepted }) => {
    const variable = optionVariable("pretool_budget_tokens");
    const load = () => loadConfig({ CLAUDE_PLUGIN_DATA: "/data", [variable]: value });

    if (accepted) {
      expect(load().pretoolBudgetTokens).toBe(Number(value));
    } else {
      expect(load).toThrow(
        `${variable} must be an integer between ${BUDGET_MIN_TOKENS} and ${BUDGET_MAX_TOKENS}, got: ${value}`,
      );
    }
  });
});
