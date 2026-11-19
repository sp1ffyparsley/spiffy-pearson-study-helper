import { describe, expect, it } from "vitest";
import { emptyStudySolution, parseStudySolution } from "../src/shared/solution";

describe("Pearson structured solution contract", () => {
  it("parses fenced JSON fill actions and choice answers", () => {
    const solution = parseStudySolution(`Here is the result:\n\`\`\`json\n${JSON.stringify({
      question_summary: "Choose the correct option",
      final_answer: "B",
      choice_letter: "b",
      fill_actions: [{ target_type: "choice", choice_letter: "B", value: "B" }],
      confidence: 92,
      needs_more_context: false,
      steps: ["Compare the two values."],
    })}\n\`\`\``);
    expect(solution.structured).toBe(true);
    expect(solution.choiceLetter).toBe("B");
    expect(solution.fillActions[0]?.targetType).toBe("choice");
    expect(solution.confidence).toBe(92);
  });

  it("keeps legacy answer text usable for manual mode but marks it unstructured", () => {
    const solution = emptyStudySolution("WHY: work\nANSWER: 42\nCHECK: verified");
    expect(solution.structured).toBe(false);
    expect(solution.finalAnswer).toBe("42");
  });

  it("stops automatic mode when more context is required", () => {
    const solution = parseStudySolution(JSON.stringify({
      final_answer: "",
      confidence: 40,
      needs_more_context: true,
      missing_context: "The graph labels are not visible.",
    }));
    expect(solution.needsMoreContext).toBe(true);
    expect(solution.missingContext).toContain("graph labels");
  });
});
