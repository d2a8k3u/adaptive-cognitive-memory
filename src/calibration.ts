import type { PromptGate, ToolGate } from "./gate";
import { MEMORY_KINDS } from "./policy";

export const CALIBRATED_EMBEDDING = {
  modelId: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
  dtype: "q8",
  queryTemplate: "{prompt}",
  passageTemplate: "{title}. {content} {keywords}",
  questionTemplate: "{question}",
} as const;

export const CALIBRATION_RUN = {
  runId: "2026-10-23T12:51:01.045Z-e8725b28",
  date: "2026-10-23",
  split: "calibration",
  falseInjectionCap: 0.03,
} as const;

export const PROMPT_MIN_CONTENT_TOKENS = 3;

export const PROMPT_GATE: PromptGate = {
  bias: -21.959562003778487,
  weights: {
    cosine: 20.780989832279758,
    gapToTop: 8.384290536958812,
    gapToNeighbourhood: 19.38170560275417,
    lexical: 0.35548663677164993,
    top: 2.8229579495440484,
    keyHit: 0.21860459535894056,
  },
  threshold: 0.1306170348621114,
  maxRows: 3,
  neighbourhoodPrior: 0.8304367216367121,
};

export const TOOL_GATE: ToolGate = {
  kinds: MEMORY_KINDS,
  keywordSignal: false,
};

export const FAILURE_GATE: ToolGate = {
  kinds: MEMORY_KINDS,
  keywordSignal: false,
};
