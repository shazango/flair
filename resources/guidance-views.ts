/**
 * guidance-views.ts — read-only views over the MemoryOutcome ledger (slice 5a
 * of the outcome engine; docs: docs/growth.md).
 *
 * Growth, not blame. Two views, and neither ranks agents:
 *  - growthFor (POST /Growth): ONE agent's own record of improvement — others'
 *    confirmations of its memories over time (the steady trend), the areas its
 *    memories have been refined in, the guidance (skills) it can read for those
 *    areas, and the refinements it has given. Shown only to that agent and to
 *    operators; never who confirmed or refined.
 *  - guidanceAreas (POST /GuidanceAreas, operators): which AREAS draw refinements
 *    and whether guidance exists for them. Counts by area only: the response
 *    carries no agent id, so it cannot become a list of who got things wrong.
 *
 * An AREA is what a memory is about: its `subject` and its attention-plane
 * `entities`, never who wrote it. `agent:` and `person:` labels are left out
 * so an area is never a person. A refined memory with neither is "unlabelled".
 *
 * Nothing here writes, and nothing feeds back into ranking or read scope.
 */
import { databases } from "harper";
import { resolveReadScope } from "./memory-read-scope.js";
import { SKILL_TAG } from "./skill-write.js";
import type { OutcomeRow } from "./outcome-recording.js";

export interface LedgerRow extends OutcomeRow {
  createdAt?: string;
}

const PERSON_LABEL = /^(agent|person):/i;

/** The areas a memory is about: subject and entities, minus people. */
export function areasOf(memory: any): string[] {
  const labels = [memory?.subject, ...(Array.isArray(memory?.entities) ? memory.entities : [])];
  const out = new Set<string>();
  for (const l of labels) if (typeof l === "string" && l.trim() && !PERSON_LABEL.test(l.trim())) out.add(l.trim());
  return [...out];
}

function skillsByArea(skills: readonly any[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of skills) for (const a of areasOf(s)) out.set(a, [...(out.get(a) ?? []), s.id]);
  return out;
}

export interface AreaCount {
  area: string;
  /** Refinement reports on memories in this area. */
  refinements: number;
  /** Distinct memories in this area that were refined. */
  memoriesRefined: number;
  /** Skills about this area. */
  guidance: number;
}

/** Pure: refinements per area across the instance, most refined first. */
export function summarizeAreas(rows: readonly LedgerRow[], memories: ReadonlyMap<string, any>, skills: readonly any[]) {
  const byArea = new Map<string, { refinements: number; memories: Set<string> }>();
  let unlabelled = 0;
  for (const row of rows) {
    const memory = row.kind === "refined" ? memories.get(row.memoryId) : undefined;
    if (!memory) continue;
    const areas = areasOf(memory);
    if (areas.length === 0) unlabelled++;
    for (const area of areas) {
      const a = byArea.get(area) ?? { refinements: 0, memories: new Set<string>() };
      a.refinements++;
      a.memories.add(row.memoryId);
      byArea.set(area, a);
    }
  }
  const guidance = skillsByArea(skills);
  const areas: AreaCount[] = [...byArea].map(([area, a]) => ({
    area, refinements: a.refinements, memoriesRefined: a.memories.size, guidance: guidance.get(area)?.length ?? 0,
  }));
  areas.sort((x, y) => y.refinements - x.refinements || x.area.localeCompare(y.area));
  return { areas, unlabelled };
}

/** Pure: one agent's growth. `skills` must already be limited to what the agent can read. */
export function summarizeGrowth(agentId: string, rows: readonly LedgerRow[], memories: ReadonlyMap<string, any>, skills: readonly any[]) {
  const confirmedMemories = new Set<string>();
  const byMonth = new Map<string, number>();
  const refinedAreas = new Map<string, number>();
  let confirmations = 0;
  let unlabelled = 0;
  let refinementsGiven = 0;
  for (const row of rows) {
    const memory = memories.get(row.memoryId);
    if (!memory) continue;
    if (row.kind === "refined" && row.agentId === agentId && memory.agentId !== agentId) refinementsGiven++;
    if (memory.agentId !== agentId) continue;
    if (row.kind === "confirmed" && row.agentId !== agentId) {
      confirmations++;
      confirmedMemories.add(row.memoryId);
      const month = typeof row.createdAt === "string" ? row.createdAt.slice(0, 7) : "unknown";
      byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
    }
    if (row.kind === "refined") {
      const areas = areasOf(memory);
      if (areas.length === 0) unlabelled++;
      for (const a of areas) refinedAreas.set(a, (refinedAreas.get(a) ?? 0) + 1);
    }
  }
  const guidance = skillsByArea(skills);
  return {
    agentId,
    steady: {
      confirmations,
      memoriesConfirmed: confirmedMemories.size,
      byMonth: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, n]) => ({ month, confirmations: n })),
    },
    refinedAreas: [...refinedAreas]
      .map(([area, refinements]) => ({ area, refinements, guidance: guidance.get(area) ?? [] }))
      .sort((x, y) => y.refinements - x.refinements || x.area.localeCompare(y.area)),
    unlabelledRefinements: unlabelled,
    refinementsGiven,
  };
}

// ponytail: full scans of the ledger and the skill rows, and one Memory.get per
// distinct ledger memory. Fine while the ledger is thousands of rows; past that,
// keep per-area counts in a nightly REM step instead of computing per request.
async function load() {
  const db = (databases as any).flair;
  const rows: LedgerRow[] = [];
  for await (const r of db.MemoryOutcome.search({})) rows.push(r);
  const memories = new Map<string, any>();
  for (const id of new Set(rows.map((r) => r.memoryId))) {
    const m = await db.Memory.get(id).catch(() => null);
    if (m) memories.set(id, m);
  }
  const skills: any[] = [];
  for await (const s of db.Memory.search({ conditions: [{ attribute: "tags", comparator: "equals", value: SKILL_TAG }] })) {
    if (!s.archived) skills.push(s);
  }
  return { rows, memories, skills };
}

export async function guidanceAreas() {
  const { rows, memories, skills } = await load();
  return { ...summarizeAreas(rows, memories, skills), computedAt: new Date().toISOString() };
}

export async function growthFor(agentId: string) {
  const { rows, memories, skills } = await load();
  const scope = await resolveReadScope(agentId);
  return summarizeGrowth(agentId, rows, memories, skills.filter((s) => scope.isAllowed(s)));
}
