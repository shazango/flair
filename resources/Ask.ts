/**
 * POST /Ask — answer a question from memory, with cited sources and their trust
 * evidence (`ask`, slice 3 of the outcome engine; docs: docs/ask.md).
 *
 * Request:
 *   q        string   — the question
 *   agentId  string?  — whose read scope to search (non-admins: omit or self;
 *                       SemanticSearch enforces it)
 *   limit    number?  — memories to answer from (default 5, max 10)
 *
 * Response:
 *   abstained  boolean — search found nothing that clears the global confidence
 *                        threshold; no answer is written (bestScore/threshold say why)
 *   answer     string | null — cites sources as [n]; null when abstained, when there
 *                        are no sources, or when no answer could be written
 *   citations  number[] — the [n] the answer actually cites
 *   sources    [{ n, id, content, createdAt, trust }] — numbered as in the answer
 *   answerUnavailable? "no_backend" | "generate_failed" | "validation_failed" |
 *                      "incomplete_generation" — why answer is null despite sources;
 *                      the sources are still returned (the no-LLM fallback)
 *   model      string | null
 *
 * The search is the caller's own SemanticSearch with includeTrust + abstain,
 * run under the caller's request context: same read scope, same rate limit, same
 * hit tracking as a plain search. Ask writes nothing, and never records usage
 * from the model's citations (the #623 self-reinforcing loop); confirming an
 * answer is an explicit later step.
 */

import { Resource } from "harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { releaseRequestTransaction } from "./memory-reflect-lib.js";
import { reflectModelsGenerate } from "./memory-reflect-models.js";
import { clampCount } from "./recall-check-lib.js";
import { buildAskPrompt, generateAnswer, DEFAULT_ASK_LIMIT, MAX_ASK_LIMIT } from "./ask-lib.js";
import { SemanticSearch } from "./SemanticSearch.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export class Ask extends Resource {
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any) {
    const { q, agentId, limit } = data || {};
    if (typeof q !== "string" || q.trim() === "") return json(400, { error: "q required" });
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return json(401, { error: "authentication required" });
    if (auth.kind === "agent") {
      const rl = checkRateLimit(auth.agentId, "general");
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "general");
    }

    const search: any = await new (SemanticSearch as any)(undefined, ctx).post({
      ...(agentId ? { agentId } : {}),
      q,
      limit: clampCount(limit, DEFAULT_ASK_LIMIT, MAX_ASK_LIMIT),
      includeTrust: true,
      abstain: true,
    });
    if (search instanceof Response) return search;

    const model = process.env.FLAIR_REM_MODEL || undefined;
    const base = { bestScore: search.bestScore ?? null, threshold: search.threshold ?? null, model: model ?? null };
    if (search.abstained) return { abstained: true, answer: null, citations: [], sources: [], ...base };

    const sources = (search.results ?? []).map((r: any, i: number) => ({
      n: i + 1, id: r.id, content: r.content, createdAt: r.createdAt ?? null, trust: r.trust ?? null,
    }));
    if (sources.length === 0) return { abstained: false, answer: null, citations: [], sources, ...base };

    // Same #1263 rule as MemoryReflect: never hold the request transaction
    // across a generative call that may take longer than Harper's 30s limit.
    await releaseRequestTransaction(ctx);
    const outcome = await generateAnswer({
      prompt: buildAskPrompt(q, sources),
      model,
      sourceCount: sources.length,
      generate: reflectModelsGenerate,
    });
    if (!outcome.ok) {
      return { abstained: false, answer: null, citations: [], sources, answerUnavailable: outcome.reason, ...base };
    }
    return { abstained: false, answer: outcome.answer, citations: outcome.citations, sources, ...base };
  }
}
