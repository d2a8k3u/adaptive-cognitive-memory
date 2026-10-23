import { describe, expect, it } from "vitest";
import { CALIBRATED_EMBEDDING } from "../src/calibration";
import { MODEL_DTYPE, MODEL_ID } from "../src/cfg";
import { passageText } from "../src/db/memories";
import { passageInput, queryInput } from "../src/embeddings";

function filled(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}

describe("CALIBRATED_EMBEDDING", () => {
  it("names the live model and reproduces the live query, passage and question inputs", () => {
    const prompt = "how do we deploy billing";
    const question = "Where does billing deploy to?";
    const row = {
      title: "Deploy target",
      content: "Deploys go to the ECS cluster. The staging service mirrors production.",
      keywords: "ecs deploy",
    };

    expect({
      modelId: MODEL_ID,
      dtype: MODEL_DTYPE,
      query: queryInput(prompt),
      passage: passageInput(passageText(row)),
      question: queryInput(question),
    }).toEqual({
      modelId: CALIBRATED_EMBEDDING.modelId,
      dtype: CALIBRATED_EMBEDDING.dtype,
      query: filled(CALIBRATED_EMBEDDING.queryTemplate, { prompt }),
      passage: filled(CALIBRATED_EMBEDDING.passageTemplate, row),
      question: filled(CALIBRATED_EMBEDDING.questionTemplate, { question }),
    });
  });
});
