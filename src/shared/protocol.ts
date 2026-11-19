export const EXTENSION_VERSION = "0.1.0";
export const STUDY_HELPER_PROTOCOL = 1;
export const BRIDGE_PORTS = [8765, 8766, 8767, 8768, 8769] as const;
export const MAX_CAPTURE_IMAGES = 4;
export const MAX_IMAGE_DATA_URL_CHARS = 370_000;

export interface FrameReport {
  score: number;
  questionKey: string;
  partLabel: string;
  sourceUrl: string;
  title: string;
  hasInteractiveGraph: boolean;
}

export interface CapturePlan {
  id: string;
  kind: "document" | "nested";
  positions: number[];
  originalPosition: number;
  questionKey: string;
  partLabel: string;
  hasInteractiveGraph: boolean;
}

export interface CaptureScrollReply {
  ok: boolean;
  position: number;
  questionVisible: boolean;
}

export interface StudyImage {
  name: string;
  dataUrl: string;
}

export interface StudyAttempt {
  at: number;
  partLabel: string;
  response: string;
  outcome: "unknown" | "wrong";
}

export interface StudyFillAction {
  targetType: "input" | "choice" | "select" | "unknown";
  fieldIndex: number;
  fieldLabel: string;
  choiceLetter: string;
  choiceText: string;
  value: string;
}

export interface StudySolution {
  structured: boolean;
  questionSummary: string;
  finalAnswer: string;
  choiceLetter: string;
  steps: string[];
  fillActions: StudyFillAction[];
  confidence: number;
  needsMoreContext: boolean;
  missingContext: string;
}

export interface StudyAskReply {
  ok: boolean;
  response?: string;
  answer?: string;
  partLabel?: string;
  questionKey?: string;
  interactiveGraph?: boolean;
  solution?: StudySolution;
  error?: string;
}
