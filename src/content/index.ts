import { boundedPositions, extractPartLabel, findQuestionRoot, hasInteractiveGraph, questionIdentity } from "../shared/question";
import type { CapturePlan, CaptureScrollReply, FrameReport, StudyAskReply, StudyFillAction, StudySolution } from "../shared/protocol";

interface CaptureState {
  id: string;
  kind: "document" | "nested";
  root: HTMLElement;
  scrollRoot: HTMLElement | null;
  documentX: number;
  documentY: number;
  originalPosition: number;
}

let captureState: CaptureState | null = null;
let reportTimer: number | null = null;
let panelHost: HTMLDivElement | null = null;
let panelShadow: ShadowRoot | null = null;
let lastAnswer = "";

function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 4 && rect.height > 4;
}

function helperElement(element: Element): boolean {
  return Boolean(element.closest?.("#spiffy-pearson-study-helper"));
}

function questionScope(): HTMLElement {
  return findQuestionRoot(document).root || document.body || document.documentElement;
}

function queryScopes(): Array<Document | ShadowRoot> {
  const scopes: Array<Document | ShadowRoot> = [document];
  for (let index = 0; index < scopes.length && scopes.length < 80; index += 1) {
    const scope = scopes[index];
    if (!scope) continue;
    for (const element of scope.querySelectorAll("*")) {
      if (element.shadowRoot) scopes.push(element.shadowRoot);
    }
  }
  return scopes;
}

function queryAcrossScopes<T extends Element>(selector: string, preferred?: Element): T[] {
  const found: T[] = [];
  const seen = new Set<Element>();
  const add = (elements: Iterable<T>) => {
    for (const element of elements) {
      if (seen.has(element)) continue;
      seen.add(element);
      found.push(element);
    }
  };
  if (preferred) add(preferred.querySelectorAll<T>(selector));
  for (const scope of queryScopes()) add(scope.querySelectorAll<T>(selector));
  return found;
}

function textFor(element: HTMLElement): string {
  const id = element.getAttribute("id") || "";
  const label = id ? [...(element.ownerDocument?.querySelectorAll("label") || [])].find((candidate) => candidate.htmlFor === id)?.textContent || "" : "";
  return [element.innerText, element.textContent, element.getAttribute("aria-label"), element.getAttribute("value"), label]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function dispatchInput(element: HTMLElement, value: string): boolean {
  try {
    element.scrollIntoView({ block: "nearest" });
    element.focus();
  } catch {
    // The field can still be writable when scrolling/focus is denied by the page.
  }
  if (element instanceof HTMLSelectElement) {
    const wanted = value.trim().toLowerCase();
    const option = [...element.options].find((candidate) => candidate.value.trim().toLowerCase() === wanted || candidate.textContent?.trim().toLowerCase() === wanted || candidate.textContent?.toLowerCase().includes(wanted));
    if (!option) return false;
    element.value = option.value;
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  } else if (element.isContentEditable || element.getAttribute("role") === "textbox") {
    element.textContent = value;
  } else {
    return false;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return true;
}

function clickPageElement(element: HTMLElement): void {
  try {
    element.scrollIntoView({ block: "nearest" });
    element.focus();
  } catch {
    // Clicking remains the primary action.
  }
  element.click();
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function choiceCandidates(scope: HTMLElement): HTMLElement[] {
  const radios = queryAcrossScopes<HTMLElement>('input[type="radio"], [role="radio"]', scope).filter((element) => visible(element) && !helperElement(element));
  if (radios.length) return radios;
  return queryAcrossScopes<HTMLElement>('[role="option"], .mcControl, .mcAnswerContent, .mcButtonArea, td.mcButtonArea, label', scope)
    .filter((element) => visible(element) && !helperElement(element));
}

function fillChoice(scope: HTMLElement, action: StudyFillAction, solution: StudySolution): boolean {
  const candidates = choiceCandidates(scope);
  if (!candidates.length) return false;
  const choiceText = action.choiceText.trim().toLowerCase();
  let candidate = choiceText ? candidates.find((element) => textFor(element).toLowerCase().includes(choiceText)) : undefined;
  const letter = (action.choiceLetter || solution.choiceLetter).trim().toUpperCase();
  if (!candidate && letter && /^[A-H]$/.test(letter)) candidate = candidates[letter.charCodeAt(0) - 65];
  if (!candidate) return false;
  clickPageElement(candidate);
  if (candidate instanceof HTMLInputElement) candidate.checked = true;
  if (candidate.getAttribute("role") === "radio" || candidate.getAttribute("role") === "option") candidate.setAttribute("aria-checked", "true");
  return true;
}

function fillSolution(solution: StudySolution): { filled: number } {
  const scope = questionScope();
  const actions = solution.fillActions || [];
  const choiceAction = actions.find((action) => action.targetType === "choice" || action.choiceLetter || action.choiceText) || (solution.choiceLetter ? {
    targetType: "choice" as const,
    fieldIndex: 1,
    fieldLabel: "",
    choiceLetter: solution.choiceLetter,
    choiceText: "",
    value: solution.choiceLetter,
  } satisfies StudyFillAction : undefined);
  const textInputs = queryAcrossScopes<HTMLElement>([
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="radio"]):not([type="checkbox"])',
    "textarea",
    "select",
    '[contenteditable="true"]',
    '[role="textbox"]',
    ".eqEditor",
    ".mq-editable-field",
    ".questionInput",
    "[data-response]",
    "[data-answer]",
    "div.answerBox",
    "div.editArea",
  ].join(","), scope).filter((element) => visible(element) && !helperElement(element));
  let filled = 0;
  if (choiceAction && fillChoice(scope, choiceAction, solution)) {
    filled += 1;
  }
  const inputActions = actions.filter((action) => action.targetType === "input" || action.targetType === "select" || action.targetType === "unknown").filter((action) => action.value);
  if (inputActions.length) {
    for (let index = 0; index < inputActions.length; index += 1) {
      const action = inputActions[index];
      if (!action) continue;
      const field = textInputs[(action.fieldIndex || index + 1) - 1] || textInputs[index];
      if (field && dispatchInput(field, action.value)) {
        filled += 1;
      }
    }
  } else if (!choiceAction && solution.finalAnswer && textInputs[0] && dispatchInput(textInputs[0], solution.finalAnswer)) {
    filled += 1;
  }
  return { filled };
}

function report(): FrameReport {
  const found = findQuestionRoot(document);
  const text = found.root?.textContent || "";
  return {
    score: found.score,
    questionKey: questionIdentity(found.root, document),
    partLabel: extractPartLabel(text),
    sourceUrl: location.href,
    title: document.title.slice(0, 160),
    hasInteractiveGraph: hasInteractiveGraph(found.root),
  };
}

function scheduleReport(): void {
  if (reportTimer !== null) clearTimeout(reportTimer);
  reportTimer = window.setTimeout(() => {
    reportTimer = null;
    void browser.runtime.sendMessage({ type: "frame.report", report: report() }).catch(() => undefined);
  }, 180);
}

function scrollableAncestor(root: HTMLElement): HTMLElement | null {
  let current = root.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = getComputedStyle(current);
    if ((/(?:auto|scroll)/.test(style.overflowY) || /(?:auto|scroll)/.test(style.overflow)) && current.scrollHeight > current.clientHeight + 24 && current.clientHeight > 120) return current;
    current = current.parentElement;
  }
  return null;
}

function settle(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

async function prepareCapture(): Promise<CapturePlan> {
  if (captureState) await restoreCapture(captureState.id);
  const found = findQuestionRoot(document);
  // A low detector score must not block visual capture. Pearson regularly puts
  // the actual problem in canvas/shadow/iframe markup that is hard to score;
  // in that case capture the rendered document so ChatGPT can read the pixels.
  const root = found.root && found.score >= 8 ? found.root : document.body;
  if (!root) throw new Error("No visible document body is available for capture.");
  const nested = scrollableAncestor(root);
  const documentX = window.scrollX;
  const documentY = window.scrollY;
  const originalPosition = nested ? nested.scrollTop : window.scrollY;
  root.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
  await settle();
  const rect = root.getBoundingClientRect();
  const id = `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  let positions: number[];
  if (nested) {
    const container = nested.getBoundingClientRect();
    const start = nested.scrollTop + (rect.top - container.top) - 54;
    const end = nested.scrollTop + (rect.bottom - container.top) + 54;
    positions = boundedPositions(start, end, Math.max(160, nested.clientHeight), 90, 4);
  } else {
    const start = window.scrollY + rect.top - 64;
    const end = window.scrollY + rect.bottom + 64;
    positions = boundedPositions(start, end, Math.max(220, window.innerHeight), 110, 4);
  }
  captureState = { id, kind: nested ? "nested" : "document", root, scrollRoot: nested, documentX, documentY, originalPosition };
  return {
    id,
    kind: captureState.kind,
    positions,
    originalPosition,
    questionKey: questionIdentity(found.root, document),
    partLabel: extractPartLabel(found.root?.textContent || ""),
    hasInteractiveGraph: hasInteractiveGraph(found.root),
  };
}

async function scrollCapture(id: string, position: number): Promise<CaptureScrollReply> {
  const state = captureState;
  if (!state || state.id !== id || !state.root.isConnected || !Number.isFinite(position) || position < 0) return { ok: false, position, questionVisible: false };
  if (state.kind === "nested" && state.scrollRoot) state.scrollRoot.scrollTo({ top: position, behavior: "instant" });
  else window.scrollTo({ left: state.documentX, top: position, behavior: "instant" });
  await settle();
  const rect = state.root.getBoundingClientRect();
  const questionVisible = rect.bottom > 0 && rect.top < window.innerHeight;
  return { ok: true, position: state.kind === "nested" && state.scrollRoot ? state.scrollRoot.scrollTop : window.scrollY, questionVisible };
}

async function restoreCapture(id: string): Promise<{ restored: boolean }> {
  const state = captureState;
  if (!state || state.id !== id) return { restored: false };
  if (state.kind === "nested" && state.scrollRoot?.isConnected) state.scrollRoot.scrollTo({ top: state.originalPosition, behavior: "instant" });
  window.scrollTo({ left: state.documentX, top: state.documentY, behavior: "instant" });
  await settle();
  if (captureState?.id === id) captureState = null;
  return { restored: true };
}

async function imageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  await image.decode();
  return image;
}

async function compressCapture(dataUrl: string, maxChars: number): Promise<string> {
  if (!dataUrl.startsWith("data:image/")) throw new Error("Capture payload was not an image.");
  const image = await imageFromDataUrl(dataUrl);
  let width = image.naturalWidth;
  let height = image.naturalHeight;
  const maxDimension = 1600;
  if (Math.max(width, height) > maxDimension) {
    const scale = maxDimension / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Firefox could not create the screenshot compression canvas.");
  for (let resize = 0; resize < 5; resize += 1) {
    canvas.width = width;
    canvas.height = height;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    for (const quality of [0.84, 0.76, 0.68, 0.60, 0.52]) {
      const webp = canvas.toDataURL("image/webp", quality);
      if (webp.startsWith("data:image/webp;base64,") && webp.length <= maxChars) return webp;
    }
    width = Math.max(560, Math.round(width * 0.82));
    height = Math.max(360, Math.round(height * 0.82));
  }
  throw new Error("Screenshot remains too large after bounded WebP compression.");
}

function navigationCandidate(direction: "next" | "back"): HTMLElement | null {
  const allowed = direction === "next"
    ? /^(?:next|next question|skip|skip question)\s*[›»>]?[\s.]*$/i
    : /^(?:back|previous|previous question|prev)\s*[‹«<]?[\s.]*$/i;
  const forbidden = /\b(?:check|submit|finish|grade|answer|done|complete|turn\s*in)\b/i;
  const candidates = queryAcrossScopes<HTMLElement>('button, a[href], [role="button"], input[type="button"]')
    .filter((element) => visible(element) && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true")
    .map((element) => ({ element, label: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("value") || "").replace(/\s+/g, " ").trim() }))
    .filter(({ label }) => label && !forbidden.test(label) && allowed.test(label));
  return candidates[0]?.element || null;
}

function clickNavigation(direction: "next" | "back"): { clicked: boolean } {
  const candidate = navigationCandidate(direction);
  if (!candidate) return { clicked: false };
  candidate.click();
  return { clicked: true };
}

function checkCandidate(): HTMLElement | null {
  const selectors = [
    "button#checkAnswerBtn",
    "input#btnCheckAnswer",
    'button[data-automation-id="check-answer-btn"]',
    'button[command="checkanswer"]',
    '[command="checkanswer"]',
    "button.checkAnswer",
    'button[title*="Check" i]',
    'button[aria-label*="Check" i]',
    'input[value*="Check" i]',
    'input[value*="Final Check" i]',
    '[class*="check" i][role="button"]',
  ];
  const scope = questionScope();
  const selector = selectors.join(",");
  const candidates = queryAcrossScopes<HTMLElement>(selector, scope)
    .filter((element) => visible(element) && !helperElement(element) && !/\b(?:submit|finish|grade|turn\s*in)\b/i.test(textFor(element)));
  if (candidates[0]) return candidates[0];
  return queryAcrossScopes<HTMLElement>("button, [role=button], input[type=button], input[type=submit]", scope)
    .find((element) => visible(element) && !helperElement(element) && /\bcheck(?:\s+answer)?\b/i.test(textFor(element)) && !/\b(?:submit|finish|grade|turn\s*in)\b/i.test(textFor(element))) || null;
}

function pageAction(action: "check" | "next", click: boolean): { available: boolean; clicked?: boolean } {
  const element = action === "check" ? checkCandidate() : navigationCandidate("next");
  if (!element) return { available: false, clicked: false };
  if (!click) return { available: true };
  clickPageElement(element);
  return { available: true, clicked: true };
}

function pageResult(): { status: "correct" | "wrong" | "unknown"; evidence: string } {
  const scope = document.body || questionScope();
  const selectors = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[class*="feedback" i]',
    '[id*="feedback" i]',
    '[class*="incorrect" i]',
    '[id*="incorrect" i]',
    '[class*="correct" i]',
    '[id*="correct" i]',
    '[data-testid*="feedback" i]',
  ];
  const messages = queryAcrossScopes<HTMLElement>(selectors.join(","), scope)
    .filter((element) => visible(element) && !helperElement(element))
    .map((element) => textFor(element).slice(0, 500))
    .filter(Boolean);
  const evidence = messages.join(" | ");
  if (!evidence) return { status: "unknown", evidence: "" };
  const correct = /\b(?:correct|well\s+done|great\s+job|nice\s+work|that(?:'|’)?s\s+right)\b|[✓✔]/i.test(evidence);
  const wrong = /\b(?:incorrect|wrong|try\s+again|not\s+correct|needs?\s+(?:another|more)\s+attempt)\b|[✗✘×]/i.test(evidence);
  if (correct === wrong) return { status: "unknown", evidence };
  return { status: correct ? "correct" : "wrong", evidence };
}

function renderPanel(): void {
  if (window.top !== window || panelHost) return;
  panelHost = document.createElement("div");
  panelHost.id = "spiffy-pearson-study-helper";
  panelShadow = panelHost.attachShadow({ mode: "open" });
  panelShadow.innerHTML = `
    <style>
      :host{all:initial}
      .panel{position:fixed;right:18px;top:18px;width:330px;z-index:2147483647;background:#111315;color:#f4f4f2;border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 18px 55px rgba(0,0,0,.38);font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
      .head{display:flex;align-items:center;justify-content:space-between;padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.1)}
      .title{font-weight:700;letter-spacing:.01em}.badge{font-size:10px;color:#aeb4bb;text-transform:uppercase;letter-spacing:.08em}
      .body{padding:12px}.status{color:#bbc1c7;margin-bottom:9px}.part{font-size:11px;color:#8f979e;margin-bottom:7px}
      .answer{white-space:pre-wrap;max-height:240px;overflow:auto;background:#0b0d0e;border:1px solid rgba(255,255,255,.08);border-radius:9px;padding:9px;margin:0 0 10px;min-height:38px;color:#f3f3f1}
      .row{display:flex;gap:7px;flex-wrap:wrap;margin-top:7px}button{appearance:none;border:1px solid rgba(255,255,255,.14);background:#1c2023;color:#f4f4f2;border-radius:8px;padding:7px 9px;font:600 12px system-ui;cursor:pointer}button:hover{background:#262b2f}button.primary{background:#f4f4f2;color:#111315;border-color:#f4f4f2}button:disabled{opacity:.45;cursor:default}.small{font-size:11px;color:#899198;margin-top:8px}
    </style>
    <div class="panel">
      <div class="head"><span class="title">Pearson Study</span><span class="badge">ChatGPT</span></div>
      <div class="body">
        <div class="part" id="part">Current question</div>
        <div class="status" id="status">Ready — toolbar button and Alt+Shift+P run automatically.</div>
        <pre class="answer" id="answer">Capture the rendered question when you want help.</pre>
        <div class="row"><button class="primary" id="run">Run All</button><button id="ask">Ask only</button><button id="stop">Stop</button></div>
        <div class="row"><button id="wrong">Wrong → Retry</button><button id="copy">Copy answer</button><button id="back">Back</button><button id="next">Next / Skip</button></div>
        <div class="row"><button id="clear-history">Clear retry history</button></div>
        <div class="small">Run All fills practice answers, checks them, retries clear wrong results, and advances only through safe Next/Skip controls. It never clicks Finish, Submit, Grade, or Turn In. Bounded retry context stays only for this Firefox session; Clear retry history removes it immediately.</div>
      </div>
    </div>`;
  (document.documentElement || document.body).appendChild(panelHost);
  const ask = panelShadow.getElementById("ask") as HTMLButtonElement;
  const run = panelShadow.getElementById("run") as HTMLButtonElement;
  const stop = panelShadow.getElementById("stop") as HTMLButtonElement;
  const wrong = panelShadow.getElementById("wrong") as HTMLButtonElement;
  const copy = panelShadow.getElementById("copy") as HTMLButtonElement;
  const back = panelShadow.getElementById("back") as HTMLButtonElement;
  const next = panelShadow.getElementById("next") as HTMLButtonElement;
  const clearHistory = panelShadow.getElementById("clear-history") as HTMLButtonElement;
  ask.addEventListener("click", () => void askStudy("normal"));
  run.addEventListener("click", () => void runAll());
  stop.addEventListener("click", () => void stopRun());
  wrong.addEventListener("click", () => void askStudy("wrong"));
  copy.addEventListener("click", () => void copyAnswer());
  back.addEventListener("click", () => void navigate("back"));
  next.addEventListener("click", () => void navigate("next"));
  clearHistory.addEventListener("click", () => void clearRetryHistory());
}

function setBusy(busy: boolean): void {
  if (!panelShadow) return;
  for (const id of ["run", "ask", "wrong", "copy", "back", "next", "clear-history"]) {
    const button = panelShadow.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = busy;
  }
  const stop = panelShadow.getElementById("stop") as HTMLButtonElement | null;
  if (stop) stop.disabled = !busy;
}

function setStatus(message: string): void {
  const node = panelShadow?.getElementById("status");
  if (node) node.textContent = message;
}

function setPart(message: string): void {
  const node = panelShadow?.getElementById("part");
  if (node) node.textContent = message;
}

function setResponse(message: string): void {
  const node = panelShadow?.getElementById("answer");
  if (node) node.textContent = message;
}

async function askStudy(mode: "normal" | "wrong"): Promise<void> {
  setBusy(true);
  setStatus(mode === "wrong" ? "Re-capturing after the wrong answer…" : "Capturing the rendered question…");
  try {
    const reply = await browser.runtime.sendMessage({ type: "study.ask", mode }) as StudyAskReply;
    if (!reply?.ok) throw new Error(reply?.error || "The study request failed.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

async function runAll(): Promise<void> {
  setBusy(true);
  setStatus("Starting automatic practice run…");
  try {
    const reply = await browser.runtime.sendMessage({ type: "study.run" }) as { ok?: boolean; error?: string };
    if (!reply?.ok) throw new Error(reply?.error || "Automatic run could not start.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    setBusy(false);
  }
}

async function stopRun(): Promise<void> {
  await browser.runtime.sendMessage({ type: "study.stop" }).catch(() => undefined);
  setStatus("Stopping after the current safe step…");
}

async function copyAnswer(): Promise<void> {
  if (!lastAnswer) {
    setStatus("Ask ChatGPT first; there is no answer to copy yet.");
    return;
  }
  await navigator.clipboard.writeText(lastAnswer);
  setStatus("Answer copied. You decide where/when to enter it.");
}

async function clearRetryHistory(): Promise<void> {
  const reply = await browser.runtime.sendMessage({ type: "history.clear" }).catch(() => ({ ok: false })) as { ok?: boolean };
  if (!reply?.ok) {
    setStatus("Retry history could not be cleared. Reload Firefox and try again.");
    return;
  }
  lastAnswer = "";
  setResponse("Retry history cleared for this Firefox session.");
  setStatus("Retry history cleared. Bridge pairing remains available.");
}

async function navigate(direction: "next" | "back"): Promise<void> {
  setBusy(true);
  try {
    const reply = await browser.runtime.sendMessage({ type: "study.navigate", direction }) as { ok?: boolean; error?: string };
    if (!reply?.ok) throw new Error(reply?.error || "Pearson navigation control was not found.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const body = message && typeof message === "object" ? message as Record<string, unknown> : {};
  if (body.type === "frame.scan") return Promise.resolve(report());
  if (body.type === "capture.prepare") return prepareCapture();
  if (body.type === "capture.scroll" && typeof body.id === "string" && typeof body.position === "number") return scrollCapture(body.id, body.position);
  if (body.type === "capture.restore" && typeof body.id === "string") return restoreCapture(body.id);
  if (body.type === "capture.compress" && typeof body.dataUrl === "string" && typeof body.maxChars === "number") return compressCapture(body.dataUrl, body.maxChars).then((dataUrl) => ({ dataUrl }));
  if (body.type === "nav.inspect" && (body.direction === "next" || body.direction === "back")) return Promise.resolve({ available: Boolean(navigationCandidate(body.direction)) });
  if (body.type === "nav.click" && (body.direction === "next" || body.direction === "back")) return Promise.resolve(clickNavigation(body.direction));
  if (body.type === "solution.fill" && body.solution && typeof body.solution === "object") return Promise.resolve(fillSolution(body.solution as StudySolution));
  if (body.type === "page-action.inspect" && (body.action === "check" || body.action === "next")) return Promise.resolve(pageAction(body.action, false));
  if (body.type === "page-action.click" && (body.action === "check" || body.action === "next")) return Promise.resolve(pageAction(body.action, true));
  if (body.type === "page-result.inspect") return Promise.resolve(pageResult());
  if (window.top !== window) return undefined;
  if (body.type === "ui.captureVisibility") {
    if (panelHost) panelHost.style.display = body.hidden === true ? "none" : "";
    return Promise.resolve({ ok: true });
  }
  if (body.type === "ui.state") {
    setBusy(body.state === "capturing" || body.state === "waiting" || body.state === "automation");
    if (typeof body.message === "string") setStatus(body.message);
    return Promise.resolve({ ok: true });
  }
  if (body.type === "ui.part") {
    if (typeof body.partLabel === "string") setPart(body.partLabel);
    return Promise.resolve({ ok: true });
  }
  if (body.type === "ui.result") {
    const reply = body as unknown as StudyAskReply;
    lastAnswer = reply.answer || "";
    setPart(reply.partLabel || "Current part");
    setResponse(reply.response || reply.answer || "No response text was returned.");
    setStatus(/^skip$/i.test(reply.answer || "") ? "ChatGPT marked this as interactive/incomplete. Use Next / Skip if appropriate." : "Answer ready for review/copy.");
    return Promise.resolve({ ok: true });
  }
  if (body.type === "ui.error") {
    setStatus(typeof body.message === "string" ? body.message : "Study request failed.");
    setBusy(false);
    return Promise.resolve({ ok: true });
  }
  return undefined;
});

if (window.top === window) renderPanel();
scheduleReport();
const observer = new MutationObserver(scheduleReport);
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-hidden", "disabled"] });
