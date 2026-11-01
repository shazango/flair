/**
 * guidance-views.test.ts — the pure summaries behind `flair growth` and
 * `flair guidance areas` (slice 5a of the outcome engine), their renderers, and
 * the growth-not-blame tripwires: areas are never people, the operator view
 * carries no agent id, and neither view feeds ranking or authority.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { areasOf, summarizeAreas, summarizeGrowth } from "../../resources/guidance-views";
import { formatGrowth, formatGuidanceAreas } from "../../src/commands/growth";

const memories = new Map<string, any>([
  ["m1", { id: "m1", agentId: "ann", subject: "key rotation", entities: ["subsystem:auth", "agent:ann"] }],
  ["m2", { id: "m2", agentId: "ann", entities: ["subsystem:auth"] }],
  ["m3", { id: "m3", agentId: "bob" }],
  ["r1", { id: "r1", agentId: "bob" }],
]);
const rows = [
  { agentId: "bob", memoryId: "m1", kind: "refined", refinementMemoryId: "r1", createdAt: "2026-10-02T00:00:00Z" },
  { agentId: "cat", memoryId: "m2", kind: "refined", refinementMemoryId: "r9", createdAt: "2026-10-03T00:00:00Z" },
  { agentId: "ann", memoryId: "m3", kind: "refined", refinementMemoryId: "r8", createdAt: "2026-10-04T00:00:00Z" },
  { agentId: "bob", memoryId: "m1", kind: "confirmed", createdAt: "2026-09-10T00:00:00Z" },
  { agentId: "cat", memoryId: "m1", kind: "confirmed", createdAt: "2026-10-10T00:00:00Z" },
  { agentId: "cat", memoryId: "m2", kind: "confirmed", createdAt: "2026-10-11T00:00:00Z" },
  { agentId: "ann", memoryId: "m2", kind: "confirmed", createdAt: "2026-10-12T00:00:00Z" },
  { agentId: "x", memoryId: "gone", kind: "refined", refinementMemoryId: "r7" },
];
const skills = [{ id: "s1", subject: "subsystem:auth", tags: ["skill"] }];

describe("areasOf", () => {
  it("uses subject and entities, never people", () => {
    expect(areasOf(memories.get("m1"))).toEqual(["key rotation", "subsystem:auth"]);
    expect(areasOf({ subject: "person:dana", entities: ["Agent:x", " "] })).toEqual([]);
    expect(areasOf(null)).toEqual([]);
  });
});

describe("summarizeAreas", () => {
  const out = summarizeAreas(rows, memories, skills);

  it("counts refinements per area, most refined first, with guidance", () => {
    expect(out.areas).toEqual([
      { area: "subsystem:auth", refinements: 2, memoriesRefined: 2, guidance: 1 },
      { area: "key rotation", refinements: 1, memoriesRefined: 1, guidance: 0 },
    ]);
    expect(out.unlabelled).toBe(1); // m3; the row on a missing memory is skipped
  });

  it("never names an agent", () => {
    const text = JSON.stringify(out);
    for (const id of ["ann", "bob", "cat"]) expect(text).not.toContain(id);
  });
});

describe("summarizeGrowth", () => {
  const g = summarizeGrowth("ann", rows, memories, skills);

  it("counts others' confirmations of the agent's memories, by month, never its own", () => {
    expect(g.steady).toEqual({
      confirmations: 3,
      memoriesConfirmed: 2,
      byMonth: [{ month: "2026-09", confirmations: 1 }, { month: "2026-10", confirmations: 2 }],
    });
  });

  it("lists the areas its memories were refined in, with readable guidance", () => {
    expect(g.refinedAreas).toEqual([
      { area: "subsystem:auth", refinements: 2, guidance: ["s1"] },
      { area: "key rotation", refinements: 1, guidance: [] },
    ]);
    expect(g.unlabelledRefinements).toBe(0);
    expect(g.refinementsGiven).toBe(1);
  });

  it("never names who confirmed or refined", () => {
    const text = JSON.stringify(g);
    expect(text).not.toContain("bob");
    expect(text).not.toContain("cat");
  });
});

describe("renderers", () => {
  it("formatGrowth reads as growth", () => {
    const text = formatGrowth(summarizeGrowth("ann", rows, memories, skills));
    expect(text).toContain("others confirmed 2 of your memories (3× in all)");
    expect(text).toContain("subsystem:auth  2× · guidance: s1");
    expect(text).toContain("key rotation  1× · no guidance yet");
    expect(text).toContain("You have refined 1 memory by others.");
    expect(formatGrowth({ agentId: "new", steady: { confirmations: 0 }, refinedAreas: [] })).toContain("No refinements to your memories yet.");
  });

  it("formatGuidanceAreas shows where guidance is needed", () => {
    const text = formatGuidanceAreas(summarizeAreas(rows, memories, skills));
    expect(text).toContain("subsystem:auth  2× over 2 memories · 1 skill");
    expect(text).toContain("key rotation  1× over 1 memory · needs guidance");
    expect(text).toContain("(no subject or entities)  1×");
    expect(formatGuidanceAreas({ areas: [], unlabelled: 0 })).toBe("No refinements yet, so no areas need guidance.");
  });
});

describe("growth, not blame (source tripwires)", () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, "..", "..", f), "utf8");

  it("the views never feed scoring, read scope or authority", () => {
    for (const f of ["resources/scoring.ts", "resources/memory-read-scope.ts", "resources/agent-auth.ts", "resources/trust-block.ts", "resources/semantic-retrieval-core.ts", "resources/SemanticSearch.ts"]) {
      expect(src(f), f).not.toMatch(/guidance-views/);
    }
  });

  it("the views write nothing", () => {
    for (const f of ["resources/guidance-views.ts", "resources/Growth.ts", "resources/GuidanceAreas.ts"]) {
      expect(src(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), f).not.toMatch(/\.(put|patch|delete|update|insert)\(/);
    }
  });

  it("the operator view is admin-only, the growth view is self or operator", () => {
    expect(src("resources/GuidanceAreas.ts")).toContain("allowAdmin(");
    expect(src("resources/GuidanceAreas.ts")).not.toContain("allowVerified(");
    expect(src("resources/Growth.ts")).toMatch(/requested !== auth\.agentId && !auth\.isAdmin/);
  });
});
