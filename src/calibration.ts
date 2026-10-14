import type { PromptGate, ToolGate } from "./gate";
import { MEMORY_KINDS } from "./policy";

export interface CalibratedRatio {
  readonly successes: number;
  readonly n: number;
  readonly ci95: readonly [number, number];
}

export const CALIBRATED_EMBEDDING = {
  modelId: "Xenova/multilingual-e5-small",
  dtype: "q8",
  queryTemplate: "query: {prompt}",
  passageTemplate: "passage: {title}. {abstract} {conflict_key} {keywords}",
} as const;

export const CALIBRATION_RUN = {
  sweepRunId: "2026-10-14T08:57:43.467Z-9e94119f",
  date: "2026-10-14",
  baseCommit: "b3c76d1150def4eb5a4876c8e7213c17a261ae2c",
  fixtureDigest: "fd640988b098f60211a3f5dbc26ad9d9c76b34986d7151d7fc57f54ec72f70c4",
  split: "calibration",
  partitionMemories: 115,
  promptPositives: 240,
  promptNegatives: 207,
  pretoolPositives: 24,
  pretoolNegatives: 9,
  promptGridPoints: 63972,
  promptPointsAdmitted: 1109,
  pretoolGridPoints: 6,
  goldPairsWithCosine: { successes: 232, n: 249, ci95: [0.8934, 0.9569] },
  languageGoldHitFloor: { successes: 130, n: 240, ci95: [0.4785, 0.6036] },
  falseInjectionCapEnglish: { successes: 2, n: 117, ci95: [0.0047, 0.0602] },
  falseInjectionCapCzech: { successes: 9, n: 90, ci95: [0.0535, 0.1792] },
  languageClassificationEnglish: { successes: 237, n: 237, ci95: [0.984, 1] },
  languageClassificationCzech: { successes: 203, n: 210, ci95: [0.9328, 0.9838] },
} as const;

export const PROMPT_MIN_CONTENT_TOKENS = 3;

export const PROMPT_GATE: PromptGate = {
  thresholds: {
    en: {
      floor: 0.8569537550210953,
      floorOpen: 0.8569537550210953,
      margin: 0.01697020381689074,
      fallbackTau: 0.8507631421089172,
      fallbackTauOpen: 0.8507631421089172,
      tauKey: 0.8526315242052078,
    },
    cs: {
      floor: 0.7918179929256439,
      floorOpen: 0.7918179929256439,
      margin: 0.012632755935192086,
      fallbackTau: 0.7875597178936005,
      fallbackTauOpen: 0.7852031290531158,
      tauKey: 0.7806253433227539,
    },
  },
  keyMode: "conjunction",
  maxRows: 3,
};

export const TOOL_GATE: ToolGate = {
  kinds: MEMORY_KINDS,
  keywordSignal: false,
};

export const CALIBRATION_METRICS = {
  userPromptSubmit: {
    f05: 0.5085,
    precision: { successes: 133, n: 266, ci95: [0.4403, 0.5597] },
    goldHit: { successes: 131, n: 240, ci95: [0.4826, 0.6076] },
    falseInjection: { successes: 5, n: 207, ci95: [0.0104, 0.0553] },
    nonGoldRowsPerPrompt: 0.2975,
    recallAt5: 0.5417,
    f05English: 0.5866,
    precisionEnglish: { successes: 68, n: 114, ci95: [0.5047, 0.682] },
    goldHitEnglish: { successes: 66, n: 120, ci95: [0.4608, 0.6361] },
    falseInjectionEnglish: { successes: 1, n: 117, ci95: [0.0015, 0.0468] },
    nonGoldRowsPerPromptEnglish: 0.1941,
    f05Czech: 0.4464,
    precisionCzech: { successes: 65, n: 152, ci95: [0.3517, 0.5071] },
    goldHitCzech: { successes: 65, n: 120, ci95: [0.4526, 0.6281] },
    falseInjectionCzech: { successes: 4, n: 90, ci95: [0.0174, 0.1088] },
    nonGoldRowsPerPromptCzech: 0.4143,
  },
  preToolUse: {
    f05: 0.6496,
    precision: { successes: 22, n: 35, ci95: [0.4634, 0.7683] },
    toolRecallHit: { successes: 18, n: 24, ci95: [0.551, 0.88] },
    falseInjection: { successes: 0, n: 9, ci95: [0, 0.2991] },
    nonGoldRowsPerCase: 0.3939,
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, number | CalibratedRatio>>>>;
