import { describe, expect, it } from "vitest";
import { assignmentSessionKey, boundedPositions, extractPartLabel, hashText, parseAnswerLine } from "../src/shared/question";

describe("Pearson study helper primitives", () => {
  it("keeps multi-part labels stable and readable", () => {
    expect(extractPartLabel("Part b: Now compute the marginal value.")).toBe("Part B");
    expect(extractPartLabel("No explicit part label here")).toBe("Current part");
  });

  it("extracts the answer contract without losing freeform fallbacks", () => {
    expect(parseAnswerLine("WHY: work\nANSWER: 42\nCHECK: verified")).toBe("42");
    expect(parseAnswerLine("Use option C")).toBe("Use option C");
  });

  it("samples long questions into at most four ordered viewports", () => {
    const positions = boundedPositions(100, 7000, 900, 100, 4);
    expect(positions).toHaveLength(4);
    expect(positions[0]).toBe(100);
    expect(positions[3]).toBe(6100);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("keeps question/item query churn out of one assignment chat key", () => {
    const first = assignmentSessionKey("https://mylab.pearson.com/course?assignmentId=77&questionId=2&part=A");
    const second = assignmentSessionKey("https://mylab.pearson.com/course?assignmentId=77&questionId=3&part=B");
    expect(first).toBe(second);
    expect(first).toMatch(/^pearson-[a-f0-9]{8}$/);
    expect(hashText("same")).toBe(hashText("same"));
  });

  it("removes transient query keys without relying on an iterable keys() result", () => {
    const first = assignmentSessionKey("https://mylab.pearson.com/course?assignmentId=77&questionId=2&part=A");
    const second = assignmentSessionKey("https://mylab.pearson.com/course?assignmentId=77&questionId=9&part=C");
    expect(first).toBe(second);
  });
});
