/**
 * recall-check-lib.ts — the pure core behind POST /RecallProbes (recall
 * checks, slice 1 of the outcome engine; docs: docs/recall-checks.md).
 *
 * A recall check asks: on THIS instance's data, does recall find the memory a
 * question is about, and does it abstain on a question nothing answers? It
 * grades the instance's retrieval, never an agent. This module owns the
 * server-side half: which memories may seed a probe, the probe prompt, and
 * validating the model's output. Running probes and scoring them is the CLI's
 * job (src/lib/recall-check.ts) — it goes through POST /SemanticSearch like any
 * other reader, so a probe measures exactly the path agents use.
 *
 * Harper-free, like ./memory-reflect-lib.ts (whose generate plumbing it reuses),
 * so it can be unit-tested directly.
 */
import {
  GENERATE_TEMPERATURE,
  MODEL_BACKEND_NOT_FOUND_ERROR_NAME,
  isIncompleteFinishReason,
  type GenerateFn,
} from "./memory-reflect-lib.js";

/** A memory shorter than this is too thin to ask a distinct question about. */
export const PROBE_MIN_CONTENT_LENGTH = 40;
/** Per-memory content cap inside the prompt (keeps one call bounded). */
export const PROBE_CONTENT_CHARS = 1200;
export const DEFAULT_PROBE_COUNT = 20;
export const MAX_PROBE_COUNT = 50;
export const DEFAULT_DECOY_COUNT = 5;
export const MAX_DECOY_COUNT = 20;
const QUESTION_MIN = 10;
const QUESTION_MAX = 300;
// One probe question + id is ~60 tokens; leave room for the decoys too.
const PROBE_MAX_TOKENS = 4000;

export interface ProbeSourceRecord {
  id?: unknown;
  content?: unknown;
  archived?: unknown;
  expiresAt?: unknown;
  validTo?: unknown;
  tags?: unknown;
}

/**
 * Whether a stored row may seed a probe. Mirrors what default SemanticSearch
 * would never return (archived, TTL-expired, past validTo), so a probe is never
 * built on a memory recall is SUPPOSED to miss. Skill rows are excluded: they
 * embed from `trigger`, not `content` (resources/skill-write.ts), so a question
 * written from their content measures the wrong text. Read scope and
 * supersession are the caller's checks — they need state this function lacks.
 */
export function isProbeEligible(record: ProbeSourceRecord, now: Date): boolean {
  if (typeof record.id !== "string" || record.id === "") return false;
  if (record.archived === true) return false;
  if (typeof record.content !== "string" || record.content.trim().length < PROBE_MIN_CONTENT_LENGTH) return false;
  if (typeof record.expiresAt === "string" && record.expiresAt !== "" && new Date(record.expiresAt) <= now) return false;
  if (typeof record.validTo === "string" && record.validTo !== "" && new Date(record.validTo) <= now) return false;
  if (Array.isArray(record.tags) && record.tags.includes("skill")) return false;
  return true;
}

/** Up to `n` items chosen uniformly at random (partial Fisher–Yates; input untouched). */
export function sampleUpTo<T>(items: readonly T[], n: number, random: () => number = Math.random): T[] {
  const pool = items.slice();
  const take = Math.max(0, Math.min(n, pool.length));
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

/** Clamp a caller-supplied count into [0, max], falling back to `dflt`. */
export function clampCount(value: unknown, dflt: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return dflt;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

export const PROBES_SCHEMA = {
  type: "object",
  properties: {
    probes: {
      type: "array",
      items: {
        type: "object",
        properties: { memoryId: { type: "string" }, question: { type: "string" } },
        required: ["memoryId", "question"],
      },
    },
    decoys: { type: "array", items: { type: "string" } },
  },
  required: ["probes", "decoys"],
} as const;

export function buildProbePrompt(memories: ReadonlyArray<{ id: string; content: string }>, decoyCount: number): string {
  const listed = memories
    .map((m) => `[${m.id}]\n${m.content.slice(0, PROBE_CONTENT_CHARS)}`)
    .join("\n\n");
  return [
    "You are writing test questions for a memory search system.",
    "",
    "For EACH memory below, write one question that the memory answers, the way a",
    "teammate who needed that information would actually ask it. Rules:",
    "- Paraphrase. Do not copy distinctive words or phrases from the memory; the",
    "  test is whether search finds it by meaning, not by keyword.",
    "- The question must be answerable from that memory alone.",
    "- Use the memory's id exactly as given in brackets.",
    "",
    `Then write ${decoyCount} decoy question(s): plausible questions in the same general`,
    "domain that NONE of the memories below answer.",
    "",
    'Respond with JSON only: {"probes":[{"memoryId":"...","question":"..."}],"decoys":["..."]}',
    "",
    "Memories:",
    "",
    listed,
  ].join("\n");
}

export interface ParsedProbes {
  probes: Array<{ memoryId: string; question: string }>;
  decoys: string[];
}

function cleanQuestion(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const s = q.trim().replace(/\s+/g, " ");
  return s.length >= QUESTION_MIN && s.length <= QUESTION_MAX ? s : null;
}

/**
 * Validate model output. Lenient per item, strict on shape: a malformed item
 * is dropped (one bad question must not waste the whole call), but an
 * unparseable payload, a wrong top-level shape, or zero usable items is a
 * failure. A memoryId outside `allowedIds` is dropped — the model may only
 * cite what it was shown, so a probe can never point at a memory outside the
 * caller's read scope.
 */
export function parseProbeOutput(content: string, allowedIds: ReadonlySet<string>, maxDecoys: number): ParsedProbes | null {
  let raw: any;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.probes) || !Array.isArray(raw.decoys)) return null;

  const seen = new Set<string>();
  const probes: ParsedProbes["probes"] = [];
  for (const p of raw.probes) {
    const memoryId = typeof p?.memoryId === "string" ? p.memoryId.trim() : "";
    const question = cleanQuestion(p?.question);
    if (!question || !allowedIds.has(memoryId) || seen.has(memoryId)) continue;
    seen.add(memoryId);
    probes.push({ memoryId, question });
  }

  const decoySet = new Set<string>();
  for (const d of raw.decoys) {
    const q = cleanQuestion(d);
    if (q && decoySet.size < maxDecoys) decoySet.add(q);
  }

  if (probes.length === 0 && decoySet.size === 0) return null;
  return { probes, decoys: [...decoySet] };
}

export type GenerateProbesOutcome =
  | { ok: true; probes: ParsedProbes["probes"]; decoys: string[] }
  | { ok: false; reason: "no_backend" | "generate_failed" | "validation_failed" | "incomplete_generation" };

/**
 * One schema-mode call, one json-mode retry — the same budget and failure
 * classes as REM's generateCandidates (./memory-reflect-lib.ts).
 */
export async function generateProbes(params: {
  prompt: string;
  model?: string;
  allowedIds: ReadonlySet<string>;
  maxDecoys: number;
  generate: GenerateFn;
}): Promise<GenerateProbesOutcome> {
  const { prompt, model, allowedIds, maxDecoys, generate } = params;
  const baseOpts = { ...(model ? { model } : {}), temperature: GENERATE_TEMPERATURE, maxTokens: PROBE_MAX_TOKENS };
  let failureReason: "validation_failed" | "incomplete_generation" = "validation_failed";

  for (let attempt = 0; attempt < 2; attempt++) {
    const responseFormat: "json" | { schema: object } = attempt === 1 ? "json" : { schema: PROBES_SCHEMA };
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
    const parsed = parseProbeOutput(result.content, allowedIds, maxDecoys);
    if (parsed) return { ok: true, ...parsed };
    failureReason = "validation_failed";
  }
  return { ok: false, reason: failureReason };
}
