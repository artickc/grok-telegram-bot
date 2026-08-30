import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPlanText } from "../src/bot/plan-exit-service.js";
import { buildAcceptedResult, parseQuestions } from "../src/bot/ask-user-service.js";

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

describe("buildAcceptedResult", () => {
  it("keys answers by question prompt text and uses labels", () => {
    const qs = parseQuestions({
      questions: [
        {
          id: "db",
          question: "Which database?",
          options: [
            { id: "pg", label: "Postgres" },
            { id: "rd", label: "Redis" },
          ],
        },
      ],
    });
    const picked = new Map([["db", new Set(["pg"])]]);
    const notes = new Map<string, string>();
    const r = buildAcceptedResult(qs, picked, notes);
    assert.equal(r.outcome, "accepted");
    if (r.outcome === "accepted") {
      assert.deepEqual(r.answers["Which database?"], ["Postgres"]);
    }
  });

  it("uses Other + annotations.notes for free-text", () => {
    const qs = parseQuestions({ questions: [{ id: "q1", question: "Name?" }] });
    const picked = new Map([["q1", new Set<string>()]]);
    const notes = new Map([["q1", "Ada"]]);
    const r = buildAcceptedResult(qs, picked, notes);
    assert.equal(r.outcome, "accepted");
    if (r.outcome === "accepted") {
      assert.deepEqual(r.answers["Name?"], ["Other"]);
      assert.equal(r.annotations?.["Name?"]?.notes, "Ada");
    }
  });
});
