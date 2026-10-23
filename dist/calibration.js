"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FAILURE_GATE = exports.TOOL_GATE = exports.PROMPT_GATE = exports.PROMPT_MIN_WORDS = exports.CALIBRATION_RUN = exports.CALIBRATED_EMBEDDING = void 0;
const policy_1 = require("./policy");
exports.CALIBRATED_EMBEDDING = {
    modelId: "onnx-community/granite-embedding-97m-multilingual-r2-ONNX",
    dtype: "q8",
    queryTemplate: "{prompt}",
    passageTemplate: "{title}. {content} {keywords}",
    questionTemplate: "{question}",
};
exports.CALIBRATION_RUN = {
    runId: "2026-10-23T14:19:21.860Z-dc1ac133",
    date: "2026-10-23",
    split: "calibration",
    falseInjectionCap: 0.03,
};
exports.PROMPT_MIN_WORDS = 3;
exports.PROMPT_GATE = {
    bias: -23.450947617915038,
    weights: {
        cosine: 22.31220996599409,
        gapToTop: 6.9912035539192425,
        gapToNeighbourhood: 19.103685806535875,
        lexical: 0.33701523223680885,
        top: 2.727697455742648,
        keyHit: 0.3662732900415054,
    },
    threshold: 0.015359272212449149,
    maxRows: 3,
    neighbourhoodPrior: 0.8277048002568446,
};
exports.TOOL_GATE = {
    kinds: policy_1.MEMORY_KINDS,
    keywordSignal: false,
};
exports.FAILURE_GATE = {
    kinds: policy_1.MEMORY_KINDS,
    keywordSignal: false,
};
