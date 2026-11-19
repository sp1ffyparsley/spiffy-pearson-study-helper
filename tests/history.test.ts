import { describe, expect, it } from "vitest";
import {
  HISTORY_ATTEMPT_LIMIT,
  HISTORY_QUESTION_LIMIT,
  HISTORY_RESPONSE_LIMIT,
  SerialTaskQueue,
  normalizeHistoryStore,
} from "../src/shared/history";

describe("Pearson session history", () => {
  it("keeps only bounded, sanitized recent retry context", () => {
    const source = Object.fromEntries(Array.from({ length: HISTORY_QUESTION_LIMIT + 2 }, (_, question) => [
      `question-${question}`,
      Array.from({ length: HISTORY_ATTEMPT_LIMIT + 2 }, (_, attempt) => ({
        at: question * 100 + attempt,
        partLabel: ` Part ${question} `,
        response: ` ${"x".repeat(HISTORY_RESPONSE_LIMIT + 20)} `,
        answer: "legacy duplicate answer",
        outcome: attempt % 2 ? "wrong" : "unexpected",
      })),
    ]));

    const normalized = normalizeHistoryStore(source);
    expect(Object.keys(normalized)).toHaveLength(HISTORY_QUESTION_LIMIT);
    expect(normalized["question-0"]).toBeUndefined();
    expect(normalized[`question-${HISTORY_QUESTION_LIMIT + 1}`]).toHaveLength(HISTORY_ATTEMPT_LIMIT);
    const latest = normalized[`question-${HISTORY_QUESTION_LIMIT + 1}`]?.at(-1);
    expect(latest?.response).toHaveLength(HISTORY_RESPONSE_LIMIT);
    expect(latest).not.toHaveProperty("answer");
    expect(latest?.outcome).toBe("unknown");
  });

  it("drops invalid and empty records", () => {
    expect(normalizeHistoryStore(null)).toEqual({});
    expect(normalizeHistoryStore({ empty: [], invalid: "value", blank: [{ response: "" }] })).toEqual({});
  });

  it("serializes cross-tab history mutations without poisoning later work", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      events.push("second");
      throw new Error("expected test failure");
    });
    const third = queue.run(async () => {
      events.push("third");
      return 3;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toThrow("expected test failure");
    await expect(third).resolves.toBe(3);
    expect(events).toEqual(["first:start", "first:end", "second", "third"]);
  });
});
