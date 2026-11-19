import type { StudyAttempt } from "./protocol";

export interface StudyPromptInput {
  partLabel: string;
  hasInteractiveGraph: boolean;
  attempts: StudyAttempt[];
  markedWrong: boolean;
  imageCount: number;
}

function priorAttemptText(attempts: readonly StudyAttempt[]): string {
  if (attempts.length === 0) return "No earlier answer from this helper is available for this question.";
  return attempts.slice(-3).map((attempt, index) => {
    const response = attempt.response.replace(/\s+/g, " ").trim().slice(0, 1400);
    return `${index + 1}. ${attempt.partLabel}; outcome=${attempt.outcome}; response=${response}`;
  }).join("\n");
}

export function buildStudyPrompt(input: StudyPromptInput): string {
  const wrongInstruction = input.markedWrong
    ? "The user explicitly marked the previous helper answer wrong. Re-solve from the screenshots from scratch and avoid repeating that answer unless the visual evidence makes it unavoidable."
    : "Solve the currently visible part from the screenshots.";
  const graphInstruction = input.hasInteractiveGraph
    ? "The page appears to contain an interactive graph/canvas. If the task requires drawing, dragging, plotting, or manipulating a graph rather than typing/selecting a normal answer, return ANSWER: SKIP."
    : "If the screenshots reveal that this is actually an interactive graph/drawing/drag task, return ANSWER: SKIP.";
  return [
    "You are helping with one Pearson/MyLab/MathXL practice question using ordered screenshots of the rendered page.",
    `There are ${input.imageCount} screenshot(s), ordered from the top/earlier portion of the visible question to the bottom/later portion. Read every image before answering.`,
    `Current part label: ${input.partLabel}.`,
    wrongInstruction,
    graphInstruction,
    "If the screenshots are missing information needed to answer reliably, return ANSWER: SKIP instead of inventing unseen content.",
    "For normal multiple-choice, numeric, algebraic, text-entry, or calculation questions, solve carefully and verify the result.",
    "Return one valid JSON object and no surrounding prose or Markdown fences:",
    '{"question_summary":"...","final_answer":"...","choice_letter":"","steps":["..."],"fill_actions":[{"target_type":"input|choice|select","field_index":1,"field_label":"","choice_letter":"","choice_text":"","value":"..."}],"confidence":0,"needs_more_context":false,"missing_context":"..."}',
    "Use an empty final_answer only when the answer cannot be determined. For multiple choice, provide choice_letter and a choice fill_action. For one or more text/numeric fields, provide one input fill_action per field in page order using 1-based field_index.",
    "If the screenshots reveal a graph/drawing/drag task or missing information, set needs_more_context appropriately and use final_answer SKIP rather than inventing a value.",
    "Do not instruct the browser to click Check Answer, submit, finish, or turn in anything. The extension may use a separate guarded practice workflow for Check and Next; final submission is never automated.",
    "Previous helper attempts for context:",
    priorAttemptText(input.attempts),
  ].join("\n");
}
