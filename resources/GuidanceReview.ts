/**
 * POST /GuidanceReview — operators decide a guidance draft (slice 5b of the
 * outcome engine; docs: docs/growth.md). See GuidanceScan.ts.
 *
 * Request: { draftId, decision: "promote" | "reject", rationale, agentId? }
 *   rationale is required either way (no rubber-stamp, as for REM candidates).
 *   agentId — lesson promote only: the agent the skill is published under (an
 *   operator's own or a shared ops agent). The lesson text names nobody.
 *
 * Promote:
 *   lesson — writes a shared, persistent skill (tags ["skill"], the draft's
 *            trigger, subject = area) through Memory.put, so SkillScan and every
 *            other Memory write rule apply. Response carries memoryId.
 *   link   — records the refinement in MemoryOutcome, reported by the later
 *            memory's author (recordOutcome's usual rules apply).
 * Reject keeps the draft, marked rejected.
 */

import { Resource, databases } from "harper";
import { randomUUID } from "node:crypto";
import { allowAdmin, resolveAgentAuth } from "./agent-auth.js";
import { Memory } from "./Memory.js";
import { withComposedWriteTransaction } from "./request-transaction.js";
import { recordOutcome } from "./outcome-recording.js";
import { SKILL_TAG } from "./skill-write.js";
import { saveDraft } from "./GuidanceScan.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export class GuidanceReview extends Resource {
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async post(data: any) {
    const ctx = (this as any).getContext?.();
    const { draftId, decision, rationale, agentId } = data || {};
    if (typeof draftId !== "string" || !draftId) return json(400, { error: "draftId required" });
    if (decision !== "promote" && decision !== "reject") return json(400, { error: 'decision must be "promote" or "reject"' });
    if (typeof rationale !== "string" || !rationale.trim()) return json(400, { error: "rationale required" });
    const db = (databases as any).flair;
    const draft = await db.GuidanceDraft.get(draftId);
    if (!draft) return json(404, { error: "draft not found" });
    if (draft.status !== "pending") return json(409, { error: "draft is not pending" });
    const auth = await resolveAgentAuth(ctx);
    const reviewerId = auth.kind === "agent" ? auth.agentId : "admin";
    const decidedAt = new Date().toISOString();
    const decided = { ...draft, reviewerId, reviewRationale: rationale.trim(), decidedAt };

    if (decision === "reject") {
      await saveDraft({ ...decided, status: "rejected" });
      return { draftId, status: "rejected" };
    }

    if (draft.kind === "link") {
      const later = await db.Memory.get(draft.refinementMemoryId).catch(() => null);
      if (!later) return json(409, { error: "the later memory no longer exists" });
      const r = await recordOutcome(ctx, later.agentId, { memoryId: draft.memoryId, kind: "refined", refinementMemoryId: later.id }, decidedAt);
      if (r !== "recorded") return json(409, { error: "the later memory cannot refine the earlier one" });
      await saveDraft({ ...decided, status: "promoted" });
      return { draftId, status: "promoted" };
    }

    if (typeof agentId !== "string" || !agentId) return json(400, { error: "agentId required: the agent the skill is published under" });
    const memoryId = `guidance-${randomUUID()}`;
    const written = await withComposedWriteTransaction(ctx, (shared) => (Memory as any).put({
      id: memoryId, agentId, content: draft.content, trigger: draft.trigger, subject: draft.area,
      tags: [SKILL_TAG], durability: "persistent", visibility: "shared",
      derivedFrom: draft.sourceMemoryIds ?? [], createdAt: decidedAt,
    }, shared));
    if (written instanceof Response && !written.ok) return written;
    await saveDraft({ ...decided, status: "promoted", promotedMemoryId: memoryId });
    return { draftId, status: "promoted", memoryId };
  }
}
