/**
 * POST /Growth — one agent's own record of improvement (slice 5a of the outcome
 * engine; docs: docs/growth.md). See guidance-views.ts.
 *
 * Request:  { agentId? } — non-admins: omit or self. Operators may name any agent.
 * Response: { agentId, steady: { confirmations, memoriesConfirmed, byMonth },
 *             refinedAreas: [{ area, refinements, guidance: skillIds }],
 *             unlabelledRefinements, refinementsGiven }
 *
 * Never names who confirmed or refined. Read-only.
 */

import { Resource } from "harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { growthFor } from "./guidance-views.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export class Growth extends Resource {
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any) {
    const requested = typeof data?.agentId === "string" && data.agentId ? data.agentId : undefined;
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") return json(401, { error: "authentication required" });
    let agentId = requested;
    if (auth.kind === "agent") {
      if (requested && requested !== auth.agentId && !auth.isAdmin) {
        return json(403, { error: "growth is visible only to the agent itself and operators" });
      }
      const rl = checkRateLimit(auth.agentId, "general");
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "general");
      agentId ??= auth.agentId;
    }
    if (!agentId) return json(400, { error: "agentId required" });
    return growthFor(agentId);
  }
}
