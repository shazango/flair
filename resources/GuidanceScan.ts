/**
 * POST /GuidanceScan — operators (and the REM nightly runner, when it has admin
 * credentials): propose refinement links and lessons for review (slice 5b of
 * the outcome engine; docs: docs/growth.md). Pure logic lives in
 * guidance-lib.ts.
 *
 * Response: { linksProposed, notCorrections, lessonsDrafted, failed, skipped? }
 *   skipped: "no_backend" when no generative backend is configured.
 *
 * Writes only GuidanceDraft rows. Nothing is applied: every draft waits for
 * POST /GuidanceReview. Each scan judges at most MAX_LINK_JUDGEMENTS successors
 * and drafts at most MAX_LESSON_DRAFTS lessons, so repeated nightly runs work
 * through a backlog. A successor is judged once (its draft id is deterministic).
 */

import { Resource, databases } from "harper";
import { allowAdmin } from "./agent-auth.js";
import { releaseRequestTransaction } from "./memory-reflect-lib.js";
import { reflectModelsGenerate } from "./memory-reflect-models.js";
import { loadLedger } from "./guidance-views.js";
import {
  LESSON_SCHEMA,
  LINK_SCHEMA,
  MAX_LESSON_DRAFTS,
  MAX_LINK_JUDGEMENTS,
  buildLessonPrompt,
  buildLinkPrompt,
  generateParsed,
  lessonCandidates,
  lessonDraftId,
  linkDraftId,
  parseLessonOutput,
  parseLinkOutput,
} from "./guidance-lib.js";

/** The one GuidanceDraft writer (scan and review). */
export async function saveDraft(row: Record<string, unknown>): Promise<void> {
  await (databases as any).flair.GuidanceDraft.put(row);
}

export class GuidanceScan extends Resource {
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async post() {
    const db = (databases as any).flair;
    const { rows, memories, skills } = await loadLedger();
    const drafts = new Map<string, any>();
    for await (const d of db.GuidanceDraft.search({})) drafts.set(d.id, d);

    const linked = new Set(rows.filter((r) => r.kind === "refined").map((r) => `${r.memoryId}>${r.refinementMemoryId}`));
    const successors: any[] = [];
    // ponytail: full Memory scan for `supersedes`; an indexed not-null query if this gets slow.
    for await (const m of db.Memory.search({ select: ["id", "agentId", "content", "archived", "supersedes"] })) {
      if (!m.supersedes || m.archived || drafts.has(linkDraftId(m.id)) || linked.has(`${m.supersedes}>${m.id}`)) continue;
      const earlier = await db.Memory.get(m.supersedes).catch(() => null);
      if (earlier) successors.push({ later: m, earlier });
      if (successors.length >= MAX_LINK_JUDGEMENTS) break;
    }
    const lessons = lessonCandidates(rows, memories, skills, drafts.values()).slice(0, MAX_LESSON_DRAFTS);

    // Never hold the request transaction across generative calls (#1263).
    await releaseRequestTransaction((this as any).getContext?.());
    const model = process.env.FLAIR_REM_MODEL || undefined;
    const out = { linksProposed: 0, notCorrections: 0, lessonsDrafted: 0, failed: 0 };
    const base = () => ({ generatedBy: model ?? null, generatedAt: new Date().toISOString() });

    for (const { later, earlier } of successors) {
      const r = await generateParsed({
        prompt: buildLinkPrompt(String(earlier.content ?? ""), String(later.content ?? "")),
        schema: LINK_SCHEMA, parse: parseLinkOutput, model, maxTokens: 300, generate: reflectModelsGenerate,
      });
      if (!r.ok) {
        if (r.reason === "no_backend") return { ...out, skipped: "no_backend" };
        out.failed++;
        continue;
      }
      const corrects = r.value.verdict === "corrects";
      await saveDraft({
        id: linkDraftId(later.id), kind: "link", status: corrects ? "pending" : "not_a_correction",
        memoryId: earlier.id, refinementMemoryId: later.id, content: r.value.reason, ...base(),
      });
      if (corrects) out.linksProposed++;
      else out.notCorrections++;
    }

    for (const c of lessons) {
      const r = await generateParsed({
        prompt: buildLessonPrompt(c), schema: LESSON_SCHEMA, parse: parseLessonOutput, model, maxTokens: 800, generate: reflectModelsGenerate,
      });
      if (!r.ok) {
        if (r.reason === "no_backend") return { ...out, skipped: "no_backend" };
        out.failed++;
        continue;
      }
      await saveDraft({
        id: lessonDraftId(c.area, c.pairs.length), kind: "lesson", status: "pending", area: c.area, trigger: r.value.trigger,
        content: r.value.lesson, sourceMemoryIds: c.sourceMemoryIds, refinementCount: c.pairs.length, ...base(),
      });
      out.lessonsDrafted++;
    }
    return out;
  }
}
