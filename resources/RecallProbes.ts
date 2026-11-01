/**
 * POST /RecallProbes — write recall-check questions from the caller's memories
 * (slice 1 of the outcome engine; docs: docs/recall-checks.md).
 *
 * Request:
 *   agentId           string?   — whose read scope to sample. Non-admins: must be
 *                                 omitted or equal the authenticated agent.
 *   count             number?   — memories to write questions for (default 20, max 50)
 *   decoys            number?   — questions nothing should answer (default 5, max 20)
 *   excludeMemoryIds  string[]? — memories that already have a probe
 *
 * Response:
 *   probes   [{ memoryId, question }]
 *   decoys   string[]
 *   eligible number — memories that could have been sampled
 *   model    string — the configured logical model name
 *
 * READ-ONLY: this writes nothing. Probes are kept by the caller (the CLI stores
 * them locally), so a recall check leaves no trace in the store beyond the
 * search hits its later runs make. Sampling applies the SAME read scope as
 * SemanticSearch (resolveReadScope), and the model may only cite ids it was
 * shown, so a probe can never name a memory outside the caller's scope.
 * Superseded rows are skipped: default search hides them, so a probe on one
 * would measure a miss recall is designed to make.
 *
 * Errors mirror MemoryReflect: 503 with a static body when no generative
 * backend is configured, 502 when the model output never validates.
 */

import { Resource, databases } from "harper";
import { setImmediate as yieldToRequests } from "node:timers/promises";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { resolveReadScope } from "./memory-read-scope.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { releaseRequestTransaction, REM_GATHER_YIELD_BUDGET_MS } from "./memory-reflect-lib.js";
import { reflectModelsGenerate } from "./memory-reflect-models.js";
import {
  buildProbePrompt,
  clampCount,
  generateProbes,
  isProbeEligible,
  sampleUpTo,
  DEFAULT_DECOY_COUNT,
  DEFAULT_PROBE_COUNT,
  MAX_DECOY_COUNT,
  MAX_PROBE_COUNT,
} from "./recall-check-lib.js";

const SCAN_SELECT = ["id", "agentId", "visibility", "content", "archived", "expiresAt", "validTo", "tags", "supersedes"];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export class RecallProbes extends Resource {
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any) {
    const { agentId: bodyAgentId, count, decoys, excludeMemoryIds } = data || {};
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return json(401, { error: "authentication required" });

    const authenticatedAgent: string | undefined = auth.kind === "agent" ? auth.agentId : undefined;
    const callerIsAdmin = auth.kind === "agent" && auth.isAdmin;
    if (authenticatedAgent && !callerIsAdmin && bodyAgentId && bodyAgentId !== authenticatedAgent) {
      return json(403, { error: "forbidden: agentId must match authenticated agent" });
    }
    const agentId: string | undefined = authenticatedAgent && !callerIsAdmin ? authenticatedAgent : bodyAgentId;
    if (typeof agentId !== "string" || agentId === "") return json(400, { error: "agentId required" });

    if (authenticatedAgent) {
      const rl = checkRateLimit(authenticatedAgent, "general");
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "general");
    }

    const probeCount = clampCount(count, DEFAULT_PROBE_COUNT, MAX_PROBE_COUNT);
    const decoyCount = clampCount(decoys, DEFAULT_DECOY_COUNT, MAX_DECOY_COUNT);
    const excluded = new Set(Array.isArray(excludeMemoryIds) ? excludeMemoryIds.filter((x: unknown) => typeof x === "string") : []);

    const scope = await resolveReadScope(agentId);
    const now = new Date();
    const eligible: Array<{ id: string; content: string }> = [];
    const superseded = new Set<string>();
    let yieldAt = performance.now() + REM_GATHER_YIELD_BUDGET_MS;
    for await (const record of (databases as any).flair.Memory.search({ select: SCAN_SELECT })) {
      if (performance.now() >= yieldAt) {
        await yieldToRequests();
        yieldAt = performance.now() + REM_GATHER_YIELD_BUDGET_MS;
      }
      if (typeof record.supersedes === "string" && record.supersedes !== "") superseded.add(record.supersedes);
      if (!scope.isAllowed(record) || !isProbeEligible(record, now) || excluded.has(record.id)) continue;
      eligible.push({ id: record.id, content: record.content });
    }
    const candidates = eligible.filter((m) => !superseded.has(m.id));
    const sampled = sampleUpTo(candidates, probeCount);
    const model = process.env.FLAIR_REM_MODEL || undefined;

    if (sampled.length === 0 && decoyCount === 0) {
      return { probes: [], decoys: [], eligible: candidates.length, model: model ?? "default" };
    }

    // Same #1263 rule as MemoryReflect: never hold the request transaction
    // across a generative call that may take longer than Harper's 30s limit.
    await releaseRequestTransaction(ctx);
    const outcome = await generateProbes({
      prompt: buildProbePrompt(sampled, decoyCount),
      model,
      allowedIds: new Set(sampled.map((m) => m.id)),
      maxDecoys: decoyCount,
      generate: reflectModelsGenerate,
    });

    if (!outcome.ok) {
      if (outcome.reason === "no_backend") {
        return json(503, { error: "No generative backend configured. See the models configuration docs." });
      }
      return json(502, { error: "probe_generation_failed", detail: outcome.reason });
    }
    return { probes: outcome.probes, decoys: outcome.decoys, eligible: candidates.length, model: model ?? "default" };
  }
}
