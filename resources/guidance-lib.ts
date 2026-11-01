/**
 * guidance-lib.ts — the pure core of the guidance scan (slice 5b of the outcome
 * engine; docs: docs/growth.md).
 *
 * Two kinds of draft, both only PROPOSED; an operator reviews every one:
 *  - a refinement LINK: a newer version (`supersedes`) that corrects the older
 *    one. Updated is not the same as corrected: "latest is 0.62" replacing
 *    "latest is 0.61" means the facts changed, so the model must say which.
 *  - a LESSON for an area that keeps being refined and has no skill yet,
 *    written for any agent in that area. It names nobody and blames nobody.
 *
 * No table access here (the scan in GuidanceScan.ts does that), so it can be
 * unit-tested directly.
 */
import {
  GENERATE_TEMPERATURE,
  MODEL_BACKEND_NOT_FOUND_ERROR_NAME,
  isIncompleteFinishReason,
  type GenerateFn,
} from "./memory-reflect-lib.js";
import { areasOf, type LedgerRow } from "./guidance-views.js";

/** Refinements an area needs before a lesson is drafted. Global, never per agent. */
export const LESSON_MIN_REFINEMENTS = 3;
/** Per scan, to keep one request inside the default client deadline. */
export const MAX_LINK_JUDGEMENTS = 5;
export const MAX_LESSON_DRAFTS = 2;
const CONTENT_CHARS = 1200;
const MAX_PAIRS = 8;
const LESSON_MAX_CHARS = 1500;
const TRIGGER_MAX_CHARS = 200;

export const linkDraftId = (successorId: string) => `link:${successorId}`;
/** One draft per area per amount of evidence, so a rejected draft is kept when the area is drafted again. */
export const lessonDraftId = (area: string, refinementCount: number) => `lesson:${area}:${refinementCount}`;

export interface LessonCandidate {
  area: string;
  pairs: { original: string; refinement: string }[];
  sourceMemoryIds: string[];
}

/**
 * Areas ready for a lesson: no skill yet, and at least LESSON_MIN_REFINEMENTS
 * refinements where BOTH memories are shared (a lesson is shared org-wide, so
 * private content never feeds one). An area with a pending or promoted lesson
 * draft is skipped; after a rejection it is drafted again only once it has more
 * refinements than any earlier draft had.
 */
export function lessonCandidates(
  rows: readonly LedgerRow[],
  memories: ReadonlyMap<string, any>,
  skills: readonly any[],
  drafts: Iterable<{ kind?: string; area?: string; status: string; refinementCount?: number }>,
): LessonCandidate[] {
  const guided = new Set(skills.flatMap((s) => areasOf(s)));
  const prior = new Map<string, { open: boolean; evidence: number }>();
  for (const d of drafts) {
    if (d.kind !== "lesson" || !d.area) continue;
    const p = prior.get(d.area) ?? { open: false, evidence: 0 };
    prior.set(d.area, { open: p.open || d.status !== "rejected", evidence: Math.max(p.evidence, d.refinementCount ?? 0) });
  }
  const byArea = new Map<string, LessonCandidate>();
  for (const row of rows) {
    if (row.kind !== "refined") continue;
    const original = memories.get(row.memoryId);
    const refinement = row.refinementMemoryId ? memories.get(row.refinementMemoryId) : undefined;
    if (!original || !refinement || original.visibility !== "shared" || refinement.visibility !== "shared" || refinement.archived) continue;
    for (const area of areasOf(original)) {
      if (guided.has(area)) continue;
      const c = byArea.get(area) ?? { area, pairs: [], sourceMemoryIds: [] };
      c.pairs.push({ original: String(original.content ?? ""), refinement: String(refinement.content ?? "") });
      for (const id of [original.id, refinement.id]) if (!c.sourceMemoryIds.includes(id)) c.sourceMemoryIds.push(id);
      byArea.set(area, c);
    }
  }
  return [...byArea.values()]
    .filter((c) => {
      if (c.pairs.length < LESSON_MIN_REFINEMENTS) return false;
      const p = prior.get(c.area);
      return !p || (!p.open && c.pairs.length > p.evidence);
    })
    .sort((a, b) => b.pairs.length - a.pairs.length || a.area.localeCompare(b.area));
}

export const LINK_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["corrects", "updates"] }, reason: { type: "string" } },
  required: ["verdict", "reason"],
};

export function buildLinkPrompt(earlier: string, later: string): string {
  return [
    "A later memory replaced an earlier one. Decide which is true:",
    '- "corrects": the earlier memory was inaccurate or incomplete when it was written, and the later one is more accurate.',
    '- "updates": the earlier memory was right at the time; the facts changed since (a new version, a new date, a new owner).',
    'If unsure, answer "updates". Give a one-sentence reason about the content, never about who wrote it.',
    "",
    `Earlier: ${earlier.slice(0, CONTENT_CHARS)}`,
    "",
    `Later: ${later.slice(0, CONTENT_CHARS)}`,
    "",
    'Reply as JSON: {"verdict": "corrects" | "updates", "reason": "..."}',
  ].join("\n");
}

export function parseLinkOutput(content: string): { verdict: "corrects" | "updates"; reason: string } | null {
  const p = parseJson(content);
  if ((p?.verdict !== "corrects" && p?.verdict !== "updates") || typeof p.reason !== "string") return null;
  return { verdict: p.verdict, reason: p.reason.trim().slice(0, 500) };
}

export const LESSON_SCHEMA = {
  type: "object",
  properties: { trigger: { type: "string" }, lesson: { type: "string" } },
  required: ["trigger", "lesson"],
};

export function buildLessonPrompt(c: LessonCandidate): string {
  const pairs = c.pairs.slice(0, MAX_PAIRS).map((p, i) =>
    `${i + 1}. First understanding: ${p.original.slice(0, CONTENT_CHARS)}\n   More accurate: ${p.refinement.slice(0, CONTENT_CHARS)}`);
  return [
    `Agents working on "${c.area}" keep refining what they know. Below, each item is a first`,
    "understanding and the more accurate version someone added later.",
    "Write ONE short, practical lesson that would help any agent get this right the first time.",
    "Rules: say what to do, not what went wrong; do not name or blame anyone; use only what the",
    "items say. Also write a trigger: one line starting with \"When\" that says when the lesson applies.",
    "",
    ...pairs,
    "",
    'Reply as JSON: {"trigger": "When ...", "lesson": "..."}',
  ].join("\n");
}

export function parseLessonOutput(content: string): { trigger: string; lesson: string } | null {
  const p = parseJson(content);
  if (typeof p?.trigger !== "string" || typeof p.lesson !== "string") return null;
  const trigger = p.trigger.trim().slice(0, TRIGGER_MAX_CHARS);
  const lesson = p.lesson.trim().slice(0, LESSON_MAX_CHARS);
  return trigger && lesson ? { trigger, lesson } : null;
}

function parseJson(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export type GenerateFailure = "no_backend" | "generate_failed" | "validation_failed" | "incomplete_generation";

/** One schema-mode call, one json-mode retry — the same budget as generateAnswer. */
export async function generateParsed<T>(params: {
  prompt: string;
  schema: object;
  parse: (content: string) => T | null;
  model?: string;
  maxTokens: number;
  generate: GenerateFn;
}): Promise<{ ok: true; value: T } | { ok: false; reason: GenerateFailure }> {
  const { prompt, schema, parse, model, maxTokens, generate } = params;
  const baseOpts = { ...(model ? { model } : {}), temperature: GENERATE_TEMPERATURE, maxTokens };
  let failure: GenerateFailure = "validation_failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: { content: string; finishReason?: string };
    try {
      result = await generate(prompt, { ...baseOpts, responseFormat: attempt === 1 ? "json" : { schema } });
    } catch (err: any) {
      return { ok: false, reason: err?.name === MODEL_BACKEND_NOT_FOUND_ERROR_NAME ? "no_backend" : "generate_failed" };
    }
    if (isIncompleteFinishReason(result.finishReason)) {
      failure = "incomplete_generation";
      continue;
    }
    const value = parse(result.content);
    if (value !== null) return { ok: true, value };
    failure = "validation_failed";
  }
  return { ok: false, reason: failure };
}
