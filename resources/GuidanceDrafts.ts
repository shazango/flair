/**
 * POST /GuidanceDrafts — operators list guidance drafts (slice 5b of the outcome
 * engine). See GuidanceScan.ts and GuidanceReview.ts.
 *
 * Request:  { status? } — default "pending"; "all" for every draft.
 * Response: { drafts: GuidanceDraft[] } — newest first. A link draft carries the
 *           two memories' content so a reviewer can judge it; it names no memory authors.
 */

import { Resource, databases } from "harper";
import { allowAdmin } from "./agent-auth.js";

export class GuidanceDrafts extends Resource {
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async post(data: any) {
    const status = typeof data?.status === "string" && data.status ? data.status : "pending";
    const db = (databases as any).flair;
    const query = status === "all" ? {} : { conditions: [{ attribute: "status", comparator: "equals", value: status }] };
    const drafts: any[] = [];
    for await (const d of db.GuidanceDraft.search(query)) {
      if (d.kind === "link") {
        const [earlier, later] = await Promise.all([d.memoryId, d.refinementMemoryId].map((id) => db.Memory.get(id).catch(() => null)));
        drafts.push({ ...d, earlier: earlier?.content ?? null, later: later?.content ?? null });
      } else drafts.push({ ...d });
    }
    drafts.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
    return { drafts };
  }
}
