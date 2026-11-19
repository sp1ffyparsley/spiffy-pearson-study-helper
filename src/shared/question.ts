const STRONG_SELECTORS = [
  "#contentHolderbottom",
  ".problemContent",
  ".contentHolder",
  ".questionContainer",
  ".question-container",
  ".problem-container",
  '[data-testid*="question" i]',
  '[data-testid*="problem" i]',
  '[class*="question-body" i]',
  '[class*="practice-area" i]',
  '[class*="question" i]',
  '[class*="problem" i]',
  '[id*="question" i]',
  '[id*="problem" i]',
  "#xl_player_layout_SplitTopLayout_0",
  "#bottom",
  "#top",
  '[role="main"]',
  "main",
  "article",
] as const;

const SEED_SELECTOR = [
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"])',
  "textarea",
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="option"]',
  ".mcControl",
  ".mcAnswerContent",
  "math",
  ".MathJax",
  ".mjx-chtml",
  ".katex",
  '[data-latex]',
  '[role="math"]',
  "canvas",
  "img[alt]",
].join(",");

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function extractPartLabel(text: string): string {
  const normalized = normalizeText(text).slice(0, 4000);
  const matches = [
    /\bpart\s+([a-z]|\d{1,2})\b/i,
    /\b(?:step|section)\s+([a-z]|\d{1,2})\b/i,
  ];
  for (const pattern of matches) {
    const match = pattern.exec(normalized);
    if (match?.[1]) return `Part ${match[1].toUpperCase()}`;
  }
  return "Current part";
}

export function parseAnswerLine(response: string): string {
  const answer = /^\s*ANSWER\s*:\s*(.+)$/im.exec(response)?.[1]?.trim();
  return answer || response.trim().split(/\r?\n/, 1)[0]?.trim() || "";
}

function deleteMatchingSearchParams(url: URL, pattern: RegExp): void {
  // Firefox can expose URLSearchParams.keys() without making the returned
  // iterator spreadable in every embedded/content-script context. forEach is
  // supported there and avoids the "keys() is not iterable" crash entirely.
  const keys: string[] = [];
  url.searchParams.forEach((_value, key) => {
    if (pattern.test(key)) keys.push(key);
  });
  for (const key of keys) url.searchParams.delete(key);
}

export function assignmentSessionKey(urlString: string): string {
  const url = new URL(urlString);
  const removable = /^(?:question|problem|item|part|step|attempt|index|ordinal)(?:id|number|no)?$/i;
  deleteMatchingSearchParams(url, removable);
  url.hash = "";
  return `pearson-${hashText(url.toString())}`;
}

function visible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 8 && rect.height > 8;
}

function scoreQuestionRoot(element: Element, strong: boolean): number {
  if (!visible(element)) return -Infinity;
  const text = normalizeText(element.textContent || "");
  const controls = element.querySelectorAll('input:not([type="hidden"]), textarea, [role="option"], [contenteditable="true"]').length;
  const math = element.querySelectorAll('math, .MathJax, .mjx-chtml, .katex, [data-latex], [role="math"]').length;
  const visuals = element.querySelectorAll("canvas, svg, img").length;
  const checkControls = [...element.querySelectorAll("button, [role=button], input[type=button]")]
    .filter((node) => /check\s*(?:answer)?/i.test(normalizeText((node as HTMLElement).innerText || node.getAttribute("value") || ""))).length;
  const sizePenalty = text.length > 18_000 ? Math.min(20, (text.length - 18_000) / 1800) : 0;
  const questionSignal = /[?]|\b(?:find|solve|calculate|select|choose|enter|determine|evaluate|graph|write)\b/i.test(text) ? 8 : 0;
  return (strong ? 18 : 0) + Math.min(18, controls * 4) + Math.min(15, math * 3) + Math.min(10, visuals * 2) + Math.min(8, checkControls * 4) + questionSignal + Math.min(14, text.length / 220) - sizePenalty;
}

function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function collectScopes(document: Document): Array<Document | ShadowRoot> {
  const scopes: Array<Document | ShadowRoot> = [document];
  for (let index = 0; index < scopes.length && scopes.length < 80; index += 1) {
    const scope = scopes[index];
    if (!scope) continue;
    for (const element of scope.querySelectorAll("*")) if (element.shadowRoot) scopes.push(element.shadowRoot);
  }
  return scopes;
}

export function findQuestionRoot(document: Document = globalThis.document): { root: HTMLElement | null; score: number } {
  const candidates = new Map<Element, boolean>();
  const scopes = collectScopes(document);
  for (const scope of scopes) {
    for (const selector of STRONG_SELECTORS) {
      try {
        for (const element of scope.querySelectorAll(selector)) candidates.set(element, true);
      } catch {
        // Future Pearson markup may make a selector invalid in an unusual shadow root.
      }
    }
    let seeds: Element[] = [];
    try { seeds = [...scope.querySelectorAll(SEED_SELECTOR)].slice(0, 180); } catch { seeds = []; }
    for (const seed of seeds) {
      let current: Element | null = seed;
      for (let depth = 0; current && depth < 7; depth += 1) {
        if (!candidates.has(current)) candidates.set(current, false);
        current = composedParent(current);
      }
    }
  }
  let best: HTMLElement | null = null;
  let bestScore = -Infinity;
  for (const [candidate, strong] of candidates) {
    const score = scoreQuestionRoot(candidate, strong);
    if (score > bestScore && candidate instanceof HTMLElement) {
      best = candidate;
      bestScore = score;
    }
  }
  return { root: bestScore >= 8 ? best : null, score: Number.isFinite(bestScore) ? Math.round(bestScore) : 0 };
}

export function questionIdentity(root: HTMLElement | null, document: Document = globalThis.document): string {
  const url = new URL(document.location.href);
  const transient = /^(?:part|step|attempt|index|ordinal)(?:id|number|no)?$/i;
  deleteMatchingSearchParams(url, transient);
  url.hash = "";
  const stableAttrs = root
    ? [root.id, root.getAttribute("data-question-id"), root.getAttribute("data-problem-id"), root.getAttribute("data-testid")]
        .filter(Boolean).join("|")
    : "no-root";
  const rootText = normalizeText(root?.textContent || "");
  const ordinal = /\b(?:question|problem)\s*(\d{1,4})\b/i.exec(rootText.slice(0, 1200))?.[0] || "";
  return `q-${hashText(`${url.origin}${url.pathname}${url.search}|${stableAttrs}|${ordinal}`)}`;
}

export function hasInteractiveGraph(root: HTMLElement | null): boolean {
  if (!root) return false;
  const text = normalizeText(root.textContent || "").slice(0, 5000);
  const canvas = root.querySelectorAll("canvas").length;
  const graphRoles = root.querySelectorAll('[class*="graph" i], [id*="graph" i], [aria-label*="graph" i], [aria-label*="plot" i]').length;
  return (canvas + graphRoles > 0) && /\b(?:graph|plot|drag|draw|point|line|curve)\b/i.test(text);
}

export function boundedPositions(start: number, end: number, viewport: number, overlap = 110, limit = 4): number[] {
  const low = Math.max(0, Math.floor(start));
  const high = Math.max(low, Math.ceil(end - viewport));
  if (high <= low) return [low];
  const step = Math.max(1, viewport - overlap);
  const all: number[] = [];
  for (let position = low; position <= high; position += step) all.push(Math.min(position, high));
  if (all[all.length - 1] !== high) all.push(high);
  const unique = [...new Set(all)];
  if (unique.length <= limit) return unique;
  return [...new Set(Array.from({ length: limit }, (_, index) => unique[Math.round(index * (unique.length - 1) / (limit - 1))] ?? low))];
}
