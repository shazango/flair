/**
 * ask-lib.ts — the pure core behind POST /Ask (`ask`, slice 3 of the outcome
 * engine; docs: docs/ask.md).
 *
 * `ask` answers a question ONLY from the memories search returned for it, and
 * cites them by number. This module owns the prompt, validating the model's
 * output, and dropping any citation that does not map to a supplied memory —
 * so an answer can never point at a memory the caller was not shown.
 *
 * Harper-free, like ./recall-check-lib.ts, so it can be unit-tested directly.
 */
import {
  GENERATE_TEMPERATURE,
  MODEL_BACKEND_NOT_FOUND_ERROR_NAME,
  isIncompleteFinishReason,
  type GenerateFn,
} from "./memory-reflect-lib.js";

export const DEFAULT_ASK_LIMIT = 5;
export const MAX_ASK_LIMIT = 10;
/** Per-memory content cap inside the prompt (keeps one call bounded). */
export const ASK_CONTENT_CHARS = 1500;
const ANSWER_MAX_CHARS = 4000;
const ASK_MAX_TOKENS = 1200;

export interface AskSource {
  content: string;
  createdAt?: string;
}

export const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

export function buildAskPrompt(question: string, sources: readonly AskSource[]): string {
  const numbered = sources
    .map((s, i) => {
      const date = s.createdAt ? ` (${String(s.createdAt).slice(0, 10)})` : "";
      return `[${i + 1}]${date} ${s.content.slice(0, ASK_CONTENT_CHARS)}`;
    })
    .join("\n\n");
  return [
    "Answer the question using ONLY the numbered memories below. Cite every claim with the",
    "number of the memory it comes from, like [1] or [2][3]. Do not use outside knowledge.",
    "If the memories do not answer the question, say so plainly instead of guessing.",
    "If memories disagree, present both views with their citations; do not pick a winner.",
    "Keep the answer short.",
    "",
    `Question: ${question}`,
    "",
    "Memories:",
    numbered,
    "",
    'Reply as JSON: {"answer": "..."}',
  ].join("\n");
}

/**
 * Keep the answer text, strip citation markers that name no supplied memory,
 * and return the cited numbers (1-based, ascending). null when the output is
 * not a usable answer.
 */
export function parseAnswerOutput(content: string, sourceCount: number): { answer: string; citations: number[] } | null {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed?.answer !== "string") return null;
  const cited = new Set<number>();
  const answer = parsed.answer
    .replace(/\[(\d+)\]/g, (marker: string, n: string) => {
      const k = Number(n);
      if (k >= 1 && k <= sourceCount) {
        cited.add(k);
        return marker;
      }
      return "";
    })
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, ANSWER_MAX_CHARS);
  if (answer === "") return null;
  return { answer, citations: [...cited].sort((a, b) => a - b) };
}

export type GenerateAnswerOutcome =
  | { ok: true; answer: string; citations: number[] }
  | { ok: false; reason: "no_backend" | "generate_failed" | "validation_failed" | "incomplete_generation" };

/** One schema-mode call, one json-mode retry — the same budget as generateProbes. */
export async function generateAnswer(params: {
  prompt: string;
  model?: string;
  sourceCount: number;
  generate: GenerateFn;
}): Promise<GenerateAnswerOutcome> {
  const { prompt, model, sourceCount, generate } = params;
  const baseOpts = { ...(model ? { model } : {}), temperature: GENERATE_TEMPERATURE, maxTokens: ASK_MAX_TOKENS };
  let failureReason: "validation_failed" | "incomplete_generation" = "validation_failed";

  for (let attempt = 0; attempt < 2; attempt++) {
    const responseFormat: "json" | { schema: object } = attempt === 1 ? "json" : { schema: ANSWER_SCHEMA };
    let result: { content: string; finishReason?: string };
    try {
      result = await generate(prompt, { ...baseOpts, responseFormat });
    } catch (err: any) {
      if (err?.name === MODEL_BACKEND_NOT_FOUND_ERROR_NAME) return { ok: false, reason: "no_backend" };
      return { ok: false, reason: "generate_failed" };
    }
    if (isIncompleteFinishReason(result.finishReason)) {
      failureReason = "incomplete_generation";
      continue;
    }
    const parsed = parseAnswerOutput(result.content, sourceCount);
    if (parsed) return { ok: true, ...parsed };
    failureReason = "validation_failed";
  }
  return { ok: false, reason: failureReason };
}
