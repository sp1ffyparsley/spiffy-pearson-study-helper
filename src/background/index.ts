import { askStudyBridge } from "./bridge";
import { assignmentSessionKey, parseAnswerLine } from "../shared/question";
import { buildStudyPrompt } from "../shared/prompt";
import { emptyStudySolution, parseStudySolution } from "../shared/solution";
import {
  HISTORY_ATTEMPT_LIMIT,
  HISTORY_QUESTION_LIMIT,
  SerialTaskQueue,
  type HistoryStore,
  normalizeHistoryStore,
} from "../shared/history";
import {
  MAX_CAPTURE_IMAGES,
  MAX_IMAGE_DATA_URL_CHARS,
  type CapturePlan,
  type CaptureScrollReply,
  type FrameReport,
  type StudyAskReply,
  type StudyAttempt,
  type StudyFillAction,
  type StudySolution,
  type StudyImage,
} from "../shared/protocol";

const HISTORY_KEY = "questionHistory.v1";
const inFlight = new Map<number, Promise<StudyAskReply>>();
const autoRuns = new Map<number, { stopped: boolean; task: Promise<void> }>();
const reports = new Map<number, Map<number, { report: FrameReport; at: number }>>();

let historyMigration: Promise<void> | null = null;
const historyOperations = new SerialTaskQueue();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeFailureCode(error: unknown): string {
  const explicit = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(explicit)) return explicit;
  const message = errorMessage(error);
  const rules: Array<[RegExp, string]> = [
    [/active tab|tab active/i, "TAB_NOT_ACTIVE"],
    [/capture|screenshot|visible region|rendered Pearson/i, "CAPTURE_FAILED"],
    [/frame|receiving end|connection/i, "FRAME_UNREACHABLE"],
    [/bridge|Chat On Steroids|pairing/i, "BRIDGE_FAILED"],
    [/legacy text|structured answer/i, "UNSTRUCTURED_RESPONSE"],
    [/context|manual review|graph|drawing/i, "MANUAL_REVIEW_REQUIRED"],
    [/confidence/i, "LOW_CONFIDENCE"],
    [/no fillable answer/i, "NO_FILLABLE_ANSWER"],
    [/field or choice|could be matched/i, "FILL_TARGET_NOT_FOUND"],
    [/Check Answer control/i, "CHECK_CONTROL_NOT_FOUND"],
    [/marked .*wrong/i, "ANSWER_REJECTED"],
    [/correct\/incorrect result|clear correct/i, "RESULT_AMBIGUOUS"],
    [/Next\/Skip|next Pearson question/i, "NEXT_CONTROL_FAILED"],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ||
    (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name.toUpperCase()
      : "UNKNOWN_FAILURE");
}

function diagnostic(action: string, context: Record<string, unknown> = {}): void {
  console.debug("[Spiffy Pearson]", { at: new Date().toISOString(), action, ...context });
}

async function sendToFrame<T>(tabId: number, frameId: number, message: unknown): Promise<T> {
  return browser.tabs.sendMessage(tabId, message, { frameId }) as Promise<T>;
}

async function sendUi(tabId: number, message: unknown): Promise<void> {
  await sendToFrame(tabId, 0, message).catch(() => undefined);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function frameIdsForTab(tabId: number): Promise<number[]> {
  return browser.webNavigation.getAllFrames({ tabId }).then((frames) => {
    const ids = [...new Set((frames || []).map((frame) => frame.frameId))];
    if (!ids.includes(0)) ids.unshift(0);
    return ids;
  }).catch(() => [0]);
}

async function sendToAllFrames<T>(tabId: number, message: unknown): Promise<Array<{ frameId: number; value: T }>> {
  const ids = await frameIdsForTab(tabId);
  const values = await Promise.all(ids.map(async (frameId): Promise<{ frameId: number; value: T } | null> => {
    try {
      return { frameId, value: await sendToFrame<T>(tabId, frameId, message) as T };
    } catch {
      return null;
    }
  }));
  return values.filter((value): value is { frameId: number; value: T } => value !== null);
}

function rememberReport(tabId: number, frameId: number, report: FrameReport): void {
  let byFrame = reports.get(tabId);
  if (!byFrame) {
    byFrame = new Map();
    reports.set(tabId, byFrame);
  }
  byFrame.set(frameId, { report, at: Date.now() });
}

async function scanQuestionFrames(tabId: number): Promise<Array<{ frameId: number; report: FrameReport }>> {
  const frames = await browser.webNavigation.getAllFrames({ tabId }).catch(() => []);
  const ids = [...new Set((frames || []).map((frame) => frame.frameId))];
  if (!ids.includes(0)) ids.unshift(0);
  const scanned = await Promise.all(ids.map(async (frameId) => {
    try {
      const report = await sendToFrame<FrameReport>(tabId, frameId, { type: "frame.scan" });
      if (!report || typeof report.score !== "number") return null;
      rememberReport(tabId, frameId, report);
      return { frameId, report };
    } catch (error) {
      diagnostic("frame.scan.failed", { tabId, frameId, code: safeFailureCode(error) });
      return null;
    }
  }));
  const result = scanned.filter((entry): entry is { frameId: number; report: FrameReport } => entry !== null)
    .sort((left, right) => right.report.score - left.report.score);
  diagnostic("frame.scan.complete", {
    tabId,
    frameCount: ids.length,
    readableFrameCount: result.length,
    scores: result.map((entry) => ({ frameId: entry.frameId, score: entry.report.score })),
  });
  return result;
}

async function ensureSessionHistory(): Promise<void> {
  if (!historyMigration) {
    historyMigration = (async () => {
      const [legacy, current] = await Promise.all([
        browser.storage.local.get(HISTORY_KEY),
        browser.storage.session.get(HISTORY_KEY),
      ]);
      const migrated = normalizeHistoryStore({
        ...normalizeHistoryStore(legacy[HISTORY_KEY]),
        ...normalizeHistoryStore(current[HISTORY_KEY]),
      });
      if (Object.keys(migrated).length) {
        await browser.storage.session.set({ [HISTORY_KEY]: migrated });
      } else {
        await browser.storage.session.remove(HISTORY_KEY);
      }
      await browser.storage.local.remove(HISTORY_KEY);
      diagnostic("history.storage.ready", {
        scope: "firefox-session",
        questionCount: Object.keys(migrated).length,
      });
    })();
  }
  await historyMigration;
}

async function loadHistory(): Promise<HistoryStore> {
  await ensureSessionHistory();
  const raw = (await browser.storage.session.get(HISTORY_KEY))[HISTORY_KEY];
  return normalizeHistoryStore(raw);
}

async function attemptsFor(questionKey: string): Promise<StudyAttempt[]> {
  return historyOperations.run(async () => {
    const store = await loadHistory();
    return Array.isArray(store[questionKey]) ? store[questionKey]!.slice(-HISTORY_ATTEMPT_LIMIT) : [];
  });
}

async function saveAttempt(questionKey: string, attempt: StudyAttempt): Promise<void> {
  await historyOperations.run(async () => {
    const store = await loadHistory();
    store[questionKey] = [...(store[questionKey] || []), attempt].slice(-HISTORY_ATTEMPT_LIMIT);
    const keys = Object.keys(store);
    if (keys.length > HISTORY_QUESTION_LIMIT) {
      keys.sort((a, b) => (store[a]?.at(-1)?.at || 0) - (store[b]?.at(-1)?.at || 0));
      for (const key of keys.slice(0, keys.length - HISTORY_QUESTION_LIMIT)) delete store[key];
    }
    await browser.storage.session.set({ [HISTORY_KEY]: normalizeHistoryStore(store) });
  });
}

async function markLastWrong(questionKey: string): Promise<StudyAttempt[]> {
  return historyOperations.run(async () => {
    const store = await loadHistory();
    const attempts = [...(store[questionKey] || [])];
    const last = attempts.at(-1);
    if (last) attempts[attempts.length - 1] = { ...last, outcome: "wrong" };
    store[questionKey] = attempts.slice(-HISTORY_ATTEMPT_LIMIT);
    const normalized = normalizeHistoryStore(store);
    await browser.storage.session.set({ [HISTORY_KEY]: normalized });
    return normalized[questionKey] || [];
  });
}

function validCapturePlan(value: unknown): value is CapturePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<CapturePlan>;
  return typeof plan.id === "string" && (plan.kind === "document" || plan.kind === "nested") &&
    Array.isArray(plan.positions) && plan.positions.length >= 1 && plan.positions.length <= MAX_CAPTURE_IMAGES &&
    plan.positions.every((position) => Number.isFinite(position) && position >= 0) && typeof plan.questionKey === "string";
}

async function captureQuestion(tabId: number, frameId: number): Promise<{ images: StudyImage[]; plan: CapturePlan }> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.active || tab.windowId === undefined) throw new Error("Make the Pearson tab active before capturing the question.");
  const active = await browser.tabs.query({ active: true, windowId: tab.windowId });
  if (active[0]?.id !== tabId) throw new Error("The active tab changed before the screenshot was captured.");
  const planRaw = await sendToFrame<unknown>(tabId, frameId, { type: "capture.prepare" });
  if (!validCapturePlan(planRaw)) throw new Error("Pearson question capture could not establish a stable visible region.");
  const plan = planRaw;
  diagnostic("capture.plan", { tabId, frameId, kind: plan.kind, tileCount: plan.positions.length });
  const images: StudyImage[] = [];
  await sendUi(tabId, { type: "ui.captureVisibility", hidden: true });
  try {
    for (let index = 0; index < plan.positions.length; index += 1) {
      const position = plan.positions[index];
      if (position === undefined) continue;
      const scrolled = await sendToFrame<CaptureScrollReply>(tabId, frameId, { type: "capture.scroll", id: plan.id, position });
      if (!scrolled?.ok) throw new Error("Pearson changed while the screenshot sequence was being captured.");
      await new Promise((resolve) => setTimeout(resolve, 55));
      const stillActive = await browser.tabs.query({ active: true, windowId: tab.windowId });
      if (stillActive[0]?.id !== tabId) throw new Error("The active tab changed during screenshot capture.");
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 88 });
      const compressed = await sendToFrame<{ dataUrl?: string }>(tabId, frameId, {
        type: "capture.compress",
        dataUrl,
        maxChars: MAX_IMAGE_DATA_URL_CHARS,
      });
      if (!compressed?.dataUrl?.startsWith("data:image/webp;base64,") || compressed.dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
        throw new Error("The rendered Pearson screenshot could not be compressed within the local ChatGPT image limit.");
      }
      images.push({ name: `pearson-question-${index + 1}.webp`, dataUrl: compressed.dataUrl });
      diagnostic("capture.tile", { tabId, frameId, index: index + 1, total: plan.positions.length, chars: compressed.dataUrl.length });
    }
  } finally {
    await sendToFrame(tabId, frameId, { type: "capture.restore", id: plan.id }).catch(() => undefined);
    await sendUi(tabId, { type: "ui.captureVisibility", hidden: false });
  }
  if (images.length === 0) throw new Error("No readable Pearson screenshot was captured.");
  diagnostic("capture.complete", { tabId, frameId, imageCount: images.length });
  return { images, plan };
}

async function runStudy(tabId: number, mode: "normal" | "wrong", freshChat = false): Promise<StudyAskReply> {
  const existing = inFlight.get(tabId);
  if (existing) return existing;
  const task = (async (): Promise<StudyAskReply> => {
      try {
        await sendUi(tabId, { type: "ui.state", state: "capturing", message: "Reading the rendered question…" });
        const candidates = await scanQuestionFrames(tabId);
        const best = candidates[0];
        const tab = await browser.tabs.get(tabId);
        if (!tab.url) throw new Error("The Pearson tab no longer has a readable URL.");
        const fallbackReport: FrameReport = {
          score: 0,
          questionKey: `q-page-${tabId}-${new URL(tab.url).pathname}`,
          partLabel: "Current Pearson page",
          sourceUrl: tab.url,
          title: tab.title || "Pearson",
          hasInteractiveGraph: false,
        };
        const selectedReport = best?.report || fallbackReport;
        if (!best || best.report.score < 8) {
          await sendUi(tabId, { type: "ui.state", state: "capturing", message: "Question detection was inconclusive; capturing the rendered Pearson page instead…" });
        }

        const frameIds = [...new Set([
          best?.frameId,
          0,
          ...candidates.map((candidate) => candidate.frameId),
        ].filter((frameId): frameId is number => typeof frameId === "number"))];
        let captured: { images: StudyImage[]; plan: CapturePlan } | undefined;
        let captureError: unknown;
        for (const frameId of frameIds) {
          try {
            captured = await captureQuestion(tabId, frameId);
            break;
          } catch (error) {
            captureError = error;
            diagnostic("capture.frame.failed", { tabId, frameId, code: safeFailureCode(error) });
          }
        }
        if (!captured) throw captureError || new Error("No rendered Pearson screenshot was captured.");
        const { images, plan } = captured;
        const questionKey = plan.questionKey || selectedReport.questionKey;
        const prior = mode === "wrong" ? await markLastWrong(questionKey) : await attemptsFor(questionKey);
        const sessionKey = assignmentSessionKey(tab.url);
        const prompt = buildStudyPrompt({
          partLabel: plan.partLabel || selectedReport.partLabel,
          hasInteractiveGraph: plan.hasInteractiveGraph || selectedReport.hasInteractiveGraph,
          attempts: prior,
          markedWrong: mode === "wrong",
          imageCount: images.length,
      });
      await sendUi(tabId, { type: "ui.state", state: "waiting", message: "Waiting for ChatGPT…" });
        const answer = await askStudyBridge({ sessionKey, prompt, images, freshChat });
      const response = answer.response.trim();
      const solution = parseStudySolution(response);
      const parsed = solution.finalAnswer || solution.choiceLetter || parseAnswerLine(response);
        const attempt: StudyAttempt = {
          at: Date.now(),
          partLabel: plan.partLabel || selectedReport.partLabel,
          response,
          outcome: "unknown",
        };
        await saveAttempt(questionKey, attempt);
        const reply: StudyAskReply = {
        ok: true,
        response,
        answer: parsed,
        solution,
          partLabel: attempt.partLabel,
          questionKey,
          interactiveGraph: plan.hasInteractiveGraph || selectedReport.hasInteractiveGraph,
      };
      await sendUi(tabId, { type: "ui.result", ...reply });
      return reply;
      } catch (error) {
        const message = errorMessage(error);
        console.error("[Spiffy Pearson] study.failed", {
          at: new Date().toISOString(),
          tabId,
          mode,
          code: safeFailureCode(error),
        });
        const reply: StudyAskReply = { ok: false, error: message };
      await sendUi(tabId, { type: "ui.error", message });
      return reply;
    }
  })();
  inFlight.set(tabId, task);
  try {
    return await task;
  } finally {
    if (inFlight.get(tabId) === task) inFlight.delete(tabId);
  }
}

interface FrameFillResult {
  filled?: number;
}

interface FrameActionResult {
  available?: boolean;
  clicked?: boolean;
  status?: "correct" | "wrong" | "unknown";
  evidence?: string;
  questionKey?: string;
}

async function fillSolution(tabId: number, solution: StudySolution): Promise<{ filled: number }> {
  const results = await sendToAllFrames<FrameFillResult>(tabId, { type: "solution.fill", solution });
  const filled = results.reduce((sum, entry) => sum + (Number(entry.value.filled) || 0), 0);
  diagnostic("automation.fill", { tabId, frameCount: results.length, filled });
  return { filled };
}

async function clickPageAction(tabId: number, action: "check" | "next"): Promise<boolean> {
  const inspected = await sendToAllFrames<FrameActionResult>(tabId, { type: "page-action.inspect", action });
  for (const entry of inspected) {
    if (!entry.value.available) continue;
    const clicked = await sendToFrame<FrameActionResult>(tabId, entry.frameId, { type: "page-action.click", action }).catch(() => ({ clicked: false }));
    if (clicked.clicked) {
      diagnostic("automation.click", { tabId, frameId: entry.frameId, action });
      return true;
    }
  }
  diagnostic("automation.click.missing", { tabId, action });
  return false;
}

async function inspectPageResult(tabId: number): Promise<"correct" | "wrong" | "unknown"> {
  const results = await sendToAllFrames<FrameActionResult>(tabId, { type: "page-result.inspect" });
  const statuses = results.map((entry) => entry.value.status).filter((status): status is "correct" | "wrong" => status === "correct" || status === "wrong");
  if (statuses.includes("correct") && !statuses.includes("wrong")) return "correct";
  if (statuses.includes("wrong") && !statuses.includes("correct")) return "wrong";
  return "unknown";
}

async function waitForPageResult(tabId: number, timeoutMs = 12_000): Promise<"correct" | "wrong" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await inspectPageResult(tabId);
    if (result !== "unknown") return result;
    await delay(350);
  }
  return "unknown";
}

async function waitForQuestionChange(tabId: number, oldQuestionKey: string, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = await scanQuestionFrames(tabId);
    if (frames.some((frame) => frame.report.questionKey && frame.report.questionKey !== oldQuestionKey)) return true;
    await delay(400);
  }
  return false;
}

function autoRunIsStopped(tabId: number): boolean {
  return autoRuns.get(tabId)?.stopped === true;
}

async function runAutomatic(tabId: number): Promise<void> {
  const run = autoRuns.get(tabId);
  if (!run) return;
  const maxQuestions = 25;
  const maxRetriesPerQuestion = 2;
  let completedQuestions = 0;
  let retries = 0;
  let freshChat = true;
  try {
    await sendUi(tabId, { type: "ui.state", state: "automation", message: "Automatic run started. It will stop before Finish/Submit." });
    while (!run.stopped && completedQuestions < maxQuestions) {
      await sendUi(tabId, { type: "ui.state", state: "automation", message: `Reading question ${completedQuestions + 1}/${maxQuestions}…` });
      const reply = await runStudy(tabId, retries > 0 ? "wrong" : "normal", freshChat);
      freshChat = false;
      if (run.stopped) break;
      if (!reply.ok || !reply.solution) throw new Error(reply.error || "No structured solution was returned.");
      const solution = reply.solution;
      if (!solution.structured) throw new Error("ChatGPT returned legacy text instead of the required structured answer. Automatic mode stopped; use Ask ChatGPT once to inspect it.");
      if (solution.needsMoreContext || reply.interactiveGraph === true || /^skip$/i.test(solution.finalAnswer)) {
        throw new Error(solution.missingContext || "This question needs manual review before it can be filled safely.");
      }
      if (solution.confidence < 70) throw new Error(`ChatGPT confidence was ${solution.confidence}%; automatic mode stopped for review.`);
      if (!solution.finalAnswer && !solution.choiceLetter && solution.fillActions.length === 0) throw new Error("ChatGPT returned no fillable answer.");

      await sendUi(tabId, { type: "ui.state", state: "automation", message: "Filling the Pearson answer…" });
      const fill = await fillSolution(tabId, solution);
      if (run.stopped) break;
      if (fill.filled < 1) throw new Error("No Pearson answer field or choice could be matched. Automatic mode stopped without checking.");
      await delay(450);
      if (run.stopped) break;
      await sendUi(tabId, { type: "ui.state", state: "automation", message: "Checking the Pearson answer…" });
      if (!await clickPageAction(tabId, "check")) throw new Error("No safe Check Answer control was found. Automatic mode stopped before advancing.");
      const result = await waitForPageResult(tabId);
      if (run.stopped) break;
      if (result === "wrong") {
        if (retries >= maxRetriesPerQuestion) throw new Error("Pearson marked the answer wrong twice. Automatic mode stopped for review.");
        retries += 1;
        await sendUi(tabId, { type: "ui.state", state: "automation", message: `Pearson marked it wrong. Re-solving (${retries}/${maxRetriesPerQuestion})…` });
        continue;
      }
      if (result !== "correct") throw new Error("Pearson did not expose a clear correct/incorrect result. Automatic mode stopped before advancing.");

      retries = 0;
      const oldQuestionKey = reply.questionKey || "";
      await sendUi(tabId, { type: "ui.state", state: "automation", message: "Correct. Moving to the next practice question…" });
      if (!await clickPageAction(tabId, "next")) throw new Error("The answer was correct, but no safe Next/Skip control was found. The run stopped here.");
      if (!await waitForQuestionChange(tabId, oldQuestionKey)) throw new Error("Next was clicked, but the next Pearson question did not become visible in time.");
      completedQuestions += 1;
    }
    const message = run.stopped
      ? `Run stopped by user after ${completedQuestions} completed question(s).`
      : `Run stopped after the ${maxQuestions}-question safety limit.`;
    await sendUi(tabId, { type: "ui.state", state: "idle", message });
  } catch (error) {
    const message = errorMessage(error);
    console.error("[Spiffy Pearson] automation.failed", {
      at: new Date().toISOString(),
      tabId,
      code: safeFailureCode(error),
      completedQuestions,
      retries,
    });
    await sendUi(tabId, { type: "ui.error", message: `Automatic run stopped: ${message}` });
  } finally {
    if (autoRuns.get(tabId)?.task === run.task) autoRuns.delete(tabId);
  }
}

function startAutomatic(tabId: number): Promise<void> {
  const current = autoRuns.get(tabId);
  if (current) return current.task;
  const run = { stopped: false, task: Promise.resolve() as Promise<void> };
  autoRuns.set(tabId, run);
  run.task = runAutomatic(tabId);
  return run.task;
}

function stopAutomatic(tabId: number): boolean {
  const run = autoRuns.get(tabId);
  if (!run) return false;
  run.stopped = true;
  return true;
}

async function navigate(tabId: number, direction: "next" | "back"): Promise<{ ok: boolean; error?: string }> {
  const frames = await scanQuestionFrames(tabId);
  for (const frame of frames) {
    try {
      const inspected = await sendToFrame<{ available?: boolean }>(tabId, frame.frameId, { type: "nav.inspect", direction });
      if (!inspected?.available) continue;
      const clicked = await sendToFrame<{ clicked?: boolean }>(tabId, frame.frameId, { type: "nav.click", direction });
      if (clicked?.clicked) {
        await sendUi(tabId, { type: "ui.state", state: "idle", message: direction === "next" ? "Moved forward. Ask when the next part/question is visible." : "Moved back." });
        return { ok: true };
      }
    } catch {
      // Try the next accessible Pearson frame.
    }
  }
  return { ok: false, error: `No safe visible ${direction === "next" ? "Next/Skip" : "Back/Previous"} control was found.` };
}

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  const body = message && typeof message === "object" ? message as Record<string, unknown> : {};
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  if (body.type === "frame.report" && tabId !== undefined && body.report && typeof body.report === "object") {
    rememberReport(tabId, frameId, body.report as FrameReport);
    const current = [...(reports.get(tabId)?.values() || [])]
      .filter((entry) => Date.now() - entry.at < 10_000)
      .sort((left, right) => right.report.score - left.report.score)[0]?.report;
    if (current && current.score >= 8) void sendUi(tabId, { type: "ui.part", partLabel: current.partLabel });
    return Promise.resolve({ ok: true });
  }
  if (body.type === "study.ask" && tabId !== undefined) return runStudy(tabId, body.mode === "wrong" ? "wrong" : "normal");
  if (body.type === "study.run" && tabId !== undefined) return startAutomatic(tabId).then(() => ({ ok: true }));
  if (body.type === "study.stop" && tabId !== undefined) return Promise.resolve({ ok: stopAutomatic(tabId) });
  if (body.type === "history.clear" && tabId !== undefined) {
    return historyOperations.run(async () => {
      await ensureSessionHistory();
      await browser.storage.session.remove(HISTORY_KEY);
      diagnostic("history.cleared", { scope: "firefox-session" });
      return { ok: true };
    });
  }
  if (body.type === "study.navigate" && tabId !== undefined && (body.direction === "next" || body.direction === "back")) return navigate(tabId, body.direction);
  return undefined;
});

browser.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void startAutomatic(tab.id);
});

browser.commands.onCommand.addListener((command) => {
  if (command !== "ask-question") return;
  void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id !== undefined) return startAutomatic(tab.id);
    return undefined;
  });
});

browser.tabs.onRemoved.addListener((tabId) => {
  reports.delete(tabId);
  inFlight.delete(tabId);
  stopAutomatic(tabId);
});

void ensureSessionHistory().catch((error) => {
  diagnostic("history.storage.failed", { code: safeFailureCode(error) });
});
