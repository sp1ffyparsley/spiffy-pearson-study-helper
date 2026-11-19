import type { StudyAttempt } from "./protocol";

export const HISTORY_QUESTION_LIMIT = 16;
export const HISTORY_ATTEMPT_LIMIT = 3;
export const HISTORY_RESPONSE_LIMIT = 2_400;

export interface HistoryStore {
  [questionKey: string]: StudyAttempt[] | undefined;
}

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation);
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeAttempt(value: unknown): StudyAttempt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StudyAttempt>;
  const response = boundedText(candidate.response, HISTORY_RESPONSE_LIMIT);
  if (!response) return null;
  return {
    at: Number.isFinite(candidate.at) ? Math.max(0, Math.trunc(candidate.at as number)) : 0,
    partLabel: boundedText(candidate.partLabel, 160) || "Current Pearson question",
    response,
    outcome: candidate.outcome === "wrong" ? "wrong" : "unknown",
  };
}

export function normalizeHistoryStore(value: unknown): HistoryStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, StudyAttempt[]]> = [];
  for (const [rawKey, rawAttempts] of Object.entries(value)) {
    const key = rawKey.trim().slice(0, 512);
    if (!key || !Array.isArray(rawAttempts)) continue;
    const attempts = rawAttempts
      .map(normalizeAttempt)
      .filter((attempt): attempt is StudyAttempt => attempt !== null)
      .slice(-HISTORY_ATTEMPT_LIMIT);
    if (attempts.length) entries.push([key, attempts]);
  }
  entries.sort((left, right) => (right[1].at(-1)?.at || 0) - (left[1].at(-1)?.at || 0));
  return Object.fromEntries(entries.slice(0, HISTORY_QUESTION_LIMIT));
}
