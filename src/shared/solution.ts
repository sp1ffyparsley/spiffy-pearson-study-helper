import type { StudyFillAction, StudySolution } from "./protocol";

function clean(value: unknown, limit = 3_000): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function firstJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const direct = JSON.parse(cleaned) as unknown;
    return direct && typeof direct === "object" && !Array.isArray(direct) ? direct as Record<string, unknown> : null;
  } catch {
    // Continue with bounded balanced-object extraction for prose/code fences.
  }
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, index + 1)) as unknown;
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeAction(value: unknown): StudyFillAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  const rawType = clean(action.target_type ?? action.targetType, 30).toLowerCase();
  const targetType: StudyFillAction["targetType"] = rawType === "input" || rawType === "choice" || rawType === "select" ? rawType : "unknown";
  return {
    targetType,
    fieldIndex: Number.isInteger(action.field_index) && Number(action.field_index) >= 1 ? Number(action.field_index) : 1,
    fieldLabel: clean(action.field_label ?? action.fieldLabel, 160),
    choiceLetter: clean(action.choice_letter ?? action.choiceLetter, 8).toUpperCase(),
    choiceText: clean(action.choice_text ?? action.choiceText, 800),
    value: clean(action.value, 2_000),
  };
}

export function emptyStudySolution(response = ""): StudySolution {
  const fallback = /^\s*ANSWER\s*:\s*(.+)$/im.exec(response)?.[1]?.trim() || response.trim().split(/\r?\n/, 1)[0]?.trim() || "";
  const choiceLetter = /^[A-H]$/i.test(fallback) ? fallback.toUpperCase() : "";
  return {
    structured: false,
    questionSummary: "",
    finalAnswer: fallback,
    choiceLetter,
    steps: [],
    fillActions: [],
    confidence: 0,
    needsMoreContext: false,
    missingContext: "",
  };
}

export function parseStudySolution(response: string): StudySolution {
  const parsed = firstJsonObject(response);
  if (!parsed) return emptyStudySolution(response);
  const rawActions = Array.isArray(parsed.fill_actions) ? parsed.fill_actions : Array.isArray(parsed.fillActions) ? parsed.fillActions : [];
  const fillActions = rawActions.map(normalizeAction).filter((action): action is StudyFillAction => action !== null && Boolean(action.value || action.choiceLetter || action.choiceText));
  const steps = Array.isArray(parsed.steps) ? parsed.steps.map((step) => clean(step, 1_200)).filter(Boolean).slice(0, 12) : [];
  const finalAnswer = clean(parsed.final_answer ?? parsed.finalAnswer ?? parsed.answer ?? parsed.solution ?? fillActions[0]?.value, 2_000);
  const choiceLetter = clean(parsed.choice_letter ?? parsed.choiceLetter ?? parsed.choice ?? fillActions.find((action) => action.choiceLetter)?.choiceLetter, 8).toUpperCase();
  return {
    structured: true,
    questionSummary: clean(parsed.question_summary ?? parsed.questionSummary),
    finalAnswer,
    choiceLetter: choiceLetter || (/^[A-H]$/.test(finalAnswer) ? finalAnswer : ""),
    steps,
    fillActions,
    confidence: Math.max(0, Math.min(100, Number.parseInt(String(parsed.confidence ?? 0), 10) || 0)),
    needsMoreContext: parsed.needs_more_context === true || parsed.needsMoreContext === true,
    missingContext: clean(parsed.missing_context ?? parsed.missingContext),
  };
}
