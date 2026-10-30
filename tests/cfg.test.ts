import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUDGET_MAX_TOKENS,
  BUDGET_MIN_TOKENS,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_DOWNLOAD_MODEL,
  DEFAULT_PRETOOL_BUDGET_TOKENS,
  loadConfig,
  MODEL_DOWNLOAD_SIZE,
  storePaths,
} from "../src/cfg";

interface UserConfigOption {
  type: string;
  title: string;
  description: string;
  default: number | boolean;
  min?: number;
  max?: number;
}

const userConfig = (
  JSON.parse(readFileSync(join(process.cwd(), ".claude-plugin", "plugin.json"), "utf8")) as {
    userConfig: Record<string, UserConfigOption>;
  }
).userConfig;

const NEUTRAL_DATA_DIR = "/home/user/.local/share/adaptive-cognitive-memory";

function optionVariable(key: string): string {
  return `CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`;
}

describe("loadConfig", () => {
  it("resolves the store and every default under HOME with no Claude variable set", () => {
    const config = loadConfig({ HOME: "/home/user" });

    expect(config).toEqual({
      dataDir: NEUTRAL_DATA_DIR,
      dbPath: `${NEUTRAL_DATA_DIR}/memory.sqlite`,
      modelCacheDir: `${NEUTRAL_DATA_DIR}/models`,
      modelRemoteHost: undefined,
      autoDownloadModel: true,
      budgetTokens: 1200,
      pretoolBudgetTokens: 300,
      embedDeadlineMs: 1500,
    });
  });

  it.each([
    {
      name: "ACM_DATA_DIR over HOME",
      env: { ACM_DATA_DIR: "/data", HOME: "/home/user" },
      dataDir: "/data",
    },
    {
      name: "HOME over CLAUDE_PLUGIN_DATA",
      env: { CLAUDE_PLUGIN_DATA: "/claude-data", HOME: "/home/user" },
      dataDir: NEUTRAL_DATA_DIR,
    },
  ])("locates the data dir by $name", ({ env, dataDir }) => {
    expect(loadConfig(env).dataDir).toBe(dataDir);
  });

  it.each([
    { name: "a relative ACM_DATA_DIR", env: { ACM_DATA_DIR: "data", HOME: "/home/user" } },
    { name: "an empty ACM_DATA_DIR", env: { ACM_DATA_DIR: "", HOME: "/home/user" } },
    { name: "a relative HOME", env: { HOME: "home/user" } },
    { name: "neither ACM_DATA_DIR nor HOME", env: {} },
  ])("throws naming ACM_DATA_DIR for $name, whatever CLAUDE_PLUGIN_DATA says", ({ env }) => {
    expect(() => loadConfig({ ...env, CLAUDE_PLUGIN_DATA: "/claude-data" })).toThrow(
      /ACM_DATA_DIR/,
    );
  });

  it.each([
    { value: "1", accepted: true },
    { value: "0", accepted: false },
    { value: "2147483647", accepted: true },
    { value: "2147483648", accepted: false },
    { value: "250.5", accepted: false },
  ])("accepts an embedding deadline of $value ms: $accepted", ({ value, accepted }) => {
    const load = () => loadConfig({ ACM_DATA_DIR: "/data", ACM_EMBED_DEADLINE_MS: value });

    if (accepted) {
      expect(load().embedDeadlineMs).toBe(Number(value));
    } else {
      expect(load).toThrow(
        `ACM_EMBED_DEADLINE_MS must be an integer between 1 and 2147483647, got: ${value}`,
      );
    }
  });

  it("resolves path and download source overrides", () => {
    const config = loadConfig({
      ACM_DATA_DIR: "/data",
      ACM_DB_PATH: "/tmp/acm-test.sqlite",
      ACM_MODEL_CACHE_DIR: "/tmp/acm-models",
      ACM_MODEL_REMOTE_HOST: "http://127.0.0.1:9/",
    });
    expect(config.dbPath).toBe("/tmp/acm-test.sqlite");
    expect(config.modelCacheDir).toBe("/tmp/acm-models");
    expect(config.modelRemoteHost).toBe("http://127.0.0.1:9/");
  });

  it("reads each option from the plugin option variable its userConfig key names", () => {
    const config = loadConfig({
      ACM_DATA_DIR: "/data",
      [optionVariable("recall_budget_tokens")]: "500",
      [optionVariable("pretool_budget_tokens")]: "100",
      [optionVariable("download_model")]: "false",
    });

    expect(Object.keys(userConfig).sort()).toEqual([
      "download_model",
      "pretool_budget_tokens",
      "recall_budget_tokens",
    ]);
    expect([config.budgetTokens, config.pretoolBudgetTokens, config.autoDownloadModel]).toEqual([
      500,
      100,
      false,
    ]);
  });

  it("declares in plugin.json the defaults and bounds the config enforces", () => {
    expect(userConfig).toEqual({
      download_model: {
        type: "boolean",
        title: expect.any(String),
        description: expect.stringContaining(MODEL_DOWNLOAD_SIZE),
        default: DEFAULT_DOWNLOAD_MODEL,
      },
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
    const load = () => loadConfig({ ACM_DATA_DIR: "/data", [variable]: value });

    if (accepted) {
      expect(load().pretoolBudgetTokens).toBe(Number(value));
    } else {
      expect(load).toThrow(
        `${variable} must be an integer between ${BUDGET_MIN_TOKENS} and ${BUDGET_MAX_TOKENS}, got: ${value}`,
      );
    }
  });

  it.each([
    { value: undefined, autoDownloadModel: true },
    { value: "TRUE", autoDownloadModel: true },
    { value: "false", autoDownloadModel: false },
    { value: "yes", autoDownloadModel: "error" },
  ])(
    "reads a download_model option of $value as $autoDownloadModel",
    ({ value, autoDownloadModel }) => {
      const variable = optionVariable("download_model");
      const env = value === undefined ? {} : { [variable]: value };
      const load = () => loadConfig({ ACM_DATA_DIR: "/data", ...env });

      if (autoDownloadModel === "error") {
        expect(load).toThrow(`${variable} must be true or false, got: ${value}`);
      } else {
        expect(load().autoDownloadModel).toBe(autoDownloadModel);
      }
    },
  );
});

describe("storePaths", () => {
  it("applies the path overrides to the directory it is given, not to ACM_DATA_DIR", () => {
    const paths = storePaths("/legacy", {
      ACM_DATA_DIR: "/data",
      ACM_DB_PATH: "/override/memory.sqlite",
    });

    expect(paths).toEqual({
      dataDir: "/legacy",
      dbPath: "/override/memory.sqlite",
      modelCacheDir: "/legacy/models",
    });
  });
});
