import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPlanText } from "../src/bot/plan-exit-service.js";
import { parseQuestions } from "../src/bot/ask-user-service.js";

describe("extractPlanText", () => {
  it("reads plan_content or planContent", () => {
    assert.equal(extractPlanText({ plan_content: "alpha" }), "alpha");
    assert.equal(extractPlanText({ planContent: "beta" }), "beta");
    assert.equal(extractPlanText({}), "");
  });
});

describe("parseQuestions", () => {
  it("parses labeled options and multi-select", () => {
    const qs = parseQuestions({
      questions: [
        {
          id: "style",
          question: "Which style?",
          multiSelect: true,
          options: [{ id: "a", label: "REST" }, { label: "GraphQL" }],
        },
      ],
    });
    assert.equal(qs.length, 1);
    assert.equal(qs[0]!.id, "style");
    assert.equal(qs[0]!.multi, true);
    assert.equal(qs[0]!.options[0]!.id, "a");
    assert.equal(qs[0]!.options[1]!.label, "GraphQL");
  });

  it("defaults yes/no when options are missing", () => {
    const qs = parseQuestions({ questions: [{ prompt: "Continue?" }] });
    assert.deepEqual(
      qs[0]!.options.map((o) => o.id),
      ["yes", "no"],
    );
  });
});
