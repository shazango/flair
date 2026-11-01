/**
 * POST /GuidanceAreas — operators: which areas draw refinements, and whether
 * guidance exists for them (slice 5a of the outcome engine; docs:
 * docs/growth.md). See guidance-views.ts.
 *
 * Response: { areas: [{ area, refinements, memoriesRefined, guidance }], unlabelled, computedAt }
 *
 * By area only: no agent id appears anywhere in the response. Admin-only, like
 * the other instance-wide views (MemoryDedupStats). Read-only.
 */

import { Resource } from "harper";
import { allowAdmin } from "./agent-auth.js";
import { guidanceAreas } from "./guidance-views.js";

export class GuidanceAreas extends Resource {
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async post() {
    return guidanceAreas();
  }
}
