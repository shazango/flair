/**
 * POST /RecordOutcome — "this held up" or "here is something more accurate"
 * (slice 4 of the outcome engine; docs: docs/ask.md).
 *
 * Request:
 *   memoryId            string — the memory the outcome is about
 *   kind                "confirmed" | "refined"
 *   refinementMemoryId  string — kind "refined" only: a memory the caller wrote
 *                                with the more accurate information
 *
 * Response: { recorded: true } for every valid request (a fresh row, a repeat,
 * or a memory that is absent or outside the caller's read scope), so the
 * endpoint cannot be used to probe ids. 400 when the body is malformed or
 * refinementMemoryId does not name a memory the caller wrote.
 *
 * Same access model and rate-limit bucket as POST /RecordUsage: a verified
 * agent, its read scope, no ownership. The ledger core and its rules live in
 * ./outcome-recording.ts. Outcomes never gate reads or grant authority.
 */
import { Resource } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { recordOutcome, OUTCOME_KINDS, type OutcomeKind } from "./outcome-recording.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

export class RecordOutcome extends Resource {
  async allowCreate(): Promise<boolean> {
    return (await resolveAgentAuth((this as any).getContext?.())).kind !== "anonymous";
  }

  async post(data: any) {
    const ctx = (this as any).getContext?.();
    const auth = await resolveAgentAuth(ctx);
    if (auth.kind === "anonymous") return json(401, { error: "authentication required" });
    // The ledger is keyed by the reporting agent; there is no one to attribute
    // an internal or agentless admin call to.
    if (auth.kind !== "agent") return json(400, { error: "outcomes require a verified agent identity" });

    const rl = checkRateLimit(auth.agentId, "usage");
    if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "usage");

    const { memoryId, kind, refinementMemoryId } = data || {};
    if (!isId(memoryId)) return json(400, { error: "memoryId required" });
    if (!OUTCOME_KINDS.includes(kind)) return json(400, { error: `kind must be one of: ${OUTCOME_KINDS.join(", ")}` });
    if (kind === "refined" && !isId(refinementMemoryId)) {
      return json(400, { error: "a refinement needs refinementMemoryId: write the more accurate memory first" });
    }

    const result = await recordOutcome(
      ctx,
      auth.agentId,
      { memoryId, kind: kind as OutcomeKind, ...(kind === "refined" ? { refinementMemoryId } : {}) },
      new Date().toISOString(),
    );
    if (result === "bad_refinement") {
      return json(400, { error: "refinementMemoryId must name another memory you wrote" });
    }
    return { recorded: true };
  }
}
